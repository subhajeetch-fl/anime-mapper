/**
 * MAL ID discovery using offline database snapshots and live Official MAL API feeds.
 *
 * Replaces fragile 1,200+ paginated Jikan scraper calls with:
 * 1. Fast download of anime-offline-database (30,000+ titles)
 * 2. Merging known IDs from animeApi database (nattadasu/animeApi)
 * 3. Subtracting verified dead/deleted MAL IDs
 * 4. Supplementing with live seasonal and upcoming rankings from Official MAL API v2
 */
import { fetchJson } from './httpClient.js';
import { getSeasonalAnimeIds, getRankingAnimeIds } from './malOfficial.js';
import { malLimiter } from './rateLimiter.js';

const OFFLINE_DB_URL =
  'https://github.com/cedya77/anime-offline-database/releases/download/latest/anime-offline-database-minified.json';
const DEAD_MAL_IDS_URL =
  'https://github.com/cedya77/anime-offline-database/releases/download/latest/dead-entries/myanimelist-minified.json';
const ANIMEAPI_DB_URL =
  'https://raw.githubusercontent.com/nattadasu/animeApi/v3/database/animeapi.json';

const MAL_URL_RE = /^https:\/\/myanimelist\.net\/anime\/(\d+)/;

function getCurrentAndNextSeasons() {
  const seasons = ['winter', 'spring', 'summer', 'fall'];
  const now = new Date();
  const idx = Math.floor(now.getMonth() / 3);
  const year = now.getFullYear();
  const nextIdx = (idx + 1) % 4;
  const nextYear = nextIdx === 0 ? year + 1 : year;
  return [
    { year, season: seasons[idx] },
    { year: nextYear, season: seasons[nextIdx] },
  ];
}

export async function discoverAllMalIds(options = {}) {
  const { onPage = null } = options;
  const idSet = new Set();

  console.log('[discover] downloading baseline datasets (offline database + mapping DB)...');

  // 1. Ingest offline database + dead-entries list + animeApi mapping DB
  const [offlineDb, deadEntries, animeApiDb] = await Promise.all([
    fetchJson(OFFLINE_DB_URL, { label: 'anime-offline-database', timeoutMs: 120000 }).catch(
      (err) => {
        console.warn(`[discover] offline-db download failed: ${err.message}`);
        return null;
      }
    ),
    fetchJson(DEAD_MAL_IDS_URL, { label: 'dead-mal-entries', timeoutMs: 30000 }).catch(() => null),
    fetchJson(ANIMEAPI_DB_URL, { label: 'animeApi-db', timeoutMs: 120000 }).catch(() => []),
  ]);

  if (offlineDb?.data && Array.isArray(offlineDb.data)) {
    for (const entry of offlineDb.data) {
      for (const url of entry.sources ?? []) {
        const match = MAL_URL_RE.exec(url);
        if (match) {
          const id = Number(match[1]);
          if (Number.isInteger(id) && id > 0) idSet.add(id);
        }
      }
    }
    console.log(`[discover] parsed ${idSet.size} MAL IDs from anime-offline-database`);
  }

  if (Array.isArray(animeApiDb)) {
    let mappingCount = 0;
    for (const record of animeApiDb) {
      const malId = Number(record?.myanimelist);
      if (Number.isInteger(malId) && malId > 0) {
        idSet.add(malId);
        mappingCount++;
      }
    }
    console.log(`[discover] merged IDs from animeApi database (total now: ${idSet.size})`);
  }

  // Remove confirmed deleted MAL IDs
  if (deadEntries?.data && Array.isArray(deadEntries.data)) {
    let deletedCount = 0;
    for (const deadId of deadEntries.data) {
      const num = Number(deadId);
      if (idSet.delete(num)) deletedCount++;
    }
    console.log(`[discover] removed ${deletedCount} deleted/dead MAL entries`);
  }

  // 2. Supplement with live Official MAL v2 seasonal + upcoming feeds (catches brand new titles)
  if (process.env.MAL_CLIENT_ID) {
    console.log('[discover] querying live seasonal and upcoming rankings from Official MAL API...');
    for (const { year, season } of getCurrentAndNextSeasons()) {
      try {
        await malLimiter();
        const { ids } = await getSeasonalAnimeIds(year, season);
        for (const id of ids) idSet.add(id);
      } catch (err) {
        console.warn(`[discover] season ${year} ${season} check failed: ${err.message}`);
      }
    }

    for (const rankingType of ['airing', 'upcoming']) {
      try {
        await malLimiter();
        const { ids } = await getRankingAnimeIds(rankingType);
        for (const id of ids) idSet.add(id);
      } catch (err) {
        console.warn(`[discover] ranking ${rankingType} check failed: ${err.message}`);
      }
    }
  } else {
    console.warn('[discover] MAL_CLIENT_ID not set; skipping live seasonal/upcoming discovery');
  }

  const sortedIds = [...idSet]
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((a, b) => a - b);

  if (onPage) {
    try {
      onPage({ page: 1, ids: sortedIds, total: sortedIds.length, lastVisiblePage: 1 });
    } catch {
      // ignore
    }
  }

  return {
    ids: sortedIds,
    pagesScanned: 1,
    lastPage: 1,
    lastSuccessfulPage: 1,
    failedPage: null,
  };
}

export async function discoverNewMalIds(startPage, options = {}) {
  return discoverAllMalIds(options);
}
