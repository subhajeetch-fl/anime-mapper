/**
 * Incremental update job, meant to run on a schedule via GitHub Actions
 * (.github/workflows/update-airing.yml).
 *
 * Rate-limit strategy implemented here:
 *   1. Retry queue first - anime that failed in a previous run are always
 *      retried before anything else ("even if error happens, it should
 *      still do it later in time").
 *   2. Only "Currently Airing" anime (read from data/anime-index.json) are
 *      re-fetched on the regular schedule - finished/not-yet-aired titles
 *      don't change often enough to justify hitting 4-5 APIs for all
 *      10,000+ of them every run.
 *   3. A freshness check (data/.pipeline-state/last-updated.json) skips
 *      anything updated within FRESHNESS_HOURS, in case the job is
 *      triggered manually in between scheduled runs.
 *
 * Bulk catalog growth (onboarding new MAL ids) is a SEPARATE concern -
 * see add-anime.js / add-new-anime.yml - so this script's job stays cheap
 * and fast on every scheduled run.
 *
 * CLI usage: node scripts/update-airing.js [--force] [--limit=200]
 */
import { fetchAnime } from './fetch-anime.js';
import { buildIndexes } from './build-indexes.js';
import { reportErrorsToDiscord } from './lib/discord.js';
import {
  loadLastUpdated,
  saveLastUpdated,
  markUpdated,
  isFresh,
  loadRetryQueue,
  saveRetryQueue,
  updateRetryQueue,
} from './lib/state.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const FRESHNESS_HOURS = 4; // don't re-fetch an airing title more than once per 4h
const DEFAULT_LIMIT = 500; // safety cap per run regardless of how many are airing

async function loadAiringIds() {
  try {
    const raw = await readFile(path.resolve('data/anime-index.json'), 'utf-8');
    const index = JSON.parse(raw);
    return index.filter((a) => a.status === 'Currently Airing').map((a) => a.id);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function run() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : DEFAULT_LIMIT;

  const lastUpdated = await loadLastUpdated();
  const retryQueue = await loadRetryQueue();
  const airingIds = await loadAiringIds();

  // Retry-queue ids first, then airing ids, de-duplicated, capped at `limit`.
  const retryIds = retryQueue.map((item) => item.id);
  const candidateIds = [...new Set([...retryIds, ...airingIds])];
  const dueIds = force
    ? candidateIds
    : candidateIds.filter((id) => !isFresh(lastUpdated, id, FRESHNESS_HOURS));
  const idsToProcess = dueIds.slice(0, limit);

  console.log(
    `update-airing: ${airingIds.length} airing, ${retryIds.length} queued for retry, ` +
      `${idsToProcess.length} due this run (limit ${limit}, force=${force})`
  );

  const allErrors = [];
  const succeededIds = [];

  for (const id of idsToProcess) {
    const result = await fetchAnime(id);
    if (result.ok) {
      succeededIds.push(id);
      await markUpdated(lastUpdated, id);
    }
    allErrors.push(...result.errors);
  }

  await saveLastUpdated(lastUpdated);

  const failedIds = idsToProcess.filter((id) => !succeededIds.includes(id));
  const newQueue = updateRetryQueue(retryQueue, {
    failed: allErrors.filter((e) => failedIds.includes(e.id)),
    succeededIds,
  });
  await saveRetryQueue(newQueue);

  if (idsToProcess.length > 0) {
    await buildIndexes();
  }

  if (allErrors.length > 0) {
    await reportErrorsToDiscord(allErrors, {
      runLabel: 'update-airing',
      totalProcessed: idsToProcess.length,
    });
  }

  console.log(
    `update-airing done: ${succeededIds.length} succeeded, ${failedIds.length} failed ` +
      `(${newQueue.length} now in retry queue).`
  );
}

await run();
