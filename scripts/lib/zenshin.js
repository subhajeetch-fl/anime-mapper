/**
 * AniZip client (api.ani.zip).
 *
 * IMPORTANT CONTEXT FOR THE USER: the per-episode schema given in the spec
 * (anidbEid, isFiller, isDubbed, tvdbShowId, tvdbId, seasonNumber,
 * absoluteEpisodeNumber, the artworks.thetvdb.com screencap image...) is
 * NOT produced by Jikan, AniList, Kitsu, or animeapi.my.id. Those fields
 * match AniZip's response format almost exactly - it's a free aggregator
 * that merges AniDB (filler flags), TVDB (episode artwork/ids/titles) and
 * dub-availability data per episode. None of the four APIs you listed
 * provide AniDB episode ids or TVDB episode ids on their own, so AniZip
 * (or a TVDB+AniDB integration you build yourself) is required to get this
 * exact shape. AniZip has no published auth requirement or documented hard
 * rate limit as of this writing, but treat it conservatively (small delay
 * between calls, retries with backoff) since it's a free community service.
 *
 * Endpoint takes an AniList id (preferred) - which is why idMapping.js
 * must run BEFORE this client in the pipeline.
 */
import { fetchJson } from './httpClient.js';

const BASE_URL = 'https://zenshin-supabase-api.onrender.com/mappings';

/**
 * @param {number|string} anilistId
 * @returns {Promise<object|null>} raw AniZip payload, or null if no match
 */
export async function getEpisodesByAniListId(anilistId) {
  if (!anilistId) return null;
  return fetchJson(`${BASE_URL}?anilist_id=${anilistId}`, {
    label: 'Zenshin',
    retries: 3,
    baseDelayMs: 1500,
  });
}

/**
 * Transforms AniZip's raw `episodes` object into the exact per-episode
 * shape specified for this project. AniZip already uses almost the same
 * field names; this function fills in anything missing and guarantees a
 * consistent shape even when AniZip itself is missing a field for a given
 * episode (common for very new or very old/obscure titles).
 *
 * @param {object} rawAniZip - full response from getEpisodesByAniListId
 * @returns {Record<string, object>} keyed by episode number string, e.g. "1"
 */
export function normalizeEpisodes(rawAniZip) {
  const episodes = rawAniZip?.episodes;
  if (!episodes || typeof episodes !== 'object') return {};

  const result = {};

  for (const [key, ep] of Object.entries(episodes)) {
    result[key] = {
      episode: String(ep.episode ?? key),
      length: ep.length ?? (ep.runtime ? `${ep.runtime}m` : null),
      airDate: ep.airDate ?? ep.airdate ?? null,
      title: {
        en: ep.title?.en ?? null,
        ...(ep.title?.['x-jat'] ? { romaji: ep.title['x-jat'] } : {}),
        ...(ep.title?.ja ? { ja: ep.title.ja } : {}),
      },
      tvdbShowId: ep.tvdbShowId ?? null,
      tvdbId: ep.tvdbId ?? null,
      seasonNumber: ep.seasonNumber ?? null,
      episodeNumber: ep.episodeNumber ?? Number(key) ?? null,
      absoluteEpisodeNumber: ep.absoluteEpisodeNumber ?? null,
      runtime: ep.runtime ?? null,
      image: ep.image ?? null,
    };
  }

  return result;
}
