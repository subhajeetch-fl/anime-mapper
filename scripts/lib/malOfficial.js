/**
 * Official MyAnimeList API v2 client.
 * Docs: https://myanimelist.net/apiconfig/references/api/v2
 *
 * Public catalog reads require only the `X-MAL-CLIENT-ID` header
 * (no OAuth2 user token needed). Set MAL_CLIENT_ID in your environment
 * or GitHub Actions secrets.
 */
import { fetchJson } from './httpClient.js';

const BASE_URL = 'https://api.myanimelist.net/v2';

const ANIME_DETAIL_FIELDS = [
  'id',
  'title',
  'main_picture',
  'alternative_titles',
  'start_date',
  'end_date',
  'synopsis',
  'mean',
  'rank',
  'popularity',
  'nsfw',
  'genres',
  'media_type',
  'status',
  'num_episodes',
  'start_season',
  'broadcast',
  'source',
  'average_episode_duration',
  'rating',
  'studios',
].join(',');

const MEDIA_TYPE_MAP = {
  tv: 'TV',
  ova: 'OVA',
  movie: 'Movie',
  special: 'Special',
  ona: 'ONA',
  music: 'Music',
  cm: 'CM',
  pv: 'PV',
  tv_special: 'TV Special',
  unknown: null,
};

const STATUS_MAP = {
  finished_airing: 'Finished Airing',
  currently_airing: 'Currently Airing',
  not_yet_aired: 'Not yet aired',
};

const SOURCE_MAP = {
  original: 'Original',
  manga: 'Manga',
  '4_koma_manga': '4-koma manga',
  web_manga: 'Web manga',
  digital_manga: 'Digital manga',
  novel: 'Novel',
  light_novel: 'Light novel',
  visual_novel: 'Visual novel',
  game: 'Game',
  card_game: 'Card game',
  book: 'Book',
  picture_book: 'Picture book',
  radio: 'Radio',
  music: 'Music',
  web_novel: 'Web novel',
  mixed_media: 'Mixed media',
  other: 'Other',
};

const RATING_MAP = {
  g: 'G - All Ages',
  pg: 'PG - Children',
  pg_13: 'PG-13 - Teens 13 or older',
  r: 'R - 17+ (violence & profanity)',
  'r+': 'R+ - Mild Nudity',
  rx: 'Rx - Hentai',
};

function getClientHeaders() {
  const clientId = process.env.MAL_CLIENT_ID;
  if (!clientId) {
    throw new Error(
      'MAL_CLIENT_ID environment variable is required for Official MAL API v2'
    );
  }
  return {
    'X-MAL-CLIENT-ID': clientId,
    Accept: 'application/json',
  };
}

/**
 * Normalize MAL partial dates ("2024", "2024-04", "2024-04-07") into ISO-8601
 * strings matching the existing schema's aired.from / aired.to format.
 */
function malDateToISO(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const parts = dateStr.split('-').map(Number);
  if (!Number.isInteger(parts[0])) return null;
  const y = String(parts[0]).padStart(4, '0');
  const m = String(parts[1] || 1).padStart(2, '0');
  const d = String(parts[2] || 1).padStart(2, '0');
  return `${y}-${m}-${d}T00:00:00+00:00`;
}

/**
 * Format MAL's lowercase weekday ("sunday") to match Jikan's pluralized
 * format ("Sundays") used in existing records.
 */
function formatBroadcastDay(day) {
  if (!day || typeof day !== 'string') return null;
  const clean = day.trim().toLowerCase();
  if (!clean || clean === 'other') return null;
  const capitalized = clean.charAt(0).toUpperCase() + clean.slice(1);
  return capitalized.endsWith('s') ? capitalized : `${capitalized}s`;
}

/**
 * Fetch full anime metadata by MAL ID.
 * @param {number|string} malId
 * @returns {Promise<object|null>} raw MAL v2 anime object, or null on 404
 */
