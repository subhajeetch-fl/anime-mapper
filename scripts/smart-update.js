/**
 * Smart update job.
 *
 * - Retry queued failures first.
 * - Periodically re-fetch non-completed anime.
 * - Never rewrites an anime JSON file if meaningful data did not change.
 * - Skips completed anime unless they are in the retry queue.
 */
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { fetchAnime } from './fetch-anime.js';
import { buildIndexes } from './build-indexes.js';
import { reportErrorsToDiscord, sendSmartUpdateSummary } from './lib/discord.js';
import {
  loadLastUpdated,
  saveLastUpdated,
  markUpdated,
  loadRetryQueue,
  saveRetryQueue,
  updateRetryQueue,
  loadUpdateCursor,
  saveUpdateCursor,
  pickRoundRobinBatch,
  loadDiscoveredIds,
} from './lib/state.js';

const ANIME_DIR = path.resolve('data/anime');
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;
const DEFAULT_MAX_RUNTIME_MINUTES = 170;
const DEADLINE_GRACE_MS = 2 * 60 * 1000;

function parseArgs(args) {
  const force = args.includes('--force');
  const limitArg = args.find((arg) => arg.startsWith('--limit='));
  const runtimeArg = args.find((arg) => arg.startsWith('--max-runtime-minutes='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : DEFAULT_LIMIT;
  const maxRuntimeMinutes = runtimeArg
    ? Number(runtimeArg.split('=')[1])
    : DEFAULT_MAX_RUNTIME_MINUTES;

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`--limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  if (!Number.isFinite(maxRuntimeMinutes) || maxRuntimeMinutes <= 1) {
    throw new Error('--max-runtime-minutes must be greater than 1');
  }

  return { force, limit, maxRuntimeMs: maxRuntimeMinutes * 60 * 1000 };
}

async function loadCatalogRecords() {
  // Recursively collect JSON files from bucket subfolders.
  async function collectFiles(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        result.push(...await collectFiles(full));
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        result.push(full);
      }
    }
    return result;
  }

  let files = [];
  try {
    files = await collectFiles(ANIME_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const records = [];
  for (const filePath of files) {
    try {
      const record = JSON.parse(await readFile(filePath, 'utf-8'));
      const id = Number(record.id ?? record.idMal ?? path.basename(filePath).replace(/\.json$/, ''));
      if (Number.isInteger(id) && id > 0) {
        records.push({ id, record, filePath });
      }
    } catch (err) {
      console.error(`[smart-update] skipping unreadable anime file ${filePath}: ${err.message}`);
    }
  }

  return records.sort((a, b) => a.id - b.id);
}

function isCompleted(record) {
  const status = String(record.status ?? '').toLowerCase().replace(/[_-]/g, ' ').trim();
  return (
    status === 'finished airing' ||
    status === 'finished' ||
    status === 'complete' ||
    status === 'completed' ||
    status === 'ended'
  );
}

function isNearDeadline(startedAt, maxRuntimeMs) {
  return Date.now() - startedAt > maxRuntimeMs - DEADLINE_GRACE_MS;
}

function uniqueIds(ids) {
  return [...new Set(ids.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

function nextRoundRobinIndex(item, totalIds) {
  if (!item || totalIds === 0) return null;
  return (item.index + 1) % totalIds;
}

export async function runSmartUpdate(cliArgs = process.argv.slice(2)) {
  const { force, limit, maxRuntimeMs } = parseArgs(cliArgs);
  const startedAt = Date.now();

  const [lastUpdated, retryQueue, updateCursor, catalogRecords] = await Promise.all([
    loadLastUpdated(),
    loadRetryQueue(),
    loadUpdateCursor(),
    loadCatalogRecords(),
  ]);

  const retryIds = uniqueIds(retryQueue.map((entry) => entry.id));
  const activeIds = catalogRecords
    .filter(({ record }) => force || !isCompleted(record))
    .map(({ id }) => id);
  const normalSlots = Math.max(0, limit - retryIds.length);
  const { items: normalItems, nextIndex: plannedNextIndex } = pickRoundRobinBatch(
    activeIds,
    updateCursor,
    normalSlots,
    retryIds
  );
  const normalIds = normalItems.map((item) => item.id);
  const idsToProcess = uniqueIds([...retryIds, ...normalIds]).slice(0, limit);

  console.log(
    `smart-update: catalog=${catalogRecords.length} active=${activeIds.length} ` +
      `retry=${retryIds.length} selected=${idsToProcess.length} limit=${limit} force=${force}`
  );

  if (idsToProcess.length === 0) {
    await saveUpdateCursor({
      ...updateCursor,
      nextIndex: activeIds.length ? plannedNextIndex : 0,
      lastRunAt: new Date().toISOString(),
    });
    const emptyDiscovered = await loadDiscoveredIds();
    await sendSmartUpdateSummary({
      totalIndexed:    catalogRecords.length,
      totalDiscovered: emptyDiscovered.ids.length,
      processed:       0,
      changed:         0,
      unchanged:       0,
      deferred:        0,
      hardFailed:      0,
      retryQueueSize:  retryIds.length,
      durationMs:      Date.now() - startedAt,
    });
    console.log('smart-update: nothing to update.');
    return;
  }

  // Advance cursor by at least 1 position when retry IDs fill the entire limit,
  // so the round-robin cursor does not stall on subsequent runs.
  const cursorNeedsAdvance =
    normalSlots === 0 && retryIds.length >= limit && activeIds.length > 0;

  const normalItemById = new Map(normalItems.map((item) => [String(item.id), item]));
  const processedNormalItems = [];
  const allErrors = [];
  const succeededIds = [];
  const changedIds = [];
  const unchangedIds = [];
  const deferredIds = [];
  const processedIds = [];

  for (let i = 0; i < idsToProcess.length; i += 1) {
    if (isNearDeadline(startedAt, maxRuntimeMs)) {
      console.warn('smart-update: stopping early to leave time for state commit.');
      break;
    }

    const id = idsToProcess[i];
    const normalItem = normalItemById.get(String(id));
    processedIds.push(id);

    let result;
    try {
      result = await fetchAnime(id, {
        skipUnchanged: true,
        skipWriteOnSoftError: true,
      });
    } catch (err) {
      result = {
        ok: false,
        malId: id,
        errors: [{ id, source: 'smart-update', message: err.message, status: null }],
      };
    }

    allErrors.push(...result.errors);
    if (normalItem) processedNormalItems.push(normalItem);

    if (result.ok) {
      succeededIds.push(id);
      markUpdated(lastUpdated, id);

      if (result.skippedReason === 'soft-errors') {
        deferredIds.push(id);
      } else if (result.changed) {
        changedIds.push(id);
      } else {
        unchangedIds.push(id);
      }
    } else {
      const reason = result.errors.map((error) => `${error.source}: ${error.message}`).join(' | ');
      console.error(`  [fail] #${id}: ${reason || 'unknown error'}`);
    }

    if ((i + 1) % 100 === 0 || i + 1 === idsToProcess.length) {
      console.log(
        `  progress: ${i + 1}/${idsToProcess.length} ` +
          `changed=${changedIds.length} unchanged=${unchangedIds.length} deferred=${deferredIds.length}`
      );
    }
  }

  await saveLastUpdated(lastUpdated);

  const lastNormalItem = processedNormalItems.at(-1);
  const completedNormalBatch = processedNormalItems.length === normalItems.length;
  const nextIndex =
    cursorNeedsAdvance
      ? nextRoundRobinIndex({ index: updateCursor.nextIndex }, activeIds.length) ?? updateCursor.nextIndex
      : completedNormalBatch
        ? plannedNextIndex
        : nextRoundRobinIndex(lastNormalItem, activeIds.length) ?? updateCursor.nextIndex;

  await saveUpdateCursor({
    nextIndex,
    lastRunAt: new Date().toISOString(),
  });

  const updatedRetryQueue = updateRetryQueue(retryQueue, {
    failed: allErrors,
    succeededIds,
  });
  await saveRetryQueue(updatedRetryQueue);

  if (changedIds.length > 0) {
    const stats = await buildIndexes();
    console.log(`smart-update: rebuilt indexes for ${stats.total} anime.`);
  }

  if (allErrors.length > 0) {
    await reportErrorsToDiscord(allErrors, {
      runLabel: 'smart-update',
      totalProcessed: processedIds.length,
    });
  }

  // --- Send summary embed (always, even on success) ------------------------
  const discoveredState = await loadDiscoveredIds();

  await sendSmartUpdateSummary({
    totalIndexed: catalogRecords.length,
    totalDiscovered: discoveredState.ids.length,
    processed: processedIds.length,
    changed: changedIds.length,
    unchanged: unchangedIds.length,
    deferred: deferredIds.length,
    hardFailed: processedIds.length - succeededIds.length,
    retryQueueSize: updatedRetryQueue.length,
    durationMs: Date.now() - startedAt,
  });

  console.log(
    `smart-update done: processed=${processedIds.length}/${idsToProcess.length} ` +
      `changed=${changedIds.length} unchanged=${unchangedIds.length} ` +
      `deferred=${deferredIds.length} hardFailed=${processedIds.length - succeededIds.length} ` +
      `retryQueue=${updatedRetryQueue.length}`
  );
}

const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  try {
    await runSmartUpdate();
  } catch (err) {
    console.error(`smart-update: ${err.message}`);
    process.exit(1);
  }
}
