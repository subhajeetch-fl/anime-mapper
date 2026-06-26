/**
 * Kitsu API client (JSON:API format).
 * Docs: https://kitsu.docs.apiary.io/
 *
 * Kitsu doesn't accept a MAL id directly, so we resolve it through the
 * `mappings` endpoint first, then fetch the full anime resource.
 * Used as a FALLBACK/enrichment source when Jikan is missing fields
 * (e.g. ageRating, an alternate synopsis, or Jikan is down).
 */
import { fetchJson } from './httpClient.js';

const BASE_URL = 'https://kitsu.io/api/edge';

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
async function resolveKitsuIdFromMalId(malId) {
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
 * @param {number|string} malId
 * @returns {Promise<object|null>} raw Kitsu anime resource (data.attributes), or null
 */
export async function getAnimeByMalId(malId) {
  const kitsuId = await resolveKitsuIdFromMalId(malId);
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
    // Kitsu uses a 0-100 scale; we normalize to a 0-10 scale to align with MAL/AniList.
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