export async function getAnimeById(malId) {
  const url = `${BASE_URL}/anime/${malId}?fields=${encodeURIComponent(ANIME_DETAIL_FIELDS)}`;
  return fetchJson(url, {
    label: 'MAL Official',
    retries: 3,
    baseDelayMs: 1200,
    timeoutMs: 15000,
    fetchOptions: {
      headers: getClientHeaders(),
    },
  });
}

/**
 * Fetch a page of seasonal anime IDs (used by discover-ids.js to catch newly
 * registered seasonal releases without waiting for weekly offline dumps).
 */
export async function getSeasonalAnimeIds(year, season, { limit = 500, offset = 0 } = {}) {
  const url =
    `${BASE_URL}/anime/season/${year}/${season.toLowerCase()}` +
    `?limit=${limit}&offset=${offset}&nsfw=true&fields=id`;
  const json = await fetchJson(url, {
    label: `MAL Season ${year} ${season}`,
    retries: 3,
    baseDelayMs: 1200,
    fetchOptions: { headers: getClientHeaders() },
  });
  return {
    ids: (json?.data ?? []).map((entry) => Number(entry.node?.id)).filter(Boolean),
    hasNext: Boolean(json?.paging?.next),
  };
}

/**
 * Fetch anime IDs from a MAL ranking feed (e.g., 'upcoming', 'airing').
 */
export async function getRankingAnimeIds(
  rankingType = 'upcoming',
  { limit = 500, offset = 0 } = {}
) {
  const url =
    `${BASE_URL}/anime/ranking?ranking_type=${encodeURIComponent(rankingType)}` +
    `&limit=${limit}&offset=${offset}&nsfw=true&fields=id`;
  const json = await fetchJson(url, {
    label: `MAL Ranking ${rankingType}`,
    retries: 3,
    baseDelayMs: 1200,
    fetchOptions: { headers: getClientHeaders() },
  });
  return {
    ids: (json?.data ?? []).map((entry) => Number(entry.node?.id)).filter(Boolean),
    hasNext: Boolean(json?.paging?.next),
  };
}

/**
 * Normalizes a raw Official MAL API v2 anime payload into anime-mapper's
 * internal metadata shape.
 */
export function normalizeMalOfficial(raw) {
  if (!raw || !raw.id) return null;

  const alt = raw.alternative_titles ?? {};
  const durationSec = Number(raw.average_episode_duration);
  const episodeLengthMin =
    Number.isFinite(durationSec) && durationSec > 0
      ? Math.round(durationSec / 60)
      : null;

  return {
    malId: raw.id,
    titles: {
      default: raw.title ?? null,
      english: alt.en || null,
      japanese: alt.ja || null,
      synonyms: Array.isArray(alt.synonyms) ? alt.synonyms.filter(Boolean) : [],
    },
    type: MEDIA_TYPE_MAP[raw.media_type] ?? raw.media_type ?? null,
    source: SOURCE_MAP[raw.source] ?? raw.source ?? null,
    episodeCount: raw.num_episodes > 0 ? raw.num_episodes : null,
    episodeLength: episodeLengthMin,
    status: STATUS_MAP[raw.status] ?? raw.status ?? null,
    airing: raw.status === 'currently_airing',
    aired: {
      from: malDateToISO(raw.start_date),
      to: malDateToISO(raw.end_date),
    },
    rating: RATING_MAP[raw.rating] ?? raw.rating ?? null,
    score: typeof raw.mean === 'number' ? raw.mean : null,
    synopsis: raw.synopsis?.trim() || null,
    season: raw.start_season?.season?.toLowerCase() ?? null,
    year: raw.start_season?.year ?? null,
    broadcast: raw.broadcast
      ? {
          day: formatBroadcastDay(raw.broadcast.day_of_the_week),
          time: raw.broadcast.start_time ?? null,
          timezone: 'Asia/Tokyo',
        }
      : null,
    studios: (raw.studios ?? []).map((s) => s.name).filter(Boolean),
    genres: (raw.genres ?? []).map((g) => g.name).filter(Boolean),
    images: {
      poster: raw.main_picture?.large ?? raw.main_picture?.medium ?? null,
    },
  };
}
