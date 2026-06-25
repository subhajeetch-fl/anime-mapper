/**
 * Discover valid MAL anime ids and save them to repo state.
 *
 * The script uses Jikan's paginated anime listing instead of brute-forcing
 * numeric ids. The first run scans from page 1; later runs resume near the
 * last successfully scanned page with a small overlap.
 */
import {
  loadDiscoveredIds,
  mergeDiscoveredIds,
  saveDiscoveredIds,
} from './lib/state.js';
import { discoverAllMalIds, discoverNewMalIds } from './lib/malScraper.js';

const PAGE_OVERLAP = 5;

function parseArgs(args) {
  const full = args.includes('--full');
  const maxPagesArg = args.find((arg) => arg.startsWith('--max-pages='));
  const maxPages = maxPagesArg ? Number(maxPagesArg.split('=')[1]) : Infinity;

  if (!Number.isFinite(maxPages) && maxPages !== Infinity) {
    throw new Error(`Invalid --max-pages value: ${maxPagesArg}`);
  }
  if (Number.isFinite(maxPages) && (!Number.isInteger(maxPages) || maxPages < 1)) {
    throw new Error(`Invalid --max-pages value: ${maxPagesArg}`);
  }

  return { full, maxPages };
}

function getIncrementalStartPage(state) {
  if (!state.ids.length || !state.lastPageScanned) return 1;
  return Math.max(1, state.lastPageScanned - PAGE_OVERLAP);
}

function printProgress({ page, total, lastVisiblePage }) {
  process.stdout.write(
    `\r  page ${page}/${lastVisiblePage || '?'} - ${total} ids found in this pass`
  );
}

export async function runDiscoverIds(cliArgs = process.argv.slice(2)) {
  const { full, maxPages } = parseArgs(cliArgs);
  const state = await loadDiscoveredIds();
  const previousCount = state.ids.length;

  console.log(
    `discover-ids: starting mode=${full || previousCount === 0 ? 'full' : 'incremental'} ` +
      `known=${previousCount} lastPage=${state.lastPageScanned || 0}`
  );

  const result =
    full || previousCount === 0
      ? await discoverAllMalIds({
          startPage: 1,
          maxPages,
          onPage: printProgress,
        })
      : await discoverNewMalIds(getIncrementalStartPage(state), {
          maxPages,
          onPage: printProgress,
        });

  process.stdout.write('\n');

  if (result.failedPage && previousCount === 0 && result.ids.length === 0) {
    throw new Error(`Discovery failed on page ${result.failedPage}; no ids were saved.`);
  }

  const lastPageScanned =
    result.lastSuccessfulPage > 0 ? result.lastSuccessfulPage : state.lastPageScanned;
  const nextState = mergeDiscoveredIds(state, result.ids, { lastPageScanned });
  const newlyAdded = nextState.ids.length - previousCount;

  await saveDiscoveredIds(nextState);

  console.log(
    `discover-ids: scanned=${result.pagesScanned} ` +
      `newInPass=${result.ids.length} added=${newlyAdded} total=${nextState.ids.length}`
  );

  if (result.failedPage) {
    console.warn(
      `discover-ids: stopped at failed page ${result.failedPage}; next run will resume with overlap.`
    );
  }

  console.log(
    JSON.stringify({
      previousCount,
      idsSeenThisRun: result.ids.length,
      newlyAdded,
      totalKnown: nextState.ids.length,
      pagesScanned: result.pagesScanned,
      lastPageScanned: nextState.lastPageScanned,
      failedPage: result.failedPage,
    })
  );
}

try {
  await runDiscoverIds();
} catch (err) {
  console.error(`discover-ids: ${err.message}`);
  process.exit(1);
}
