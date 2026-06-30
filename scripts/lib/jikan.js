/**
 * Jikan v4 (unofficial MyAnimeList API) client.
 * Docs: https://docs.api.jikan.moe/
 *
 * Jikan's public rate limit is roughly 3 req/sec and 60 req/min.
 * We stay well under that by spacing calls out in the orchestrator
 * (see scripts/lib/rateLimiter.js) rather than firing concurrently.
 */
import { fetchJson } from './httpClient.js';
import { jikanLimiter } from './rateLimiter.js';

const BASE_URL = 'https://api.jikan.moe/v4';

/**
 * Full anime payload: synopsis, genres, studios, producers, score,
 * broadcast info, trailer, etc.
 * @param {number|string} malId
 * @returns {Promise<object|null>} raw Jikan `data` object, or null if 404
 */
export async function getAnimeFull(malId) {
  const json = await fetchJson(`${BASE_URL}/anime/${malId}/full`, {
    label: 'Jikan',
    retries: 3,
    baseDelayMs: 1500,
  });
  return json ? json.data : null;
}

/**
 * Lightweight episode list (page 1 only gives titles/aired dates per ep,
 * NOT used as our primary episode source - AniZip is - but useful as a
 * fallback when AniZip has no data for an anime, e.g. very old titles).
 * @param {number|string} malId
 * @param {number} page
 */
export async function getEpisodesPage(malId, page = 1) {
  const json = await fetchJson(`${BASE_URL}/anime/${malId}/episodes?page=${page}`, {
    label: 'Jikan episodes',
    retries: 2,
    baseDelayMs: 1500,
  });
  return json; // { data: [...], pagination: {...} } or null if 404
}

/**
 * Fetch all episodes for an anime from Jikan with pagination.
 * Jikan returns paginated results with `pagination.last_visible_page` and `pagination.has_next_page`.
 * @param {number|string} malId
 * @returns {Promise<Array>} Array of all episode objects from all pages
 */
export async function getAllEpisodes(malId) {
  const allEpisodes = [];
  let page = 1;
  let hasNextPage = true;

  while (hasNextPage) {
    await jikanLimiter();
    const json = await getEpisodesPage(malId, page);
    if (!json || !json.data || json.data.length === 0) {
      break;
    }
    allEpisodes.push(...json.data);
    hasNextPage = json.pagination?.has_next_page === true;
    page++;
  }

  return allEpisodes;
}

/**
 * Normalizes Jikan episode data into our episode schema.
 * Jikan episodes have: mal_id, url, title, title_japanese, title_romanji, aired, score, filler, recap, forum_url
 * Our schema expects: episode, length, airDate, title {en, romaji, ja}, tvdbShowId, tvdbId, seasonNumber, episodeNumber, absoluteEpisodeNumber, runtime, image
 * Fields we CAN'T get from Jikan are set to null.
 * @param {Array} rawEpisodes - Array of raw Jikan episode objects
 * @returns {Record<string, object>} Episodes keyed by episode number string
 */
export function normalizeJikanEpisodes(rawEpisodes) {
  const result = {};
  if (!rawEpisodes || !Array.isArray(rawEpisodes)) return result;

  for (const ep of rawEpisodes) {
    const epNum = String(ep.mal_id ?? ep.episode ?? '0');
    result[epNum] = {
      episode: epNum,
      length: null, // Jikan doesn't provide episode length
      airDate: ep.aired ?? null,
      title: {
        en: ep.title ?? null,
        romaji: ep.title_romanji ?? null,
        ja: ep.title_japanese ?? null,
      },
      tvdbShowId: null,
      tvdbId: null,
      seasonNumber: null,
      episodeNumber: ep.mal_id ?? null,
      absoluteEpisodeNumber: null,
      runtime: null,
      image: null,
    };
  }

  return result;
}

/** Normalizes a Jikan `data` object into our internal shape. */
export function normalizeJikan(raw) {
  if (!raw) return null;

  return {
    malId: raw.mal_id,
    titles: {
      default: raw.title ?? null,
      english: raw.title_english ?? null,
      japanese: raw.title_japanese ?? null,
      synonyms: raw.title_synonyms ?? [],
    },
    type: raw.type ?? null, // TV, Movie, OVA, ONA, Special, Music
    source: raw.source ?? null, // Manga, Light novel, Original, etc.
    episodeCount: raw.episodes ?? null,
    status: raw.status ?? null, // "Currently Airing" | "Finished Airing" | "Not yet aired"
    airing: Boolean(raw.airing),
    aired: {
      from: raw.aired?.from ?? null,
      to: raw.aired?.to ?? null,
    },
    duration: raw.duration ?? null,
    rating: raw.rating ?? null,
    score: raw.score ?? null,
    synopsis: raw.synopsis ?? null,
    season: raw.season ?? null,
    year: raw.year ?? null,
    broadcast: raw.broadcast
      ? {
          day: raw.broadcast.day ?? null,
          time: raw.broadcast.time ?? null,
          timezone: raw.broadcast.timezone ?? null,
        }
      : null,
    producers: (raw.producers ?? []).map((p) => p.name),
    studios: (raw.studios ?? []).map((s) => s.name),
    genres: (raw.genres ?? []).map((g) => g.name),
    images: {
      poster: raw.images?.jpg?.large_image_url ?? raw.images?.jpg?.image_url ?? null,
      posterWebp: raw.images?.webp?.large_image_url ?? null,
    },
    trailer: raw.trailer?.youtube_id
      ? {
          youtubeId: raw.trailer.youtube_id,
          url: raw.trailer.url ?? null,
          thumbnail: raw.trailer.images?.maximum_image_url ?? null,
        }
      : null,
  };
}
