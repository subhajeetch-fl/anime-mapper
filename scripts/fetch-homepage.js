/**
 * Fetches homepage data from AniList's GraphQL API and saves it as
 * data/homepage.json.
 *
 * This replaces the old trending.json / popular.json / top-rated.json /
 * genre-index.json files with a single, comprehensive homepage data file
 * covering every section a homepage would need:
 *
 *   - Spotlight       (top trending with banners, for hero carousel)
 *   - Trending        (trending overall)
 *   - Top by Time      (currently releasing: by day / week / month)
 *   - Most Watched     (global trending activity)
 *   - Most Popular     (all-time by AniList popularity)
 *   - Latest Episodes  (recently aired, deduplicated per anime)
 *   - Top Rated         (all-time by AniList score)
 *   - Popular This Season (current season, by popularity)
 *
 * Each anime entry is stored in the project's card format (matching the
 * schema of data/anime/{id}.json) so the frontend can use the same
 * rendering logic for homepage cards and detail pages. Fields that come
 * only from Jikan/Kitsu (like malScore, producers, rating) are null
 * since this data is sourced exclusively from AniList.
 *
 * Designed to run every 12 hours via GitHub Actions.
 *
 * CLI usage: node scripts/fetch-homepage.js
 */

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fetchJson } from './lib/httpClient.js';

const ANILIST_ENDPOINT = 'https://graphql.anilist.co';
const DATA_DIR = path.resolve('data');
const HOMEPAGE_FILE = path.join(DATA_DIR, 'homepage.json');
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

// ── GraphQL query ─────────────────────────────────────────────────────────

const HOMEPAGE_QUERY = /* GraphQL */ `
  query Homepage($season: MediaSeason, $seasonYear: Int, $now: Int!) {
    spotlight: Page(page: 1, perPage: 10) {
      media(
        type: ANIME
        sort: [TRENDING_DESC]
        format_in: [TV, TV_SHORT]
        isAdult: false
      ) {
        ...SpotlightCard
      }
    }

    trending: Page(page: 1, perPage: 20) {
      media(
        type: ANIME
        sort: [TRENDING_DESC]
        format_in: [TV, TV_SHORT]
        isAdult: false
      ) {
        ...AnimeCard
      }
    }

    topByDay: Page(page: 1, perPage: 10) {
      media(
        type: ANIME
        sort: [TRENDING_DESC]
        status: RELEASING
        format_in: [TV, TV_SHORT]
        isAdult: false
      ) {
        ...AnimeCard
      }
    }

    topByWeek: Page(page: 1, perPage: 10) {
      media(
        type: ANIME
        sort: [POPULARITY_DESC]
        status: RELEASING
        format_in: [TV, TV_SHORT]
        isAdult: false
      ) {
        ...AnimeCard
      }
    }

    topByMonth: Page(page: 1, perPage: 10) {
      media(
        type: ANIME
        sort: [SCORE_DESC]
        status: RELEASING
        format_in: [TV, TV_SHORT]
        isAdult: false
      ) {
        ...AnimeCard
      }
    }

    mostWatched: Page(page: 1, perPage: 24) {
      media(
        type: ANIME
        sort: [TRENDING_DESC]
        format_in: [TV, TV_SHORT]
        isAdult: false
      ) {
        ...AnimeCard
      }
    }

    mostPopular: Page(page: 1, perPage: 24) {
      media(
        type: ANIME
        sort: [POPULARITY_DESC]
        format_in: [TV, TV_SHORT]
        isAdult: false
      ) {
        ...AnimeCard
      }
    }

    topRated: Page(page: 1, perPage: 24) {
      media(
        type: ANIME
        sort: [SCORE_DESC]
        format_in: [TV, TV_SHORT]
        isAdult: false
      ) {
        ...AnimeCard
      }
    }

    thisSeasonPopular: Page(page: 1, perPage: 24) {
      media(
        type: ANIME
        season: $season
        seasonYear: $seasonYear
        sort: [POPULARITY_DESC]
        format_in: [TV, TV_SHORT]
        isAdult: false
      ) {
        ...AnimeCard
      }
    }

    latestEpisodes: Page(page: 1, perPage: 50) {
      airingSchedules(
        notYetAired: false
        airingAt_lesser: $now
        sort: [TIME_DESC]
      ) {
        episode
        airingAt
        media {
          ...AnimeCard
        }
      }
    }
  }

  fragment SpotlightCard on Media {
    ...AnimeCard
    description
  }

  fragment AnimeCard on Media {
    id
    idMal
    title {
      romaji
      english
      native
      userPreferred
    }
    synonyms
    coverImage {
      extraLarge
      large
      medium
      color
    }
    bannerImage
    format
    status
    season
    seasonYear
    episodes
    duration
    genres
    averageScore
    popularity
    favourites
    trending
    isAdult
    startDate {
      year
      month
      day
    }
    endDate {
      year
      month
      day
    }
    trailer {
      id
      site
      thumbnail
    }
    studios(isMain: true) {
      nodes {
        id
        name
        isAnimationStudio
        siteUrl
      }
    }
    siteUrl
  }
`;

