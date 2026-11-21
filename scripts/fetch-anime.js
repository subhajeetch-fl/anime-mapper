/**
 * Core fetch orchestrator: given a single MAL id, queries all sources,
 * merges them according to the field-priority rules, and writes
 * data/anime/{bucket}/{id}.json.
 *
 * Folder structure:
 *  - IDs 1-999999 are placed in buckets of 1000:
 *      1-999     -> data/anime/000/{id}.json
 *      1000-1999 -> data/anime/001/{id}.json
 *      50000-50999 -> data/anime/050/{id}.json
 *      ...
 *      999000-999999 -> data/anime/999/{id}.json
 *  - IDs >= 1000000 (seven digits) go into:
 *      data/anime/other/{id}.json
 *
 * Sources:
 *  - MAL Official (api.myanimelist.net/v2) [Primary metadata: synopsis, genres, studios, score, etc.]
 *  - Kitsu API (kitsu.app) [Lazy fallback for missing fields or when MAL fails]
 *  - AniList GraphQL [Enrichment: banner, trailer, producers, color, sequence, nextAiringEpisode]
 *  - animeapi.my.id (nattadasu database) [ID mappings to other services]
 *  - Zenshin / AniZip [Per-episode data: TVDB screencaps, filler flags, dubs]
 *
 * Designed to be resilient: if an enrichment source fails, the file is
 * still written with whatever data was collected; a future smart update
 * run can backfill it.
 *
 * CLI usage:
 *   node scripts/fetch-anime.js 21
 *   node scripts/fetch-anime.js 21 813 16498   (multiple ids)
 */
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import * as malOfficial from './lib/malOfficial.js';
import * as kitsu from './lib/kitsu.js';
import * as anilist from './lib/anilist.js';
import * as idMapping from './lib/idMapping.js';
import * as Zenshin from './lib/anizip.js';
import {
  malLimiter,
  kitsuLimiter,
  aniListLimiter,
  zenshinLimiter,
} from './lib/rateLimiter.js';

const ANIME_BASE_DIR = path.resolve('data/anime');

/**
 * Return the bucket directory name for a given MAL id.
 *
 * IDs 1‑999999 are partitioned into folders of 1000 each, zero‑padded to
 * three digits. IDs ≥ 1000000 (seven digits) land in the special "other"
 * bucket.
 *
 * @param {number} id – MAL anime id (positive integer)
 * @returns {string} e.g. "000", "001", "050", "100", "999", or "other"
 */
function getBucketName(id) {
  if (id >= 1000000) return 'other';
  const bucket = Math.floor(id / 1000);
  return String(bucket).padStart(3, '0');
}

/**
 * Resolve the full path where a particular anime record should be written.
 * @param {number} id
 * @returns {string} absolute path to the JSON file
 */
function getAnimeFilePath(id) {
  const bucket = getBucketName(id);
  const dir = path.join(ANIME_BASE_DIR, bucket);
  return path.join(dir, `${id}.json`);
}

async function ensureBucketDir(id) {
  const bucket = getBucketName(id);
  const dir = path.join(ANIME_BASE_DIR, bucket);
  await mkdir(dir, { recursive: true });
}

export { getBucketName, getAnimeFilePath };

/**
 * @param {number|string} malId
 * @param {object} options
 * @param {boolean} [options.skipUnchanged=false] Do not rewrite the JSON file if meaningful data is identical.
 * @param {boolean} [options.skipWriteOnSoftError=false] Preserve the old file if enrichment sources failed.
 * @returns {Promise<{ ok: boolean, malId: number, errors: Array, filePath?: string, changed?: boolean, skippedWrite?: boolean }>}
 */
