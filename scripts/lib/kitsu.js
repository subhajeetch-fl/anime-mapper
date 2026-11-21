/**
 * Kitsu API client (JSON:API format).
 * Docs: https://kitsu.docs.apiary.io/
 *
 * Kitsu is used as a fallback/enrichment source when MAL official lacks
 * fields (e.g. ageRating, synopsis, episodeLength) or when episode fallback is needed.
 */
import { fetchJson } from './httpClient.js';

const BASE_URL = 'https://kitsu.app/api/edge';

const KITSU_STATUS_MAP = {
  current: 'Currently Airing',
  finished: 'Finished Airing',
  upcoming: 'Not yet aired',
  tba: 'Not yet aired',
};

/**
 * @param {number|string} malId
 * @returns {Promise<string|null>} Kitsu anime id, or null if unmapped
 */
export async function resolveKitsuIdFromMalId(malId) {
  const json = await fetchJson(
    `${BASE_URL}/mappings?filter[externalSite]=myanimelist/anime&filter[externalId]=${malId}&include=item`,
    { label: 'Kitsu mappings', retries: 2, baseDelayMs: 1500 }
  );
  const included = json?.included;
  if (!included || included.length === 0) return null;
  const animeResource = included.find((r) => r.type === 'anime');
  return animeResource ? animeResource.id : null;
}

/**
 * Fetch anime resource directly using Kitsu ID (saves an extra /mappings call if kitsu ID is already known).
 * @param {number|string} kitsuId
 * @returns {Promise<object|null>} raw Kitsu anime resource with derivedGenres, or null
 */
export async function getAnimeByKitsuId(kitsuId) {
  if (!kitsuId) return null;

  const json = await fetchJson(`${BASE_URL}/anime/${kitsuId}?include=genres,categories`, {
    label: 'Kitsu anime',
    retries: 2,
    baseDelayMs: 1500,
  });
  if (!json?.data) return null;

  const genres = (json.included ?? [])
    .filter((r) => r.type === 'genres' || r.type === 'categories')
    .map((r) => r.attributes?.title || r.attributes?.name)
    .filter(Boolean);

  return { ...json.data, kitsuId, derivedGenres: [...new Set(genres)] };
}

/**
 * @param {number|string} malId
 * @returns {Promise<object|null>} raw Kitsu anime resource with derivedGenres, or null
 */
export async function getAnimeByMalId(malId) {
  const kitsuId = await resolveKitsuIdFromMalId(malId);
  if (!kitsuId) return null;
  return getAnimeByKitsuId(kitsuId);
}

/**
 * Fetch all episodes for an anime from Kitsu with pagination.
 * @param {number|string} kitsuId
 * @returns {Promise<Array>} Array of raw Kitsu episode resources
 */
export async function getAllEpisodes(kitsuId) {
  if (!kitsuId) return [];
  const episodes = [];
  let offset = 0;
  const limit = 20;

  while (true) {
    const json = await fetchJson(
      `${BASE_URL}/anime/${kitsuId}/episodes?page[limit]=${limit}&page[offset]=${offset}`,
      { label: 'Kitsu episodes', retries: 2, baseDelayMs: 1500 }
    );
    if (!json?.data || !Array.isArray(json.data) || json.data.length === 0) {
      break;
    }
    episodes.push(...json.data);
    if (!json.links?.next || json.data.length < limit) {
      break;
    }
    offset += limit;
    if (offset > 1500) break;
  }
  return episodes;
}

/**
 * Normalizes Kitsu episode resources into our project's episode schema.
 * @param {Array} rawEpisodes
 * @returns {Record<string, object>} keyed by episode number string
 */
export function normalizeKitsuEpisodes(rawEpisodes) {
  const result = {};
  if (!rawEpisodes || !Array.isArray(rawEpisodes)) return result;

  for (const ep of rawEpisodes) {
    const a = ep.attributes ?? {};
    const epNum = String(a.number ?? a.relativeNumber ?? ep.id ?? '0');
    result[epNum] = {
      episode: epNum,
      length: a.length ? `${a.length}m` : null,
      airDate: a.airdate ?? null,
      title: {
        en: a.titles?.en_us ?? a.titles?.en ?? a.canonicalTitle ?? null,
        romaji: a.titles?.en_jp ?? null,
        ja: a.titles?.ja_jp ?? null,
      },
      tvdbShowId: null,
      tvdbId: null,
      seasonNumber: a.seasonNumber ?? null,
      episodeNumber: a.number ?? null,
      absoluteEpisodeNumber: a.number ?? null,
      runtime: a.length ?? null,
      image: a.thumbnail?.original ?? null,
    };
  }

  return result;
}

/** Normalizes a raw Kitsu resource into our internal shape. */
export function normalizeKitsu(raw) {
  if (!raw) return null;
  const a = raw.attributes ?? {};

  return {
    kitsuId: raw.kitsuId ?? raw.id,
    titles: {
      canonical: a.canonicalTitle ?? null,
      english: a.titles?.en ?? a.titles?.en_us ?? null,
      romaji: a.titles?.en_jp ?? null,
      japanese: a.titles?.ja_jp ?? null,
    },
    synopsis: a.synopsis ?? null,
    episodeCount: a.episodeCount ?? null,
    episodeLength: a.episodeLength ?? null, // minutes
    averageRating: a.averageRating ? Number((a.averageRating / 10).toFixed(2)) : null,
    ageRating: a.ageRating ?? null,
    ageRatingGuide: a.ageRatingGuide ?? null,
    status: KITSU_STATUS_MAP[a.status] ?? a.status ?? null,
    startDate: a.startDate ?? null,
    endDate: a.endDate ?? null,
    posterImage: a.posterImage?.original ?? a.posterImage?.large ?? null,
    coverImage: a.coverImage?.original ?? null,
    genres: raw.derivedGenres ?? [],
  };
}