// ── AniList → project format converters ───────────────────────────────────

const STATUS_MAP = {
  FINISHED: 'Finished Airing',
  RELEASING: 'Currently Airing',
  NOT_YET_RELEASED: 'Not Yet Aired',
  CANCELLED: 'Cancelled',
  HIATUS: 'On Hiatus',
};

const FORMAT_MAP = {
  TV: 'TV',
  TV_SHORT: 'TV Short',
  MOVIE: 'Movie',
  SPECIAL: 'Special',
  OVA: 'OVA',
  ONA: 'ONA',
  MUSIC: 'Music',
};

/**
 * Convert an AniList FuzzyDate ({ year, month, day }) to an ISO-8601 string.
 * Returns null when the date is missing or incomplete.
 */
function anilistDateToISO(date) {
  if (!date?.year) return null;
  const y = date.year;
  const m = String(date.month ?? 1).padStart(2, '0');
  const d = String(date.day ?? 1).padStart(2, '0');
  return `${y}-${m}-${d}T00:00:00+00:00`;
}

/**
 * Strip HTML/markdown that AniList includes in description fields so the
 * synopsis matches the plain-text format Jikan provides.
 */
/**
 * Decode common named and numeric HTML entities in text.
 */
function decodeHtmlEntities(text) {
  const namedEntities = {
    nbsp: ' ',
    mdash: '—',
    ndash: '–',
    rsquo: '’',
    lsquo: '‘',
    ldquo: '“',
    rdquo: '”',
    laquo: '«',
    raquo: '»',
    hellip: '…',
    bull: '•',
    trade: '™',
    copy: '©',
    reg: '®',
  };
  return text.replace(/&(#?\w+);/g, (match, entity) => {
    if (entity.startsWith('#')) {
      const code = Number(entity.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return namedEntities[entity] ?? match;
  });
}

function cleanAniListDescription(raw) {
  if (!raw) return null;
  let cleaned = raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(i|em|b|strong|u|s|span|a)[^>]*>/gi, '')
    // AniList spoiler tags: ~! ... !~
    .replace(/~![\s\S]*?!~/g, '')
    .trim();
  cleaned = decodeHtmlEntities(cleaned);
  return cleaned || null;
}

/**
 * Derive the current anime season from the current date.
 * Winter: Jan–Mar, Spring: Apr–Jun, Summer: Jul–Sep, Fall: Oct–Dec.
 */
function getCurrentSeason() {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  if (month <= 3) return { season: 'WINTER', year };
  if (month <= 6) return { season: 'SPRING', year };
  if (month <= 9) return { season: 'SUMMER', year };
  return { season: 'FALL', year };
}

/**
 * Transform raw AniList Media into the project's anime card format.
 * Returns null for entries that can't be identified (no id).
 */
function toCard(media) {
  if (!media || typeof media.id !== 'number' || media.idMal == null) return null;

  return {
    id: media.idMal,
    idMal: media.idMal ?? null,
    mappings: {
      mal: media.idMal ?? null,
      anilist: media.id,
      anidb: null,
      kitsu: null,
      simkl: null,
      tmdb: null,
      tvdb: null,
      animeplanet: null,
    },
    title: {
      romaji: media.title?.romaji ?? null,
      english: media.title?.english ?? null,
      native: media.title?.native ?? null,
      synonyms: media.synonyms ?? [],
    },
    type: FORMAT_MAP[media.format] ?? media.format ?? null,
    status: STATUS_MAP[media.status] ?? media.status ?? null,
    airing: media.status === 'RELEASING',
    episodeCount: media.episodes ?? null,
    episodeLength: media.duration ?? null,
    aired: {
      from: anilistDateToISO(media.startDate),
      to: anilistDateToISO(media.endDate),
    },
    season: media.season?.toLowerCase() ?? null,
    year: media.seasonYear ?? null,
    rating: null,
    score: {
      malScore: null,
      anilistScore:
        media.averageScore != null
          ? Number((media.averageScore / 10).toFixed(2))
          : null,
      kitsuRating: null,
    },
    genres: media.genres ?? [],
    studios: (media.studios?.nodes ?? []).map((s) => s.name),
    producers: [],
    images: {
      poster: media.coverImage?.extraLarge ?? null,
      banner: media.bannerImage ?? null,
      color: media.coverImage?.color ?? null,
    },
    trailer: media.trailer
      ? {
          id: media.trailer.id ?? null,
          site: media.trailer.site ?? null,
          thumbnail: media.trailer.thumbnail ?? null,
        }
      : null,
    synopsis: cleanAniListDescription(media.description),
  };
}

// ── Section helpers ────────────────────────────────────────────────────────

/**
 * Extract an array of cards from a raw AniList Page object.
 * Filters out nulls (entries that failed validation in toCard).
 */
function getSectionResults(page) {
  return (page?.media ?? []).map(toCard).filter(Boolean);
}

/**
 * Spotlight entries need a banner image for the hero carousel.
 * Prefer entries with banners (need at least 6); fall back to
 * any entries if not enough have banners.
 */
function getSpotlightResults(page) {
  const all = (page?.media ?? []).map(toCard).filter(Boolean);

  const withBanner = all.filter(
    (card) => Boolean(card.images.banner) && Boolean(card.synopsis)
  );

  if (withBanner.length >= 6) return withBanner.slice(0, 8);

  return all.slice(0, 8);
}

/**
 * Process the latestEpisodes airing schedules:
 *  - Deduplicate (one entry per anime, most recent episode)
 *  - Filter out adult content
 *  - Cap at 24 entries
 */
function getLatestEpisodeResults(page) {
  const results = new Map();

  for (const schedule of page?.airingSchedules ?? []) {
    const card = toCard(schedule.media);
    if (!card || schedule.media?.isAdult) continue;
    if (results.has(card.id)) continue;

    results.set(card.id, {
      ...card,
      latestEpisode: {
        episode: schedule.episode ?? null,
        airingAt: schedule.airingAt ?? null,
        airingAtDate: schedule.airingAt
          ? new Date(schedule.airingAt * 1000).toISOString()
          : null,
      },
    });

    if (results.size >= 24) break;
  }

  return [...results.values()];
}

// ── AniList request ───────────────────────────────────────────────────────

/**
 * Fetch homepage data from AniList. The GraphQL query fetches all sections
 * in a single request. Retries and timeouts are handled by httpClient.js.
 */
async function fetchAniListHomepage(season, seasonYear, nowSeconds) {
  const payload = await fetchJson(ANILIST_ENDPOINT, {
    label: 'AniList Homepage',
    retries: 3,
    baseDelayMs: 2000,
    timeoutMs: 30000,
    treat404AsNull: false,
    fetchOptions: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        query: HOMEPAGE_QUERY,
        variables: { season, seasonYear, now: nowSeconds },
      }),
    },
  });

  if (!payload) {
    throw new Error('AniList returned no response body.');
  }

  if (payload.errors?.length) {
    const messages = payload.errors.map((e) => e.message).join('; ');
    console.error(`[fetch-homepage] AniList GraphQL warnings: ${messages}`);
  }

  if (!payload.data) {
    throw new Error(
      'AniList response did not include data.' +
        (payload.errors?.length
          ? ` Errors: ${payload.errors.map((e) => e.message).join('; ')}`
          : '')
    );
  }

  return payload.data;
}

