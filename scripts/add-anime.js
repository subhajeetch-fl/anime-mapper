/**
 * Onboards NEW anime into the catalog (Phase 1: one id, Phase 2: ~100 ids,
 * Phase 3: thousands). This is intentionally separate from update-airing.js
 * - growing the catalog is a deliberate, occasional action (manual trigger
 * or weekly), not something that should run on the same tight schedule as
 * airing updates.
 *
 * CLI usage:
 *   node scripts/add-anime.js 21                  single id
 *   node scripts/add-anime.js 21 1 813 16498       explicit list
 *   node scripts/add-anime.js --range=1-100        inclusive range
 *   node scripts/add-anime.js --file=ids.txt       newline-separated ids
 *
 * Always rebuilds all indexes at the end and reports errors to Discord,
 * same as update-airing.js.
 */
import { readFile } from 'node:fs/promises';
import { fetchAnime } from './fetch-anime.js';
import { buildIndexes } from './build-indexes.js';
import { reportErrorsToDiscord } from './lib/discord.js';
import { loadRetryQueue, saveRetryQueue, updateRetryQueue } from './lib/state.js';

function parseRange(rangeArg) {
  const [start, end] = rangeArg.split('-').map(Number);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new Error(`Invalid --range value: ${rangeArg} (expected e.g. 1-100)`);
  }
  const ids = [];
  for (let i = start; i <= end; i++) ids.push(i);
  return ids;
}

async function parseFile(filePath) {
  const raw = await readFile(filePath, 'utf-8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(Number);
}

async function resolveIds(args) {
  const rangeArg = args.find((a) => a.startsWith('--range='));
  const fileArg = args.find((a) => a.startsWith('--file='));
  const explicitIds = args.filter((a) => !a.startsWith('--')).map(Number);

  let ids = [...explicitIds];
  if (rangeArg) ids.push(...parseRange(rangeArg.split('=')[1]));
  if (fileArg) ids.push(...(await parseFile(fileArg.split('=')[1])));

  return [...new Set(ids)].filter((id) => Number.isFinite(id) && id > 0);
}

async function run() {
  const args = process.argv.slice(2);
  const ids = await resolveIds(args);

  if (ids.length === 0) {
    console.error(
      'Usage: node scripts/add-anime.js <id...> | --range=1-100 | --file=ids.txt'
    );
    process.exit(1);
  }

  console.log(`add-anime: onboarding ${ids.length} id(s)...`);

  const allErrors = [];
  const succeededIds = [];

  for (const id of ids) {
    const result = await fetchAnime(id);
    if (result.ok) {
      succeededIds.push(id);
      console.log(`  [ok] #${id} ${result.record.title?.english ?? result.record.title?.romaji ?? ''}`);
    } else {
      console.error(`  [FAIL] #${id}: ${result.errors.map((e) => e.message).join(' | ')}`);
    }
    allErrors.push(...result.errors);
  }

    const permanentFailureIds = new Set(
      allErrors
        .filter((e) => {
          const source = String(e.source || '').toLowerCase();
          const msg = String(e.message || '').toLowerCase();
          return (
            !succeededIds.includes(e.id) &&
            (source === 'primary' || source === 'jikan' || source === 'kitsu') &&
            (e.status === 404 || msg.includes('not found') || msg.includes('no jikan or kitsu'))
          );
        })
        .map((e) => String(e.id))
    );

    const retryableErrors = allErrors.filter((e) => !permanentFailureIds.has(String(e.id)));

    const retryQueue = await loadRetryQueue();

    const newQueue = updateRetryQueue(retryQueue, {
      failed: retryableErrors,
      succeededIds,
    });

    await saveRetryQueue(newQueue);

  await buildIndexes();

  if (allErrors.length > 0) {
    await reportErrorsToDiscord(allErrors, { runLabel: 'add-anime', totalProcessed: ids.length });
  }

  console.log(`add-anime done: ${succeededIds.length}/${ids.length} succeeded.`);
}


  await run();
