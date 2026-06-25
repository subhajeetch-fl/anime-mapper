/**
 * Fetches a single anime from every source, merges them into the schema
 * documented in README.md, and writes data/anime/{malId}.json.
 *
 * Source priority (per spec - "save anime detail mostly from MAL/Jikan or
 * Kitsu"):
 *   1. Jikan      - PRIMARY metadata (synopsis, genres, studios, score, etc.)
 *   2. Kitsu      - FALLBACK metadata if Jikan is missing/down, also fills
 *                   a couple of fields Jikan doesn't have (ageRating).
 *   3. AniList    - ENRICHMENT (banner image, nextAiringEpisode, and now
 *                   the sole source of `sequence` - AniList returns a
 *                   title/image/format/episodes/seasonYear per related
 *                   entry directly, which Jikan's relations don't, and
 *                   lets us filter to anime-only entries and sort them
 *                   chronologically).
 *   4. animeapi.my.id - the `mappings` block (also supplies the AniList id
 *                   Zenshin needs and the Simkl id for dub data).
 *   5. Zenshin     - per-episode data (the schema given in the spec).
 *   6. Simkl      - per-episode dub availability (has-dub), overrides Zenshin's
 *                   isDubbed which is often inaccurate.
 *
 * NOTE: because `sequence` now comes only from AniList, a transient
 * AniList failure means `sequence: []` for that run, not a Jikan-based
 * fallback. That's intentional (Jikan's relations shape isn't rich enough
 * to be useful on its own) and not silent: AniList failures are already
 * tracked as a soft error -> `meta.missingSources` includes "anilist" and
 * the id goes into the retry queue, so the next run backfills it.
 *
 * A single anime is considered a hard FAILURE (-> retry queue + Discord)
 * only if BOTH Jikan and Kitsu fail, since those are the two designated
 * primary sources. AniList/animeapi.my.id/Zenshin failures are logged as
 * soft errors - the file is still written, just missing that enrichment,
 * and `meta.missingSources` records what's absent so a later run can
 * backfill it.
 *
 * CLI usage:
 *   node scripts/fetch-anime.js 21
 *   node scripts/fetch-anime.js 21 813 16498   (multiple ids)
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import * as jikan from './lib/jikan.js';
import * as kitsu from './lib/kitsu.js';
import * as anilist from './lib/anilist.js';
import * as idMapping from './lib/idMapping.js';
import * as Zenshin from './lib/zenshin.js';
import {
  jikanLimiter,
  kitsuLimiter,
  aniListLimiter,
  idMappingLimiter,
  zenshinLimiter,
} from './lib/rateLimiter.js';

const ANIME_DIR = path.resolve('data/anime');

/**
 * @param {number|string} malId
 * @param {object} options
 * @param {boolean} [options.skipUnchanged=false] Do not rewrite the JSON file if meaningful data is identical.
 * @param {boolean} [options.skipWriteOnSoftError=false] Preserve the old file if enrichment sources failed.
 * @returns {Promise<{ ok: boolean, malId: number, errors: Array, filePath?: string, changed?: boolean, skippedWrite?: boolean }>}
 */
