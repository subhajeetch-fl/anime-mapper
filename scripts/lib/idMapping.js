/**
 * animeapi.my.id client (nattadasu/animeApi v3).
 * Docs: https://github.com/nattadasu/animeApi
 *
 * Given a MyAnimeList id, returns the same title's id on ~19 other
 * platforms (AniList, AniDB, Kitsu, Simkl, TVDB, Trakt, etc.) in one call.
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
 * NOTE: themoviedb/thetvdb/simkl fields have been added to the live
 * dataset over time (animeapi.my.id's indexed-platform count includes
 * both). Treat any field as OPTIONAL/nullable - don't assume every key
 * exists on every response, and don't fail the whole anime if one is
 * missing.
 */
import { fetchJson } from './httpClient.js';

const BASE_URL = 'https://animeapi.my.id';

/**
 * @param {number|string} malId
 * @returns {Promise<object|null>} raw mapping object, or null if untracked
 */
export async function getMappingsByMalId(malId) {
  return fetchJson(`${BASE_URL}/myanimelist/${malId}`, {
    label: 'animeapi.my.id',
    retries: 3,
    baseDelayMs: 1500,
  });
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

  if (!raw) return base; // animeapi.my.id has no record - still return the shape, all null

  return {
    mal: Number(malId),
    anilist: raw.anilist ?? null,
    kitsu: raw.kitsu ?? null,
    simkl: raw.simkl ?? null,
    tmdb: raw.themoviedb ?? raw.tmdb ?? null,
    tvdb: raw.thetvdb ?? raw.tvdb ?? null,
    animeplanet: raw.animeplanet ?? null,
  };
}
