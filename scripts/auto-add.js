/**
 * Automatically add newly discovered MAL ids in safe batches.
 *
 * Discovery fills data/.pipeline-state/discovered-ids.json. This script takes
 * the next slice, fetches each anime, writes data/anime/{id}.json, and records
 * failures for later retry. It never processes more than 2000 ids in one run.
 */
import path from 'node:path';
import { readdir } from 'node:fs/promises';

import { fetchAnime } from './fetch-anime.js';
import { buildIndexes } from './build-indexes.js';
import { reportErrorsToDiscord } from './lib/discord.js';
import {
  loadDiscoveredIds,
  loadAddCursor,
  saveAddCursor,
  pickNextAddBatch,
  loadPermanentlyFailed,
  mergePermanentlyFailed,
  savePermanentlyFailed,
  loadRetryQueue,
  saveRetryQueue,
  updateRetryQueue,
} from './lib/state.js';

const MAX_BATCH_SIZE = 2000;
const DEFAULT_BATCH_SIZE = 2000;
const DEFAULT_MAX_RUNTIME_MINUTES = 330;
const DEADLINE_GRACE_MS = 2 * 60 * 1000;
const ANIME_DIR = path.resolve('data/anime');

function parseArgs(args) {
  const dryRun = args.includes('--dry-run');
  const batchArg = args.find((arg) => arg.startsWith('--batch-size='));
  const runtimeArg = args.find((arg) => arg.startsWith('--max-runtime-minutes='));

  const batchSize = batchArg ? Number(batchArg.split('=')[1]) : DEFAULT_BATCH_SIZE;
  const maxRuntimeMinutes = runtimeArg
    ? Number(runtimeArg.split('=')[1])
    : DEFAULT_MAX_RUNTIME_MINUTES;

  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new Error(`--batch-size must be an integer from 1 to ${MAX_BATCH_SIZE}`);
  }
  if (!Number.isFinite(maxRuntimeMinutes) || maxRuntimeMinutes <= 1) {
    throw new Error('--max-runtime-minutes must be greater than 1');
  }

  return { dryRun, batchSize, maxRuntimeMs: maxRuntimeMinutes * 60 * 1000 };
}