export async function fetchAnime(malId, options = {}) {
  const id = Number(malId);
  const { skipUnchanged = false, skipWriteOnSoftError = false } = options;
  const errors = [];
  const missingSources = [];

  // --- 1. ID mapping (also unlocks Zenshin) -------------------------------
  await idMappingLimiter();
  let mappingRaw = null;
  try {
    mappingRaw = await idMapping.getMappingsByMalId(id);
  } catch (err) {
    errors.push({ id, source: 'animeapi.my.id', message: err.message, status: err.status ?? null });
    missingSources.push('animeapi.my.id');
  }
  const mappings = idMapping.normalizeMappings(mappingRaw, id);

  // --- 2. Primary + fallback metadata, fetched concurrently --------------
  const [jikanResult, kitsuResult, anilistResult] = await Promise.allSettled([
    (async () => {
      await jikanLimiter();
      return jikan.getAnimeFull(id);
    })(),
    (async () => {
      await kitsuLimiter();
      return kitsu.getAnimeByMalId(id);
    })(),
    (async () => {
      await aniListLimiter();
      return anilist.getAnimeByMalId(id);
    })(),
  ]);

  const jikanData =
    jikanResult.status === 'fulfilled' ? jikan.normalizeJikan(jikanResult.value) : null;
  const kitsuData =
    kitsuResult.status === 'fulfilled' ? kitsu.normalizeKitsu(kitsuResult.value) : null;
  const anilistData =
    anilistResult.status === 'fulfilled' ? anilist.normalizeAniList(anilistResult.value) : null;

  if (jikanResult.status === 'rejected') {
    errors.push({ id, source: 'Jikan', message: jikanResult.reason.message, status: jikanResult.reason.status ?? null });
    missingSources.push('jikan');
  }
  if (kitsuResult.status === 'rejected') {
    errors.push({ id, source: 'Kitsu', message: kitsuResult.reason.message, status: kitsuResult.reason.status ?? null });
    missingSources.push('kitsu');
  }
  if (anilistResult.status === 'rejected') {
    errors.push({ id, source: 'AniList', message: anilistResult.reason.message, status: anilistResult.reason.status ?? null });
    missingSources.push('anilist');
  }

  // Hard failure: both designated primary sources are unavailable for this title.
  if (!jikanData && !kitsuData) {
    if (!errors.some((error) => error.source === 'Jikan' || error.source === 'Kitsu')) {
      errors.push({
        id,
        source: 'primary',
        message: 'No Jikan or Kitsu record found for this MAL id',
        status: 404,
      });
    }
    return { ok: false, malId: id, errors };
  }

  // --- 3. Episodes via Zenshin (needs an AniList id) -----------------------
  const anilistIdForEpisodes = mappings.anilist ?? anilistData?.anilistId ?? null;
  let episodes = {};
  if (anilistIdForEpisodes) {
    try {
      await zenshinLimiter();
      const rawEpisodes = await Zenshin.getEpisodesByAniListId(anilistIdForEpisodes);
      episodes = Zenshin.normalizeEpisodes(rawEpisodes);
    } catch (err) {
      errors.push({ id, source: 'Zenshin', message: err.message, status: err.status ?? null });
      missingSources.push('zenshin');
    }
  } else {
    missingSources.push('zenshin (no AniList id resolved)');
  }

  // --- 4. Merge into final schema -----------------------------------------
  const genres = dedupeCaseInsensitive([
    ...(jikanData?.genres ?? []),
    ...(anilistData?.genres ?? []),
    ...(kitsuData?.genres ?? []),
  ]);

  const studios = dedupeCaseInsensitive([
    ...(jikanData?.studios ?? []),
    ...(anilistData?.studios ?? []),
  ]);

  const record = {
    id,
    idMal: id,
    mappings,
    title: {
      romaji: anilistData?.titles?.romaji ?? jikanData?.titles?.default ?? null,
      english: jikanData?.titles?.english ?? anilistData?.titles?.english ?? null,
      native: anilistData?.titles?.native ?? jikanData?.titles?.japanese ?? null,
      synonyms: dedupeCaseInsensitive([
        ...(jikanData?.titles?.synonyms ?? []),
        ...(anilistData?.synonyms ?? []),
      ]),
    },
    type: jikanData?.type ?? anilistData?.format ?? null,
    source: jikanData?.source ?? null,
    status: jikanData?.status ?? kitsuData?.status ?? null,
    airing: jikanData?.airing ?? false,
    episodeCount: jikanData?.episodeCount ?? kitsuData?.episodeCount ?? anilistData?.episodeCount ?? null,
    episodeLength: kitsuData?.episodeLength ?? null,
    aired: {
      from: jikanData?.aired?.from ?? kitsuData?.startDate ?? null,
      to: jikanData?.aired?.to ?? kitsuData?.endDate ?? null,
    },
    season: jikanData?.season ?? anilistData?.season?.toLowerCase() ?? null,
    year: jikanData?.year ?? anilistData?.seasonYear ?? null,
    broadcast: jikanData?.broadcast ?? null,
    nextAiringEpisode: anilistData?.nextAiringEpisode ?? null,
    rating: jikanData?.rating ?? kitsuData?.ageRating ?? null,
    score: {
      malScore: jikanData?.score ?? null,
      malScoredBy: jikanData?.scoredBy ?? null,
      malRank: jikanData?.rank ?? null,
      malPopularity: jikanData?.popularity ?? null,
      malMembers: jikanData?.members ?? null,
      malFavorites: jikanData?.favorites ?? null,
      anilistScore: anilistData?.averageScore ?? null,
      anilistPopularity: anilistData?.popularity ?? null,
      anilistFavourites: anilistData?.favourites ?? null,
      anilistTrending: anilistData?.trending ?? null,
      kitsuRating: kitsuData?.averageRating ?? null,
    },
    genres,
    studios,
    producers: jikanData?.producers ?? [],
    images: {
      poster: jikanData?.images?.poster ?? kitsuData?.posterImage ?? anilistData?.coverImage ?? null,
      banner: anilistData?.bannerImage ?? kitsuData?.coverImage ?? null,
      color: anilistData?.coverColor ?? null,
    },
    trailer: jikanData?.trailer ?? null,
    synopsis: jikanData?.synopsis ?? kitsuData?.synopsis ?? null,
    // Chronologically-ordered, anime-only related titles. See
    // scripts/lib/anilist.js for the filtering/sorting logic.
    sequence: anilistData?.sequence ?? [],
    episodes,
    meta: {
      lastFetched: new Date().toISOString(),
      sourcesUsed: ['jikan', 'kitsu', 'anilist', 'animeapi.my.id', 'zenshin', 'simkl'].filter(
        (s) => !missingSources.includes(s) && !missingSources.some((m) => m.startsWith(s))
      ),
      missingSources,
      dataVersion: 1,
    },
  };

  await mkdir(ANIME_DIR, { recursive: true });
  const filePath = path.join(ANIME_DIR, `${id}.json`);

  if (skipWriteOnSoftError && errors.length > 0 && (await fileExists(filePath))) {
    return {
      ok: true,
      malId: id,
      errors,
      filePath,
      record,
      changed: false,
      skippedWrite: true,
      skippedReason: 'soft-errors',
    };
  }

  if (skipUnchanged) {
    const existing = await readExistingJson(filePath);
    if (existing && recordsEqualIgnoringLastFetched(existing, record)) {
      return {
        ok: true,
        malId: id,
        errors,
        filePath,
        record: existing,
        changed: false,
        skippedWrite: true,
        skippedReason: 'unchanged',
      };
    }
  }

  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');

  return { ok: true, malId: id, errors, filePath, record, changed: true, skippedWrite: false };
}

