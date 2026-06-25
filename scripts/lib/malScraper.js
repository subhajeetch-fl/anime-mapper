/**
 * MAL id discovery through Jikan's paginated /anime listing.
 *
 * This intentionally does not scan 1..N ids. Jikan returns valid anime ids
 * in pages, which avoids thousands of wasted requests against deleted or
 * never-created MAL ids.
 */
import { fetchJson, sleep } from './httpClient.js';

const BASE_URL = 'https://api.jikan.moe/v4';
const PAGE_INTERVAL_MS = 500;
const PAGE_SIZE = 25;

async function fetchAnimePage(page) {
  const url =
    `${BASE_URL}/anime?page=${page}` +
    `&limit=${PAGE_SIZE}` +
    '&order_by=mal_id' +
    '&sort=asc';

  const json = await fetchJson(url, {
    label: `Jikan discover page ${page}`,
    retries: 4,
    baseDelayMs: 2000,
    timeoutMs: 20000,
  });

  if (!json || !Array.isArray(json.data)) {
    return {
      ids: [],
      hasNextPage: false,
      lastPage: page,
    };
  }

  const ids = json.data
    .map((item) => Number(item.mal_id))
    .filter((id) => Number.isInteger(id) && id > 0);

  const pagination = json.pagination ?? {};

  return {
    ids,
    hasNextPage: Boolean(pagination.has_next_page),
    lastPage:
      Number.isInteger(pagination.last_visible_page) && pagination.last_visible_page > 0
        ? pagination.last_visible_page
        : page,
  };
}

export async function discoverAllMalIds({
  startPage = 1,
  maxPages = Infinity,
  onPage = null,
  intervalMs = PAGE_INTERVAL_MS,
} = {}) {
  const firstPage = Math.max(1, Math.floor(Number(startPage) || 1));
  const pageLimit = Number.isFinite(maxPages)
    ? Math.max(0, Math.floor(Number(maxPages)))
    : Infinity;

  const allIds = [];
  let page = firstPage;
  let pagesScanned = 0;
  let lastVisiblePage = firstPage;
  let lastSuccessfulPage = firstPage - 1;
  let failedPage = null;

  while (pagesScanned < pageLimit) {
    if (pagesScanned > 0) await sleep(intervalMs);

    let result;
    try {
      result = await fetchAnimePage(page);
    } catch (err) {
      failedPage = page;
      console.warn(`[malScraper] page ${page} failed after retries: ${err.message}`);
      break;
    }

    allIds.push(...result.ids);
    lastVisiblePage = result.lastPage;
    lastSuccessfulPage = page;
    pagesScanned += 1;

    if (onPage) {
      try {
        onPage({
          page,
          ids: result.ids,
          total: allIds.length,
          lastVisiblePage,
        });
      } catch {
        // Progress callbacks must not interrupt discovery.
      }
    }

    if (!result.hasNextPage) break;
    page += 1;
  }

  return {
    ids: allIds,
    pagesScanned,
    lastPage: lastVisiblePage,
    lastSuccessfulPage,
    failedPage,
  };
}

export async function discoverNewMalIds(startPage, options = {}) {
  return discoverAllMalIds({ ...options, startPage });
}
