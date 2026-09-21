/**
 * animeApi database client (nattadasu/animeApi v3).
 * Source: https://raw.githubusercontent.com/nattadasu/animeApi/v3/database/animeapi.json
 *
 * Given a MyAnimeList id, returns the same title's ids on other platforms
 * (AniList, AniDB, Kitsu, Simkl, TVDB, Trakt, etc.).
 * This is what powers the `mappings` block in every anime/[id].json file,
 * and supplies the AniList id we need to query AniZip for episodes.
 *
 * Confirmed response shape (per project README, all keys always present,
 * value is null if that provider doesn't have the title):
 * {
 *   "title": "Cowboy Bebop",
 *   "anidb": 23, "anilist": 1, "animeplanet": "cowboy-bebop",
 *   "anisearch": 1572, "annict": 360, "kaize": "cowboy-bebop", "kitsu": 1,
 *   "livechart": 3418, "myanimelist": 1, "notify": "Tk3ccKimg",
 *   "otakotaku": 1149, "shikimori": 1, "shoboi": 538, "silveryasha": 2652,
 *   "trakt": 30857, "trakt_type": "shows", "trakt_season": 1
 * }
 *
 * NOTE: Treat every field as OPTIONAL/nullable. The database schema can
 * gain providers over time, so don't fail the whole anime if one is missing.
 */
import { fetchJson } from './httpClient.js';
import { readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DATABASE_URL =
  'https://raw.githubusercontent.com/nattadasu/animeApi/v3/database/animeapi.json';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_PATH = process.env.ANIMEAPI_CACHE_PATH ??
  path.join(os.tmpdir(), 'anime-mapper-animeapi-v3.json');

// The source is one large JSON database, so download and index it once per
// process instead of downloading the entire file for every anime id. A short
// disk cache also lets separate pipeline processes reuse the same download.
let databasePromise = null;

async function readCachedDatabase() {
  try {
    const cached = JSON.parse(await readFile(CACHE_PATH, 'utf8'));
    if (
      cached &&
      Number.isFinite(cached.cachedAt) &&
      Date.now() - cached.cachedAt < CACHE_TTL_MS &&
      Array.isArray(cached.database)
    ) {
      return cached.database;
    }
  } catch {
    // Missing, expired, or invalid cache: fetch a fresh copy below.
  }
  return null;
}

async function writeCachedDatabase(database) {
  const temporaryPath = `${CACHE_PATH}.${process.pid}.tmp`;
  await writeFile(
    temporaryPath,
    JSON.stringify({ cachedAt: Date.now(), database }),
    'utf8'
  );
  await rename(temporaryPath, CACHE_PATH);
}

async function loadDatabaseIndex() {
  if (!databasePromise) {
    databasePromise = (async () => {
      const cachedDatabase = await readCachedDatabase();
      if (cachedDatabase) {
        console.log(`[animeApi database] using cached database (${CACHE_PATH})`);
        return cachedDatabase;
      }

      const database = await fetchJson(DATABASE_URL, {
        label: 'animeApi database',
        retries: 3,
        baseDelayMs: 1500,
        timeoutMs: 120000,
      });
      if (!Array.isArray(database)) {
        throw new Error('animeApi database returned an invalid JSON array');
      }
      try {
        await writeCachedDatabase(database);
        console.log(`[animeApi database] downloaded and cached (${CACHE_PATH})`);
      } catch (err) {
        console.warn(`[animeApi database] cache write skipped: ${err.message}`);
      }
      return database;
    })().then((database) => {

      const index = new Map();
      for (const record of database) {
        const malId = Number(record?.myanimelist);
        if (Number.isInteger(malId) && malId > 0 && !index.has(malId)) {
          index.set(malId, record);
        }
      }
      return index;
    });
  }

  return databasePromise;
}

/**
 * @param {number|string} malId
 * @returns {Promise<object|null>} raw mapping object, or null if untracked
 */
export async function getMappingsByMalId(malId) {
  const id = Number(malId);
  if (!Number.isInteger(id) || id <= 0) return null;

  const index = await loadDatabaseIndex();
  return index.get(id) ?? null;
}

/** Normalizes the raw mapping payload into the `mappings` block we store. */
export function normalizeMappings(raw, malId) {
  const base = {
    mal: Number(malId),
    anilist: null,
    anidb: null,
    kitsu: null,
    simkl: null,
    tmdb: null,
    tvdb: null,
    trakt: null,
    traktType: null,
    shikimori: null,
    livechart: null,
    animeplanet: null,
    anisearch: null,
    notify: null,
  };

  if (!raw) return base; // The database has no record - still return the shape.

  return {
    ...base,
    anilist: raw.anilist ?? null,
    anidb: raw.anidb ?? null,
    kitsu: raw.kitsu ?? null,
    simkl: raw.simkl ?? null,
    tmdb: raw.themoviedb ?? raw.tmdb ?? null,
    tvdb: raw.thetvdb ?? raw.tvdb ?? null,
    trakt: raw.trakt ?? null,
    traktType: raw.trakt_type ?? raw.traktType ?? null,
    shikimori: raw.shikimori ?? null,
    livechart: raw.livechart ?? null,
    animeplanet: raw.animeplanet ?? null,
    anisearch: raw.anisearch ?? null,
    notify: raw.notify ?? null,
  };
}