function dedupeCaseInsensitive(arr) {
  const seen = new Map();
  for (const item of arr) {
    if (!item) continue;
    const key = item.toLowerCase();
    if (!seen.has(key)) seen.set(key, item);
  }
  return [...seen.values()];
}

async function fileExists(filePath) {
  try {
    await readFile(filePath, 'utf-8');
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

async function readExistingJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    console.warn(`[fetch-anime] existing file ${filePath} could not be compared: ${err.message}`);
    return null;
  }
}

function recordsEqualIgnoringLastFetched(a, b) {
  return stableStringify(withoutLastFetched(a)) === stableStringify(withoutLastFetched(b));
}

function withoutLastFetched(record) {
  return {
    ...record,
    meta: {
      ...(record.meta ?? {}),
      lastFetched: null,
    },
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

// --- CLI entrypoint ---------------------------------------------------------
const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  const ids = process.argv.slice(2);
  if (ids.length === 0) {
    console.error('Usage: node scripts/fetch-anime.js <malId> [malId...]');
    process.exit(1);
  }

  const allErrors = [];
  for (const id of ids) {
    console.log(`Fetching MAL #${id}...`);
    const result = await fetchAnime(id);
    if (result.ok) {
      console.log(`  -> wrote ${result.filePath}${result.errors.length ? ` (with ${result.errors.length} soft error(s))` : ''}`);
    } else {
      console.error(`  -> FAILED: ${result.errors.map((e) => `${e.source}: ${e.message}`).join(' | ')}`);
    }
    allErrors.push(...result.errors);
  }

  if (allErrors.length) {
    console.log(`\n${allErrors.length} total error(s) across this run. See Discord/retry-queue handling in update-airing.js for batch runs.`);
  }
}