// ── Main ───────────────────────────────────────────────────────────────────

/**
 * Build the complete homepage data object and write it to data/homepage.json.
 *
 * @returns {Promise<{ generatedAt: string, sections: string[] }>}
 */
export async function fetchHomepage() {
  const nowMs = Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const { season, year } = getCurrentSeason();

  console.log(
    `[fetch-homepage] fetching from AniList (season: ${season} ${year})...`
  );

  const raw = await fetchAniListHomepage(season, year, nowSeconds);

  const homepageData = {
    spotlight: getSpotlightResults(raw.spotlight),
    trending: getSectionResults(raw.trending),
    topByTime: {
      byDay: getSectionResults(raw.topByDay),
      byWeek: getSectionResults(raw.topByWeek),
      byMonth: getSectionResults(raw.topByMonth),
    },
    mostWatched: {
      title: 'Most Watched',
      results: getSectionResults(raw.mostWatched),
    },
    mostPopular: {
      title: 'Most Popular',
      results: getSectionResults(raw.mostPopular),
    },
    latestEpisodes: {
      title: 'Latest Episodes',
      results: getLatestEpisodeResults(raw.latestEpisodes),
    },
    topRated: {
      title: 'Top Rated',
      results: getSectionResults(raw.topRated),
    },
    thisSeasonPopular: {
      title: 'Popular This Season',
      results: getSectionResults(raw.thisSeasonPopular),
    },
    generatedAt: new Date(nowMs).toISOString(),
    cacheExpiresAt: nowMs + CACHE_TTL_MS,
  };

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(
    HOMEPAGE_FILE,
    `${JSON.stringify(homepageData, null, 2)}\n`,
    'utf-8'
  );

  const sections = Object.keys(homepageData).filter(
    (k) => !['generatedAt', 'cacheExpiresAt'].includes(k)
  );

  console.log(
    `[fetch-homepage] wrote ${HOMEPAGE_FILE} ` +
      `(${sections.length} sections, generated at ${homepageData.generatedAt})`
  );

  return {
    generatedAt: homepageData.generatedAt,
    sections,
  };
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────

const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  try {
    await fetchHomepage();
  } catch (err) {
    console.error(`[fetch-homepage] FAILED: ${err.message}`);

    // If an old homepage.json exists from a previous successful run,
    // preserve it so the site stays up; the next scheduled run will retry.
    try {
      const existing = await readFile(HOMEPAGE_FILE, 'utf-8');
      const parsed = JSON.parse(existing);
      console.error(
        `[fetch-homepage] keeping previous homepage.json ` +
          `(generated at ${parsed.generatedAt ?? 'unknown'})`
      );
    } catch {
      // No previous file — nothing to fall back to.
    }

    process.exit(1);
  }
}
