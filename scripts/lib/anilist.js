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
      source
      season
      seasonYear
      episodes
      duration
      genres
      averageScore
      description(asHtml: false)
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
      coverImage {
        extraLarge
        color
      }
      bannerImage
      trailer {
        id
        site
        thumbnail
      }
      studios {
        edges {
          isMain
          node {
            name
          }
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

function fuzzyDateToISO(d) {
  if (!d || !Number.isInteger(d.year)) return null;
  const y = String(d.year).padStart(4, '0');
  const m = String(d.month || 1).padStart(2, '0');
  const day = String(d.day || 1).padStart(2, '0');
  return `${y}-${m}-${day}T00:00:00+00:00`;
}

function cleanDescription(desc) {
  if (!desc || typeof desc !== 'string') return null;
  return (
    desc
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .trim() || null
  );
}

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

  const studioEdges = raw.studios?.edges ?? [];
  const studios = studioEdges
    .filter((e) => e.isMain && e.node?.name)
    .map((e) => e.node.name);
  const producers = studioEdges
    .filter((e) => !e.isMain && e.node?.name)
    .map((e) => e.node.name);

  const trailer =
    raw.trailer?.site?.toLowerCase() === 'youtube' && raw.trailer?.id
      ? {
          youtubeId: raw.trailer.id,
          url: `https://www.youtube.com/watch?v=${raw.trailer.id}`,
          thumbnail:
            raw.trailer.thumbnail ??
            `https://img.youtube.com/vi/${raw.trailer.id}/maxresdefault.jpg`,
        }
      : null;

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
    source: raw.source ?? null,
    season: raw.season ?? null,
    seasonYear: raw.seasonYear ?? null,
    episodeCount: raw.episodes ?? null,
    duration: raw.duration ?? null,
    genres: raw.genres ?? [],
    averageScore: raw.averageScore != null ? Number((raw.averageScore / 10).toFixed(2)) : null,
    synopsis: cleanDescription(raw.description),
    aired: {
      from: fuzzyDateToISO(raw.startDate),
      to: fuzzyDateToISO(raw.endDate),
    },
    coverImage: raw.coverImage?.extraLarge ?? null,
    coverColor: raw.coverImage?.color ?? null,
    bannerImage: raw.bannerImage ?? null,
    trailer,
    studios,
    producers,
    nextAiringEpisode: raw.nextAiringEpisode
      ? { episode: raw.nextAiringEpisode.episode, airingAt: raw.nextAiringEpisode.airingAt }
      : null,
    // "sequence": chronological list of related ANIME titles (watch order).
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
 * related titles can be ordered oldest-first.
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