export async function fetchAnime(malId, options = {}) {
  const id = Number(malId);
  if (!Number.isInteger(id) || id <= 0) {
    return {
      ok: false,
      malId: id,
      errors: [{ id, source: 'input', message: `Invalid MAL id: ${malId}`, status: 400 }],
    };
  }
  const { skipUnchanged = false, skipWriteOnSoftError = false } = options;
  const errors = [];
  const missingSources = [];
  const recordError = (source, err) => {
    const error = {
      id,
      source,
      message: err?.message ?? String(err),
      status: err?.status ?? null,
    };
    errors.push(error);
    console.error(
      `  [error] MAL #${id} | ${source} | ` +
        `${error.status ? `HTTP ${error.status}` : 'no HTTP status'} | ${error.message}`
    );
    return error;
  };

  // --- 1. ID mapping (in-memory dictionary after first load; no sleep needed) ---
  let mappingRaw = null;
  try {
    mappingRaw = await idMapping.getMappingsByMalId(id);
  } catch (err) {
    recordError('animeApi database', err);
    missingSources.push('animeApi database');
  }
  const mappings = idMapping.normalizeMappings(mappingRaw, id);
  if (mappingRaw) {
    console.log(
      `  [source] MAL #${id} | animeApi database | AniList ID: ${mappings.anilist ?? 'none'}`
    );
  } else {
    console.warn(`  [warn] MAL #${id} | no ID mapping returned; AniList lookup will be skipped`);
    missingSources.push('animeApi database (no record)');
  }

  // --- 2. Primary (Official MAL API v2) + AniList Enrichment concurrently ---
  let malPromise = null;
  if (process.env.MAL_CLIENT_ID) {
    await malLimiter();
    malPromise = malOfficial.getAnimeById(id);
  } else {
    console.warn(`  [warn] MAL #${id} | MAL_CLIENT_ID not configured; skipping Official MAL v2`);
    recordError('MAL', new Error('MAL_CLIENT_ID environment variable not set'));
    missingSources.push('mal (no credentials)');
  }

  let anilistPromise = null;
  if (mappings.anilist) {
    await aniListLimiter();
    anilistPromise = anilist.getAnimeByMalId(id);
  }

  const [malResult, anilistResult] = await Promise.allSettled([
    malPromise ?? Promise.resolve(null),
    anilistPromise ?? Promise.resolve(null),
  ]);

  const malData =
    malPromise && malResult.status === 'fulfilled' && malResult.value
      ? malOfficial.normalizeMalOfficial(malResult.value)
      : null;

  const anilistData =
    anilistPromise && anilistResult.status === 'fulfilled' && anilistResult.value
      ? anilist.normalizeAniList(anilistResult.value)
      : null;

  if (malPromise && malResult.status === 'rejected') {
    recordError('MAL', malResult.reason);
    missingSources.push('mal');
  }

  if (anilistPromise && anilistResult.status === 'rejected') {
    recordError('AniList', anilistResult.reason);
    missingSources.push('anilist');
  } else if (!anilistPromise) {
    missingSources.push('anilist (not in ID mappings)');
  }

  // --- 3. Lazy Kitsu Fallback ---
  // Only query Kitsu if MAL was unavailable or missing important metadata fields
  const needsKitsuFallback =
    !malData || !malData.synopsis || !malData.rating || !malData.episodeLength;

  let kitsuData = null;
  if (needsKitsuFallback) {
    try {
      await kitsuLimiter();
      const kitsuRaw = mappings.kitsu
        ? await kitsu.getAnimeByKitsuId(mappings.kitsu)
        : await kitsu.getAnimeByMalId(id);
      kitsuData = kitsu.normalizeKitsu(kitsuRaw);
    } catch (err) {
      recordError('Kitsu', err);
      missingSources.push('kitsu');
    }
  } else {
    missingSources.push('kitsu (skipped - not needed)');
  }

  // Hard failure: none of the metadata providers returned data
  if (!malData && !kitsuData && !anilistData) {
    if (!errors.some((error) => error.source === 'MAL' || error.source === 'Kitsu')) {
      errors.push({
        id,
        source: 'primary',
        message: 'No MAL, Kitsu, or AniList record found for this MAL id',
        status: 404,
      });
    }
    return { ok: false, malId: id, errors };
  }

  // --- 4. Episodes: Zenshin/AniZip (AniList -> AniDB) with Kitsu fallback ---
  const anilistIdForEpisodes = mappings.anilist ?? anilistData?.anilistId ?? null;
  let episodes = {};

  if (anilistIdForEpisodes || mappings.anidb) {
    try {
      await zenshinLimiter();
      const rawEpisodes = anilistIdForEpisodes
        ? await Zenshin.getEpisodesByAniListId(anilistIdForEpisodes)
        : await Zenshin.getEpisodesByAniDbId(mappings.anidb);
      episodes = Zenshin.normalizeEpisodes(rawEpisodes);
      console.log(
        `  [episodes] MAL #${id} | Zenshin/AniZip returned ${Object.keys(episodes).length} episode(s)`
      );
    } catch (err) {
      recordError('Zenshin', err);
      missingSources.push('zenshin');
    }
  }

  // If AniZip returned no episodes, fall back to Kitsu episodes
  const kitsuIdForEpisodes = mappings.kitsu ?? kitsuData?.kitsuId ?? null;
  if (Object.keys(episodes).length === 0 && kitsuIdForEpisodes) {
    try {
      await kitsuLimiter();
      const rawKitsuEpisodes = await kitsu.getAllEpisodes(kitsuIdForEpisodes);
      episodes = kitsu.normalizeKitsuEpisodes(rawKitsuEpisodes);
      console.log(
        `  [episodes] MAL #${id} | Kitsu fallback returned ${Object.keys(episodes).length} episode(s)`
      );
      if (Object.keys(episodes).length > 0) {
        missingSources.push('kitsu-episodes (fallback)');
      } else {
        missingSources.push('episodes (no data from Zenshin or Kitsu)');
      }
    } catch (err) {
      recordError('Kitsu episodes', err);
      missingSources.push('kitsu-episodes');
    }
  }

  // --- 5. Merge into final schema -----------------------------------------
  const genres = dedupeCaseInsensitive([
    ...(malData?.genres ?? []),
    ...(anilistData?.genres ?? []),
    ...(kitsuData?.genres ?? []),
  ]);

  const studios = dedupeCaseInsensitive([
    ...(malData?.studios ?? []),
    ...(anilistData?.studios ?? []),
  ]);

  const record = {
    id,
    idMal: id,
    mappings,
    title: {
      romaji: anilistData?.titles?.romaji ?? malData?.titles?.default ?? kitsuData?.titles?.romaji ?? null,
      english: malData?.titles?.english ?? anilistData?.titles?.english ?? kitsuData?.titles?.english ?? null,
      native: anilistData?.titles?.native ?? malData?.titles?.japanese ?? kitsuData?.titles?.japanese ?? null,
      synonyms: dedupeCaseInsensitive([
        ...(malData?.titles?.synonyms ?? []),
        ...(anilistData?.synonyms ?? []),
      ]),
    },
    type: malData?.type ?? anilistData?.format ?? null,
    source: malData?.source ?? anilistData?.source ?? null,
    status: malData?.status ?? kitsuData?.status ?? anilistData?.status ?? null,
    airing: malData?.airing ?? (anilistData?.status === 'RELEASING'),
    episodeCount: malData?.episodeCount ?? kitsuData?.episodeCount ?? anilistData?.episodeCount ?? null,
    episodeLength: malData?.episodeLength ?? kitsuData?.episodeLength ?? anilistData?.duration ?? null,
    aired: {
      from: malData?.aired?.from ?? kitsuData?.startDate ?? anilistData?.aired?.from ?? null,
      to: malData?.aired?.to ?? kitsuData?.endDate ?? anilistData?.aired?.to ?? null,
    },
    season: malData?.season ?? anilistData?.season?.toLowerCase() ?? null,
    year: malData?.year ?? anilistData?.seasonYear ?? null,
    broadcast: malData?.broadcast ?? null,
    nextAiringEpisode: anilistData?.nextAiringEpisode ?? null,
    rating: malData?.rating ?? kitsuData?.ageRating ?? null,
    score: {
      malScore: malData?.score ?? null,
      anilistScore: anilistData?.averageScore ?? null,
      kitsuRating: kitsuData?.averageRating ?? null,
    },
    genres,
    studios,
    producers: anilistData?.producers ?? [],
    images: {
      poster: malData?.images?.poster ?? kitsuData?.posterImage ?? anilistData?.coverImage ?? null,
      banner: anilistData?.bannerImage ?? kitsuData?.coverImage ?? null,
      color: anilistData?.coverColor ?? null,
    },
    trailer: anilistData?.trailer ?? null,
    synopsis: malData?.synopsis ?? kitsuData?.synopsis ?? anilistData?.synopsis ?? null,
    sequence: anilistData?.sequence ?? [],
    episodes,
    meta: {
      lastFetched: new Date().toISOString(),
      sourcesUsed: ['mal', 'kitsu', 'anilist', 'animeApi database', 'zenshin'].filter(
        (s) => !missingSources.includes(s) && !missingSources.some((m) => m.startsWith(s))
      ),
      missingSources,
      dataVersion: 1,
    },
  };

  await ensureBucketDir(id);
  const filePath = getAnimeFilePath(id);

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
    await access(filePath);
    return true;
  } catch {
    return false;
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
  const args = process.argv.slice(2);
  if (args.includes('--test-buckets')) {
    const testIds = [0, 1, 2, 999, 1000, 1001, 1999, 2000, 2999, 3000, 5000, 9999, 10000, 10999, 11000, 20000, 20999, 50000, 50999, 99000, 99999, 100000, 100999, 200000, 500000, 999000, 999999, 1000000, 1000001, 2000000];
    console.log('Bucket mapping test:');
    for (const id of testIds) {
      console.log(`  ID ${String(id).padStart(7)} => bucket "${getBucketName(id)}"`);
    }
    process.exit(0);
  }

  const ids = args.filter((a) => !a.startsWith('--'));
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
