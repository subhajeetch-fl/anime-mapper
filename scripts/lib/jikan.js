/**
 * Jikan v4 (unofficial MyAnimeList API) client.
 * Docs: https://docs.api.jikan.moe/
 *
 * Jikan's public rate limit is roughly 3 req/sec and 60 req/min.
 * We stay well under that by spacing calls out in the orchestrator
 * (see scripts/lib/rateLimiter.js) rather than firing concurrently.
 */
import { fetchJson } from './httpClient.js';

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
