/**
 * AniList public GraphQL API client.
 * Docs: https://docs.anilist.co/
 *
 * AniList's degraded-mode rate limit is ~30 req/min (used to be 90/min).
 * We treat it as enrichment (banner images, next-airing-episode, and
 * detailed relations data) rather than the primary source, since Jikan
 * covers most of the same ground and is friendlier to crawl at scale.
 */
import { fetchJson } from './httpClient.js';

const ENDPOINT = 'https://graphql.anilist.co';

const QUERY = /* GraphQL */ `
  query ($idMal: Int) {
    Media(idMal: $idMal, type: ANIME) {
      id
      idMal
      title {
        romaji
        english
        native
      }
      synonyms
      format
      status
      season
      seasonYear
      episodes
      duration
      genres
      averageScore
      coverImage {
        extraLarge
        color
      }
      bannerImage
      studios(isMain: true) {
        nodes {
          name
        }
      }
      nextAiringEpisode {
        episode
        airingAt
      }
      relations {
        edges {
          relationType
          node {
            id
            idMal
            type
            title {
              romaji
              english
              native
            }
            coverImage {
              large
            }
            format
            episodes
            seasonYear
            startDate {
              year
              month
              day
            }
          }
        }
      }
    }
  }
`;

/**
 * @param {number|string} malId
 * @returns {Promise<object|null>} raw AniList Media object, or null if not found
 */
export async function getAnimeByMalId(malId) {
  const json = await fetchJson(ENDPOINT, {
    label: 'AniList',
    retries: 3,
    baseDelayMs: 2000,
    treat404AsNull: false, // AniList returns 404 inside a 200 GraphQL error payload, handled below
    fetchOptions: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { idMal: Number(malId) } }),
    },
  });

  if (!json) return null;
  if (json.errors) {
    const notFound = json.errors.some((e) => e.status === 404 || /not found/i.test(e.message));
    if (notFound) return null;
    throw new Error(`AniList GraphQL error: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  return json.data?.Media ?? null;
}

/** Normalizes a raw AniList Media object into our internal shape. */
export function normalizeAniList(raw) {
  if (!raw) return null;

  return {
    anilistId: raw.id,
    titles: {
      romaji: raw.title?.romaji ?? null,
      english: raw.title?.english ?? null,
      native: raw.title?.native ?? null,
    },
    synonyms: raw.synonyms ?? [],
    format: raw.format ?? null,
    status: raw.status ?? null,
    season: raw.season ?? null,
    seasonYear: raw.seasonYear ?? null,
    episodeCount: raw.episodes ?? null,
    duration: raw.duration ?? null,
    genres: raw.genres ?? [],
    averageScore: raw.averageScore != null ? Number((raw.averageScore / 10).toFixed(2)) : null,
    coverImage: raw.coverImage?.extraLarge ?? null,
    coverColor: raw.coverImage?.color ?? null,
    bannerImage: raw.bannerImage ?? null,
    studios: (raw.studios?.nodes ?? []).map((s) => s.name),
    nextAiringEpisode: raw.nextAiringEpisode
      ? { episode: raw.nextAiringEpisode.episode, airingAt: raw.nextAiringEpisode.airingAt }
      : null,
    // "sequence": the chronological list of related ANIME titles (manga/
    // novel/one-shot sources and other non-anime relations are filtered
    // out - this is meant to show watch order, not the source material).
    // Sourced from AniList because it gives a title/image/format/episodes/
    // seasonYear per related entry directly; Jikan's relations only give
    // { malId, type, name } grouped by relation type, which isn't enough
    // to render a "related anime" card without a follow-up lookup per
    // entry. Sorted oldest-first by release date (falls back to
    // seasonYear, then to "unknown" sorted last) so the array order
    // itself tells you what came first.
    sequence: (raw.relations?.edges ?? [])
      .filter((edge) => edge.node && edge.node.type === 'ANIME')
      .map((edge) => ({
        malId: edge.node.idMal ?? null,
        title: {
          romaji: edge.node.title?.romaji ?? null,
          english: edge.node.title?.english ?? null,
          native: edge.node.title?.native ?? null,
        },
        image: edge.node.coverImage?.large ?? null,
        format: edge.node.format ?? null,
        episodes: edge.node.episodes ?? null,
        seasonYear: edge.node.seasonYear ?? null,
        relationType: edge.relationType ?? null,
        _sortKey: relationSortKey(edge.node.startDate, edge.node.seasonYear),
      }))
      .sort((a, b) => a._sortKey - b._sortKey)
      .map(({ _sortKey, ...entry }) => entry),
  };
}

/**
 * Builds a sortable number from an AniList FuzzyDate + seasonYear so
 * related titles can be ordered oldest-first even when some entries only
 * have a year (or nothing at all). Missing dates sort to the very end
 * rather than being guessed at.
 */
function relationSortKey(startDate, seasonYear) {
  if (startDate?.year) {
    const month = startDate.month ?? 1;
    const day = startDate.day ?? 1;
    return startDate.year * 10000 + month * 100 + day;
  }
  if (seasonYear) {
    return seasonYear * 10000 + 100 + 1; // approximate as Jan 1 of that year
  }
  return Infinity;
}