async function loadCatalogedIdSet() {
  let files;
  try {
    files = await readdir(ANIME_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') return new Set();
    throw err;
  }

  return new Set(
    files
      .filter((file) => file.endsWith('.json'))
      .map((file) => Number(file.replace(/\.json$/, '')))
      .filter((id) => Number.isInteger(id) && id > 0)
      .map(String)
  );
}

function isPermanentPrimaryFailure(result) {
  if (result.ok) return false;

  return result.errors.some((error) => {
    const source = String(error.source ?? '').toLowerCase();
    const message = String(error.message ?? '').toLowerCase();
    return (
      (source === 'primary' || source === 'jikan' || source === 'kitsu') &&
      (error.status === 404 || message.includes('not found') || message.includes('no jikan or kitsu'))
    );
  });
}

function isNearDeadline(startedAt, maxRuntimeMs) {
  return Date.now() - startedAt > maxRuntimeMs - DEADLINE_GRACE_MS;
}

function nextIndexAfter(item) {
  return item ? item.index + 1 : null;
}

export async function runAutoAdd(cliArgs = process.argv.slice(2)) {
  const { dryRun, batchSize, maxRuntimeMs } = parseArgs(cliArgs);
  const startedAt = Date.now();

  const [discoveredState, cursor, permanentlyFailed, retryQueue, catalogedSet] =
    await Promise.all([
      loadDiscoveredIds(),
      loadAddCursor(),
      loadPermanentlyFailed(),
      loadRetryQueue(),
      loadCatalogedIdSet(),
    ]);

  if (discoveredState.ids.length === 0) {
    console.log('auto-add: no discovered ids yet. Run discover-ids first.');
    return;
  }

  const skipIds = [
    ...permanentlyFailed.map((entry) => entry.id),
    ...[...catalogedSet].map(Number),
  ];
  const { items, nextIndex: plannedNextIndex } = pickNextAddBatch(
    discoveredState,
    cursor,
    skipIds,
    batchSize
  );

  console.log(
    `auto-add: discovered=${discoveredState.ids.length} cataloged=${catalogedSet.size} ` +
      `permanent=${permanentlyFailed.length} batch=${items.length} cursor=${cursor.nextIndex}`
  );

  if (items.length === 0) {
    await saveAddCursor({
      ...cursor,
      nextIndex: plannedNextIndex,
      lastRunAt: new Date().toISOString(),
    });
    console.log('auto-add: nothing new to add.');
    return;
  }

  if (dryRun) {
    const preview = items.slice(0, 25).map((item) => item.id).join(', ');
    console.log(
      `auto-add: dry run would add ${items.length} id(s): ${preview}` +
        (items.length > 25 ? ` ... +${items.length - 25} more` : '')
    );
    return;
  }

  const allErrors = [];
  const succeededIds = [];
  const newPermanentFailures = [];
  const processedItems = [];

  for (let i = 0; i < items.length; i += 1) {
    if (isNearDeadline(startedAt, maxRuntimeMs)) {
      console.warn('auto-add: stopping early to leave time for state commit.');
      break;
    }

    const item = items[i];
    const id = item.id;

    let result;
    try {
      result = await fetchAnime(id);
    } catch (err) {
      result = {
        ok: false,
        malId: id,
        errors: [{ id, source: 'auto-add', message: err.message, status: null }],
      };
    }

    processedItems.push(item);
    allErrors.push(...result.errors);

    if (result.ok) {
      succeededIds.push(id);
      const title = result.record?.title?.english ?? result.record?.title?.romaji ?? '(no title)';
      console.log(`  [ok] #${id} ${title}${result.errors.length ? ' (with soft errors)' : ''}`);
    } else {
      const reason = result.errors.map((error) => `${error.source}: ${error.message}`).join(' | ');
      console.error(`  [fail] #${id}: ${reason || 'unknown error'}`);

      if (isPermanentPrimaryFailure(result)) {
        newPermanentFailures.push({
          id,
          reason: reason || 'No primary source record found',
        });
      }
    }

    if ((i + 1) % 100 === 0 || i + 1 === items.length) {
      console.log(`  progress: ${i + 1}/${items.length} processed, ${succeededIds.length} ok`);
    }
  }

  const lastProcessedItem = processedItems.at(-1);
  const completedPlannedBatch = processedItems.length === items.length;
  const updatedCursor = {
    nextIndex: completedPlannedBatch
      ? plannedNextIndex
      : nextIndexAfter(lastProcessedItem) ?? cursor.nextIndex,
    addedIds: [...new Set([...cursor.addedIds, ...succeededIds])].sort((a, b) => a - b),
    lastRunAt: new Date().toISOString(),
  };
  await saveAddCursor(updatedCursor);

  if (newPermanentFailures.length > 0) {
    await savePermanentlyFailed(mergePermanentlyFailed(permanentlyFailed, newPermanentFailures));
  }

  const permanentIds = new Set(newPermanentFailures.map((entry) => String(entry.id)));
  const retryableErrors = allErrors.filter((error) => !permanentIds.has(String(error.id)));
  const updatedRetryQueue = updateRetryQueue(retryQueue, {
    failed: retryableErrors,
    succeededIds,
  });
  await saveRetryQueue(updatedRetryQueue);

  if (succeededIds.length > 0) {
    const stats = await buildIndexes();
    console.log(`auto-add: rebuilt indexes for ${stats.total} anime.`);
  }

  if (allErrors.length > 0) {
    await reportErrorsToDiscord(allErrors, {
      runLabel: 'auto-add',
      totalProcessed: processedItems.length,
    });
  }

  const hardFailed = processedItems.length - succeededIds.length;
  console.log(
    `auto-add done: processed=${processedItems.length}/${items.length} ` +
      `succeeded=${succeededIds.length} hardFailed=${hardFailed} ` +
      `permanent=${newPermanentFailures.length} retryQueue=${updatedRetryQueue.length} ` +
      `cursor=${updatedCursor.nextIndex}/${discoveredState.ids.length}`
  );

  if (processedItems.length > 0 && succeededIds.length === 0 && newPermanentFailures.length === 0) {
    throw new Error('No anime were added and no permanent misses were identified.');
  }
}

try {
  await runAutoAdd();
} catch (err) {
  console.error(`auto-add: ${err.message}`);
  process.exit(1);
}
