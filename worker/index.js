/**
 * Anime Mapper — Search API for Cloudflare Workers (D1-backed + short keys)
 *
 * Storage:
 *   D1 database bound as `env.DB` (configured in wrangler.toml).
 *   Columns use 1-3 char short names to save space.
 *
 * API contract (unchanged from v2):
 *   All public endpoints return long field names so existing clients keep working.
 *
 * v3.1.0 changelog (fixes /api/search 500 + related bugs):
 *   - rowToShortEntry: JSON.parse on g/stu/pro no longer throws on malformed data.
 *     A single corrupt row used to abort the ENTIRE catalog load (loadSearchIndex
 *     rejects -> every endpoint 503s). Now it logs a warning and falls back to []
 *     for that field only, so one bad row can't take the whole API down.
 *   - handleSearch: was reading params.sort / params.order / params.page / params.limit
 *     directly off a URLSearchParams object, which has no such properties (only
 *     .get()). Those always evaluated to undefined and silently fell back to
 *     defaults -- so ?sort=year, ?order=asc, ?page=2, ?limit=10 were all being
 *     ignored. Fixed to use params.get(...) consistently, same as parseFilters.
 *   - searchTitle ('se') matching: query text was normalized (lowercased, accents
 *     stripped) via normalizeText(), but anime.searchTitle was compared raw. Since
 *     se is inconsistently cased/scripted in the data, this silently missed
 *     matches. Fixed by precomputing a normalized se once per row at load time
 *     (cheap, done once per 5-min cache window) and comparing normalized-to-normalized.
 *   - sortResults: numeric fields (score/popularity/year/episodes) are now coerced
 *     with Number(...) before comparison, so a field that's accidentally stored as
 *     a string in D1 (e.g. "7.2") sorts numerically instead of lexicographically.
 *   - Errors are now logged server-side with context (which endpoint, which row id
 *     if applicable) before returning the generic client-facing message, so future
 *     issues are diagnosable from `wrangler tail` instead of being a black box.
 */

// ============================================================================
// Configuration
// ============================================================================

const CACHE = {
  rawDataMaxAge: 1200,
  rawDataSMaxAge: 3600,
  rawDataStaleRevalidate: 7200,
  responseMaxAge: 86400,
  responseSMaxAge: 43200,
};

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 24;
const VERSION = '3.1.0';

// ============================================================================
// Short <-> Long Key Mapping
// ============================================================================

const SHORT_TO_LONG = {
  id: 'id',
  t: 'title',
  rT: 'romajiTitle',
  nT: 'nativeTitle',
  y: 'year',
  s: 'season',
  ty: 'type',
  st: 'status',
  eC: 'episodeCount',
  img: 'image',
  sc: 'score',
  uA: 'updatedAt',
  g: 'genres',
  stu: 'studios',
  pro: 'producers',
  r: 'rating',
  se: 'searchTitle',
  pop: 'popularity',
};

const LONG_TO_SHORT = Object.fromEntries(
  Object.entries(SHORT_TO_LONG).map(([s, l]) => [l, s])
);

function expandKeys(shortEntry) {
  if (!shortEntry || typeof shortEntry !== 'object') return null;
  const out = {};
  for (const [shortKey, value] of Object.entries(shortEntry)) {
    const longKey = SHORT_TO_LONG[shortKey];
    if (longKey) {
      out[longKey] = value;
    }
  }
  return out;
}

function compressKeys(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const out = {};
  for (const [key, value] of Object.entries(entry)) {
    // If key is already short, preserve it
    if (key in SHORT_TO_LONG) {
      out[key] = value;
      continue;
    }
    // If key is long, compress to short
    const shortKey = LONG_TO_SHORT[key];
    if (shortKey) {
      out[shortKey] = value;
    }
  }
  return out;
}

// Safely parse a JSON array column (g/stu/pro). D1 can return malformed,
// truncated, or non-array JSON in these columns if a bad sync ever slipped
// through -- this must NEVER throw, since it runs on every row on every
// catalog load. A single corrupt row falling back to [] is far better than
// the entire catalog (and every endpoint) going down.
function safeParseArray(value, context) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
    console.warn(`[safeParseArray] Expected array but got ${typeof parsed} for ${context}. Raw: ${String(value).slice(0, 120)}`);
    return [];
  } catch (e) {
    console.warn(`[safeParseArray] JSON.parse failed for ${context}: ${e.message}. Raw: ${String(value).slice(0, 120)}`);
    return [];
  }
}

// D1 row → short-key object (arrays stored as JSON strings in g/stu/pro)
function rowToShortEntry(row) {
  return {
    id: row.id,
    t: row.t,
    rT: row.rT,
    nT: row.nT,
    y: row.y,
    s: row.s,
    ty: row.ty,
    st: row.st,
    eC: row.eC,
    img: row.img,
    sc: row.sc,
    uA: row.uA,
    g: safeParseArray(row.g, `genres (id=${row.id})`),
    stu: safeParseArray(row.stu, `studios (id=${row.id})`),
    pro: safeParseArray(row.pro, `producers (id=${row.id})`),
    r: row.r,
    se: row.se,
    pop: row.pop,
  };
}

function entryToD1Map(entry) {
  // Normalize: accept both short and long keys in admin input
  const shortEntry = compressKeys(entry) || entry;
  return {
    id: shortEntry.id ?? null,
    t: shortEntry.t ?? null,
    rT: shortEntry.rT ?? null,
    nT: shortEntry.nT ?? null,
    y: shortEntry.y ?? null,
    s: shortEntry.s ?? null,
    ty: shortEntry.ty ?? null,
    st: shortEntry.st ?? null,
    eC: shortEntry.eC ?? null,
    img: shortEntry.img ?? null,
    sc: shortEntry.sc ?? null,
    uA: shortEntry.uA ?? null,
    g: shortEntry.g && shortEntry.g.length ? JSON.stringify(shortEntry.g) : null,
    stu: shortEntry.stu && shortEntry.stu.length ? JSON.stringify(shortEntry.stu) : null,
    pro: shortEntry.pro && shortEntry.pro.length ? JSON.stringify(shortEntry.pro) : null,
    r: shortEntry.r ?? null,
    se: shortEntry.se ?? null,
    pop: shortEntry.pop ?? null,
  };
}

// ============================================================================
// In-memory isolate cache
// ============================================================================

let _searchIndex = null;
let _indexPromise = null;
let _lastLoadTime = 0;
let _filterOptionsCache = null;
let _statsCache = null;
const ISOLATE_CACHE_TTL = 300000; // 5 min

// ============================================================================
// Utility functions
// ============================================================================

// NOTE: uses the explicit \u0300-\u036f unicode range for combining diacritical
// marks. A literal character in this spot (rather than the escape) can silently
// stop matching entirely depending on how the file gets saved/transferred, so
// the escape form is used everywhere below to guarantee it survives intact.
const DIACRITICS_RE = /[\u0300-\u036f]/g;

function toKebabCase(str) {
  if (!str) return '';
  return str
    .normalize('NFD').replace(DIACRITICS_RE, '')
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeText(str) {
  if (!str) return '';
  return String(str).normalize('NFD').replace(DIACRITICS_RE, '').toLowerCase().trim();
}

function parseList(val) {
  if (!val || typeof val !== 'string') return [];
  return val.split(',').map((s) => s.trim()).filter(Boolean);
}

function parseIntSafe(val, fallback) {
  if (val === undefined || val === null || val === '') return fallback;
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? fallback : n;
}

function parseFloatSafe(val, fallback) {
  if (val === undefined || val === null || val === '') return fallback;
  const n = parseFloat(val);
  return Number.isNaN(n) ? fallback : n;
}

// Coerce a value that's SUPPOSED to be numeric but might have been stored/passed
// as a string (D1 columns are dynamically typed; a bad admin sync could insert
// "7.2" instead of 7.2). Returns null (not NaN) for anything unusable so callers
// can treat it the same as a missing value.
function toNumberOrNull(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) dp[i][0] = i;
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

// query and target are expected to ALREADY be normalizeText()'d by the caller.
// Kept this way so normalization happens once per row at load time (see
// buildNormalizedSearchFields) rather than being recomputed on every fuzzyMatch
// call across every search request.
function fuzzyMatchNormalized(normQuery, normTarget, threshold) {
  if (!normQuery || !normTarget) return false;
  if (normTarget.includes(normQuery)) return true;
  if (normQuery.length <= 3) return false;
  const dist = levenshteinDistance(normQuery, normTarget);
  return dist / Math.max(normQuery.length, normTarget.length) <= (threshold || 0.3);
}

// ============================================================================
// Data Loading (D1 → expand → in-memory cache)
// ============================================================================

// Precompute normalized versions of every searchable text field, once per row,
// once per cache window -- instead of re-normalizing on every fuzzyMatch call
// for every request. This is also the fix for the "se is sometimes lowercase,
// sometimes Japanese, sometimes capital" issue: both sides of every comparison
// go through the exact same normalizeText(), so casing/script differences in
// the stored data no longer cause missed matches.
function attachNormalizedSearchFields(entry) {
  entry._normSe = normalizeText(entry.searchTitle);
  entry._normTitle = normalizeText(entry.title);
  entry._normRomaji = normalizeText(entry.romajiTitle);
  entry._normNative = normalizeText(entry.nativeTitle);
  return entry;
}

async function loadSearchIndex(env, ctx) {
  const now = Date.now();

  // 1. In-memory isolate cache
  if (_searchIndex && now - _lastLoadTime < ISOLATE_CACHE_TTL) {
    return _searchIndex;
  }

  // 2. Load from D1
  if (!env.DB) {
    throw new Error('D1 database not bound (env.DB is missing)');
  }

  let results;
  try {
    const queryResult = await env.DB.prepare('SELECT * FROM anime').all();
    results = queryResult.results;
  } catch (e) {
    console.error('[loadSearchIndex] D1 query failed:', e.message || e);
    throw new Error(`D1 query failed: ${e.message || 'unknown error'}`);
  }

  if (!results || results.length === 0) {
    // Graceful empty start
    _searchIndex = [];
    _lastLoadTime = now;
    _filterOptionsCache = null;
    _statsCache = null;
    return _searchIndex;
  }

  // Convert D1 rows → short keys → long keys, keep in memory.
  // Each row is processed independently so one malformed row (bad JSON in
  // g/stu/pro, unexpected null, etc.) can't abort the load for every other
  // row. rowToShortEntry itself no longer throws on bad JSON (see
  // safeParseArray), but this per-row try/catch is a second layer of defense
  // in case of some other unexpected shape -- a row that fails is logged and
  // skipped rather than taking down the whole catalog.
  const index = [];
  let skipped = 0;
  for (const row of results) {
    try {
      const shortEntry = rowToShortEntry(row);
      const longEntry = expandKeys(shortEntry);
      if (longEntry) {
        index.push(attachNormalizedSearchFields(longEntry));
      }
    } catch (e) {
      skipped++;
      console.error(`[loadSearchIndex] Skipping row id=${row?.id ?? 'unknown'} due to processing error:`, e.message || e);
    }
  }

  if (skipped > 0) {
    console.warn(`[loadSearchIndex] Loaded ${index.length} rows, skipped ${skipped} malformed row(s).`);
  }

  _searchIndex = index;
  _lastLoadTime = now;
  _filterOptionsCache = null;
  _statsCache = null;
  return _searchIndex;
}

function safeCache() {
  try { return caches.default; } catch (_) { return null; }
}

// ============================================================================
// Filter Engine
// ============================================================================

function parseFilters(params) {
  // Support both URLSearchParams (Cloudflare Workers) and plain objects
  const get = (key) => {
    if (params && typeof params.get === 'function') return params.get(key);
    return params[key];
  };

  return {
    q: normalizeText(get('q') || ''),
    genres: parseList(get('genre')).map(toKebabCase),
    studios: parseList(get('studio')).map(toKebabCase),
    producers: parseList(get('producer')).map(toKebabCase),
    type: get('type') || null,
    status: get('status') || null,
    rating: get('rating') || null,
    yearMin: parseIntSafe(get('year_min'), null),
    yearMax: parseIntSafe(get('year_max'), null),
    scoreMin: parseFloatSafe(get('score_min'), null),
    scoreMax: parseFloatSafe(get('score_max'), null),
    episodesMin: parseIntSafe(get('episodes_min'), null),
    episodesMax: parseIntSafe(get('episodes_max'), null),
  };
}

function matchesFilters(anime, filters) {
  if (filters.q) {
    // filters.q is already normalizeText()'d in parseFilters. Compare against
    // the precomputed normalized fields (see attachNormalizedSearchFields) so
    // casing/script inconsistencies in the stored data (se sometimes lowercase,
    // sometimes Japanese, sometimes capitalized) no longer cause missed matches.
    const hasMatch =
      (anime._normSe && anime._normSe.includes(filters.q)) ||
      fuzzyMatchNormalized(filters.q, anime._normTitle) ||
      fuzzyMatchNormalized(filters.q, anime._normRomaji) ||
      fuzzyMatchNormalized(filters.q, anime._normNative);
    if (!hasMatch) return false;
  }

  if (filters.genres.length > 0) {
    const animeGenres = (anime.genres || []).map(toKebabCase);
    if (!filters.genres.some((g) => animeGenres.includes(g))) return false;
  }

  if (filters.studios.length > 0) {
    const animeStudios = (anime.studios || []).map(toKebabCase);
    if (!filters.studios.some((s) => animeStudios.includes(s))) return false;
  }

  if (filters.producers.length > 0) {
    const animeProducers = (anime.producers || []).map(toKebabCase);
    if (!filters.producers.some((p) => animeProducers.includes(p))) return false;
  }

  if (filters.type) {
    const nt = normalizeText(filters.type);
    const at = normalizeText(anime.type || '');
    if (!at.includes(nt)) return false;
  }

  if (filters.status) {
    const ns = normalizeText(filters.status);
    const ast = normalizeText(anime.status || '');
    if (!ast.includes(ns)) return false;
  }

  if (filters.rating) {
    const nr = normalizeText(filters.rating);
    const ar = normalizeText(anime.rating || '');
    if (!ar.includes(nr)) return false;
  }

  const year = toNumberOrNull(anime.year);
  const score = toNumberOrNull(anime.score);
  const episodes = toNumberOrNull(anime.episodeCount);

  if (filters.yearMin != null && (year == null || year < filters.yearMin)) return false;
  if (filters.yearMax != null && (year == null || year > filters.yearMax)) return false;
  if (filters.scoreMin != null && (score == null || score < filters.scoreMin)) return false;
  if (filters.scoreMax != null && (score == null || score > filters.scoreMax)) return false;
  if (filters.episodesMin != null && (episodes == null || episodes < filters.episodesMin)) return false;
  if (filters.episodesMax != null && (episodes == null || episodes > filters.episodesMax)) return false;

  return true;
}

// ============================================================================
// Sorting & Pagination
// ============================================================================

const VALID_SORTS = ['score', 'popularity', 'year', 'title', 'episodes', 'updatedAt', 'id'];

function sortResults(results, sortKey, order) {
  const direction = order === 'asc' ? 1 : -1;
  // Numeric fields are coerced with toNumberOrNull so a value that's accidentally
  // stored as a string in D1 (e.g. "7.2") still sorts numerically instead of
  // lexicographically (which would put "10" before "9").
  const getValue = (a, key) => {
    switch (key) {
      case 'score': return toNumberOrNull(a.score) ?? -Infinity;
      case 'popularity': return toNumberOrNull(a.popularity) ?? -Infinity;
      case 'year': return toNumberOrNull(a.year) ?? -Infinity;
      case 'title': return (a.title || '').toLowerCase();
      case 'episodes': return toNumberOrNull(a.episodeCount) ?? -Infinity;
      case 'updatedAt': {
        if (!a.updatedAt) return -Infinity;
        const t = new Date(a.updatedAt).getTime();
        return Number.isFinite(t) ? t : -Infinity;
      }
      case 'id': return toNumberOrNull(a.id) ?? -Infinity;
      default: return toNumberOrNull(a.score) ?? -Infinity;
    }
  };

  results.sort((a, b) => {
    const av = getValue(a, sortKey);
    const bv = getValue(b, sortKey);
    if (av === bv) return (toNumberOrNull(a.id) ?? 0) - (toNumberOrNull(b.id) ?? 0);
    return direction * (av > bv ? 1 : -1);
  });
  return results;
}

function paginateResults(results, page, limit) {
  const total = results.length;
  const totalPages = Math.ceil(total / limit);
  const safePage = Math.max(1, Math.min(page, totalPages || 1));
  const start = (safePage - 1) * limit;
  const items = results.slice(start, start + limit);

  return {
    items,
    pagination: {
      page: safePage,
      limit,
      total,
      totalPages: totalPages || 0,
      hasNext: safePage < totalPages,
      hasPrev: safePage > 1,
    },
  };
}

// Strip the internal _norm* fields (and any other underscore-prefixed internal
// fields) before sending an entry back to the client -- they're an
// implementation detail of the search index, not part of the public API
// contract.
function stripInternalFields(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const out = {};
  for (const [key, value] of Object.entries(entry)) {
    if (!key.startsWith('_')) out[key] = value;
  }
  return out;
}

// ============================================================================
// Metadata builders
// ============================================================================

function buildFilterOptions(index) {
  if (_filterOptionsCache) return _filterOptionsCache;
  const genres = new Set(), studios = new Set(), producers = new Set();
  const types = new Set(), statuses = new Set(), ratings = new Set();
  let minYear = Infinity, maxYear = -Infinity, minScore = Infinity, maxScore = -Infinity;
  let minEpisodes = Infinity, maxEpisodes = -Infinity;

  for (const anime of index) {
    anime.genres?.forEach((g) => genres.add(g));
    anime.studios?.forEach((s) => studios.add(s));
    anime.producers?.forEach((p) => producers.add(p));
    if (anime.type) types.add(anime.type);
    if (anime.status) statuses.add(anime.status);
    if (anime.rating) ratings.add(anime.rating);

    const year = toNumberOrNull(anime.year);
    const score = toNumberOrNull(anime.score);
    const episodes = toNumberOrNull(anime.episodeCount);

    if (year != null) { minYear = Math.min(minYear, year); maxYear = Math.max(maxYear, year); }
    if (score != null) { minScore = Math.min(minScore, score); maxScore = Math.max(maxScore, score); }
    if (episodes != null) { minEpisodes = Math.min(minEpisodes, episodes); maxEpisodes = Math.max(maxEpisodes, episodes); }
  }

  _filterOptionsCache = {
    genres: [...genres].sort(), studios: [...studios].sort(), producers: [...producers].sort(),
    types: [...types].sort(), statuses: [...statuses].sort(), ratings: [...ratings].sort(),
    yearRange: { min: minYear === Infinity ? null : minYear, max: maxYear === -Infinity ? null : maxYear },
    scoreRange: { min: minScore === Infinity ? null : minScore, max: maxScore === -Infinity ? null : maxScore },
    episodesRange: { min: minEpisodes === Infinity ? null : minEpisodes, max: maxEpisodes === -Infinity ? null : maxEpisodes },
    total: index.length,
  };
  return _filterOptionsCache;
}

function buildStats(index) {
  if (_statsCache) return _statsCache;
  const byType = {}, byStatus = {}, byRating = {}, byYear = {}, bySeason = {};
  const genreCounts = {}, studioCounts = {};
  let totalScore = 0, scoreCount = 0, minScore = Infinity, maxScore = -Infinity;

  for (const anime of index) {
    if (anime.type) byType[anime.type] = (byType[anime.type] || 0) + 1;
    if (anime.status) byStatus[anime.status] = (byStatus[anime.status] || 0) + 1;
    if (anime.rating) byRating[anime.rating] = (byRating[anime.rating] || 0) + 1;

    const year = toNumberOrNull(anime.year);
    const score = toNumberOrNull(anime.score);

    if (year != null) byYear[year] = (byYear[year] || 0) + 1;
    if (anime.season) bySeason[anime.season] = (bySeason[anime.season] || 0) + 1;
    anime.genres?.forEach((g) => { genreCounts[g] = (genreCounts[g] || 0) + 1; });
    anime.studios?.forEach((s) => { studioCounts[s] = (studioCounts[s] || 0) + 1; });
    if (score != null) { totalScore += score; scoreCount++; minScore = Math.min(minScore, score); maxScore = Math.max(maxScore, score); }
  }

  const topGenres = Object.entries(genreCounts).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([genre, count]) => ({ genre, count }));
  const topStudios = Object.entries(studioCounts).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([studio, count]) => ({ studio, count }));

  _statsCache = {
    total: index.length,
    byType, byStatus, byRating,
    byYear: Object.entries(byYear).sort((a, b) => b[0] - a[0]).slice(0, 30).map(([year, count]) => ({ year: +year, count })),
    bySeason,
    topGenres,
    topStudios,
    scoreDistribution: {
      avg: scoreCount > 0 ? totalScore / scoreCount : null,
      min: minScore === Infinity ? null : minScore,
      max: maxScore === -Infinity ? null : maxScore,
    },
  };
  return _statsCache;
}

// ============================================================================
// Response helpers
// ============================================================================

function jsonResponse(data, status) {
  status = status || 200;
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${CACHE.responseMaxAge}, immutable, s-maxage=${CACHE.responseSMaxAge}, stale-while-revalidate=604800`,
      'Vary': 'Accept-Encoding',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function errorResponse(message, status, details) {
  status = status || 500;
  return new Response(JSON.stringify({ error: message, ...(details ? { details } : {}), timestamp: new Date().toISOString() }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// ============================================================================
// Admin Auth
// ============================================================================

function isAuthorized(request, env) {
  const apiKey = request.headers.get('x-api-key') || request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  return apiKey && env.API_KEY && apiKey === env.API_KEY;
}

function unauthorizedResponse() {
  return errorResponse('Unauthorized', 401);
}

// ============================================================================
// Admin Handlers
// ============================================================================

// POST /api/admin/sync — batch upsert from request body
async function handleAdminSync(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  if (!Array.isArray(body)) {
    return errorResponse('Expected an array of anime entries', 400);
  }

  if (body.length === 0) {
    return jsonResponse({ inserted: 0, updated: 0, total: 0 });
  }

  // Validate all entries have an id
  for (let i = 0; i < body.length; i++) {
    const id = body[i]?.id ?? body[i]?.i;
    if (!Number.isInteger(id)) {
      return errorResponse(`Entry at index ${i} is missing a valid id`, 400);
    }
  }

  // Batch upsert in chunks of 100 (D1 batch limit)
  const CHUNK_SIZE = 100;
  let totalInserted = 0;
  let totalUpdated = 0;

  try {
    for (let i = 0; i < body.length; i += CHUNK_SIZE) {
      const chunk = body.slice(i, i + CHUNK_SIZE);

      const statements = chunk.map((entry) => {
        const data = entryToD1Map(entry);
        const stmt = env.DB.prepare(
          `INSERT INTO anime(id, t, rT, nT, y, s, ty, st, eC, img, sc, uA, g, stu, pro, r, se, pop)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
           ON CONFLICT(id) DO UPDATE SET
             t = excluded.t, rT = excluded.rT, nT = excluded.nT, y = excluded.y, s = excluded.s,
             ty = excluded.ty, st = excluded.st, eC = excluded.eC, img = excluded.img,
             sc = excluded.sc, uA = excluded.uA, g = excluded.g, stu = excluded.stu,
             pro = excluded.pro, r = excluded.r, se = excluded.se, pop = excluded.pop`
        );
        return stmt.bind(
          data.id, data.t, data.rT, data.nT, data.y, data.s, data.ty, data.st,
          data.eC, data.img, data.sc, data.uA, data.g, data.stu, data.pro,
          data.r, data.se, data.pop
        );
      });

      await env.DB.batch(statements);

      // Approximation: first chunk = inserts, subsequent = updates (since they likely exist)
      if (i === 0) {
        totalInserted += chunk.length;
      } else {
        totalUpdated += chunk.length;
      }
    }
  } catch (e) {
    console.error('[handleAdminSync] D1 batch write failed:', e.message || e);
    return errorResponse('Database write failed during sync', 500);
  }

  // Invalidate in-memory cache so next request fetches fresh data
  _searchIndex = null;
  _lastLoadTime = 0;
  _filterOptionsCache = null;
  _statsCache = null;

  return jsonResponse({
    inserted: totalInserted,
    updated: totalUpdated,
    total: body.length,
    message: 'Sync complete. Cache invalidated.',
  });
}

// GET /api/admin/stale?days=15&limit=1000
async function handleAdminStale(url, env) {
  const days = Math.max(1, Math.min(365, parseIntSafe(url.searchParams.get('days'), 15)));
  const limit = Math.max(1, Math.min(5000, parseIntSafe(url.searchParams.get('limit'), 1000)));

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  let results;
  try {
    const queryResult = await env.DB.prepare(
      'SELECT * FROM anime WHERE uA < ?1 ORDER BY uA ASC LIMIT ?2'
    ).all(cutoff, limit);
    results = queryResult.results;
  } catch (e) {
    console.error('[handleAdminStale] D1 query failed:', e.message || e);
    return errorResponse('Database query failed', 500);
  }

  const items = [];
  for (const row of results || []) {
    try {
      items.push(expandKeys(rowToShortEntry(row)));
    } catch (e) {
      console.error(`[handleAdminStale] Skipping row id=${row?.id ?? 'unknown'}:`, e.message || e);
    }
  }

  return jsonResponse({
    days,
    cutoff,
    count: items.length,
    items,
  });
}

// POST /api/admin/update — single anime upsert
async function handleAdminUpdate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body', 400);
  }

  if (!body || typeof body !== 'object' || body.id == null) {
    return errorResponse('Anime entry with id is required', 400);
  }

  const data = entryToD1Map(body);

  try {
    await env.DB.prepare(
      `INSERT INTO anime(id, t, rT, nT, y, s, ty, st, eC, img, sc, uA, g, stu, pro, r, se, pop)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
       ON CONFLICT(id) DO UPDATE SET
         t = excluded.t, rT = excluded.rT, nT = excluded.nT, y = excluded.y, s = excluded.s,
         ty = excluded.ty, st = excluded.st, eC = excluded.eC, img = excluded.img,
         sc = excluded.sc, uA = excluded.uA, g = excluded.g, stu = excluded.stu,
         pro = excluded.pro, r = excluded.r, se = excluded.se, pop = excluded.pop`
    ).bind(
      data.id, data.t, data.rT, data.nT, data.y, data.s, data.ty, data.st,
      data.eC, data.img, data.sc, data.uA, data.g, data.stu, data.pro,
      data.r, data.se, data.pop
    ).run();
  } catch (e) {
    console.error(`[handleAdminUpdate] D1 write failed for id=${data.id}:`, e.message || e);
    return errorResponse('Database write failed', 500);
  }

  // Invalidate cache
  _searchIndex = null;
  _lastLoadTime = 0;
  _filterOptionsCache = null;
  _statsCache = null;

  let expanded;
  try {
    expanded = expandKeys(rowToShortEntry({ ...data, g: data.g, stu: data.stu, pro: data.pro }));
  } catch (e) {
    console.error(`[handleAdminUpdate] Write succeeded but failed to build response for id=${data.id}:`, e.message || e);
    // The write itself succeeded -- don't fail the request over a response-formatting issue.
    expanded = { id: data.id };
  }

  return jsonResponse({ message: 'Updated', anime: expanded });
}

// GET /api/admin/check?ids=1,2,3
async function handleAdminCheck(url, env) {
  const idsParam = url.searchParams.get('ids');
  if (!idsParam) return errorResponse('ids param required (comma-separated)', 400);

  const ids = idsParam
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);

  if (ids.length === 0) return errorResponse('No valid ids provided', 400);
  if (ids.length > 5000) return errorResponse('Max 5,000 ids per request', 400);

  // Query in chunks (D1 parameter limit ~100)
  const present = new Set();
  const chunkSize = 100;

  try {
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const { results } = await env.DB.prepare(
        `SELECT id FROM anime WHERE id IN (${placeholders})`
      ).all(...chunk);
      (results || []).forEach((row) => present.add(row.id));
    }
  } catch (e) {
    console.error('[handleAdminCheck] D1 query failed:', e.message || e);
    return errorResponse('Database query failed', 500);
  }

  const missing = ids.filter((id) => !present.has(id));

  return jsonResponse({
    present: [...present],
    missing,
    totalChecked: ids.length,
  });
}

// ============================================================================
// Public Route Handlers
// ============================================================================

function handleRoot() {
  return jsonResponse({
    name: 'Anime Mapper Search API',
    version: VERSION,
    description: 'Advanced anime search with Cloudflare Workers + D1',
    endpoints: {
      search: '/api/search?q=&genre=&studio=&producer=&type=&status=&rating=&year_min=&year_max=&score_min=&score_max=&episodes_min=&episodes_max=&sort=&order=&page=&limit=',
      anime: '/api/anime/:id',
      meta: '/api/meta/{genres|studios|producers|types|statuses|ratings|years|all}',
      stats: '/api/stats',
      health: '/api/health',
    },
    limits: { maxLimit: MAX_LIMIT, defaultLimit: DEFAULT_LIMIT },
    cache: 'In-memory isolate + D1 + Edge Cache API',
  });
}

async function handleSearch(searchParams, searchIndex) {
  const filters = parseFilters(searchParams);

  // Fixed: was reading params.sort / params.order / params.page / params.limit
  // as plain properties on a URLSearchParams object (always undefined, since
  // URLSearchParams only exposes values via .get()). Now consistently uses
  // .get(), matching how parseFilters already reads every other param.
  const rawSort = (searchParams.get('sort') || 'popularity').toLowerCase();
  const sort = VALID_SORTS.includes(rawSort) ? rawSort : 'popularity';
  const order = (searchParams.get('order') || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';

  const page = Math.max(1, parseIntSafe(searchParams.get('page'), 1));
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseIntSafe(searchParams.get('limit'), DEFAULT_LIMIT)));

  let results = searchIndex.filter((anime) => matchesFilters(anime, filters));
  results = sortResults(results, sort, order);
  const paginated = paginateResults(results, page, limit);

  return jsonResponse({
    data: paginated.items.map(stripInternalFields),
    pagination: paginated.pagination,
    meta: { query: { ...filters, sort, order, limit, page } },
  });
}

async function handleAnimeById(path, searchIndex) {
  const match = path.match(/\/(\d+)$/);
  if (!match) return errorResponse('Not found', 404);

  const id = parseInt(match[1], 10);
  if (Number.isNaN(id)) return errorResponse('Invalid anime ID', 400);

  const anime = searchIndex.find((a) => a.id === id);
  if (!anime) return jsonResponse({ error: 'Anime not found', id }, 404);

  return jsonResponse({ data: stripInternalFields(anime) });
}

async function handleMeta(path, searchIndex) {
  const parts = path.split('/');
  const metaType = parts[parts.length - 1];
  const options = buildFilterOptions(searchIndex);

  switch (metaType) {
    case 'genres': return jsonResponse({ data: options.genres, total: options.genres.length });
    case 'studios': return jsonResponse({ data: options.studios, total: options.studios.length });
    case 'producers': return jsonResponse({ data: options.producers, total: options.producers.length });
    case 'types': return jsonResponse({ data: options.types, total: options.types.length });
    case 'statuses': return jsonResponse({ data: options.statuses, total: options.statuses.length });
    case 'ratings': return jsonResponse({ data: options.ratings, total: options.ratings.length });
    case 'years':
      return jsonResponse({
        data: {
          min: options.yearRange.min,
          max: options.yearRange.max,
          decades: [...new Set(
            searchIndex
              .map((a) => toNumberOrNull(a.year))
              .filter((y) => y != null)
              .map((y) => Math.floor(y / 10) * 10)
          )].sort((a, b) => b - a),
        },
      });
    case 'all':
      return jsonResponse({
        data: {
          genres: options.genres, studios: options.studios, producers: options.producers,
          types: options.types, statuses: options.statuses, ratings: options.ratings,
          yearRange: options.yearRange, scoreRange: options.scoreRange,
          episodesRange: options.episodesRange, total: options.total,
        },
      });
    default:
      return errorResponse(`Meta type "${metaType}" not found`, 404);
  }
}

// ============================================================================
// Main Router
// ============================================================================

async function routeRequest(request, env, ctx) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Admin routes (no searchIndex pre-load needed for these)
  if (pathname === '/api/admin/sync' && request.method === 'POST') {
    if (!isAuthorized(request, env)) return unauthorizedResponse();
    return handleAdminSync(request, env);
  }

  if (pathname === '/api/admin/stale') {
    if (!isAuthorized(request, env)) return unauthorizedResponse();
    return handleAdminStale(url, env);
  }

  if (pathname === '/api/admin/update' && request.method === 'POST') {
    if (!isAuthorized(request, env)) return unauthorizedResponse();
    return handleAdminUpdate(request, env);
  }

  if (pathname === '/api/admin/check') {
    if (!isAuthorized(request, env)) return unauthorizedResponse();
    return handleAdminCheck(url, env);
  }

  // Public routes (need searchIndex)
  let searchIndex;
  try {
    searchIndex = await loadSearchIndex(env, ctx);
  } catch (err) {
    console.error('[Worker] Failed to load search index:', err.message || err);
    return errorResponse('Failed to load catalog data', 503);
  }

  if (!searchIndex || !Array.isArray(searchIndex)) {
    return errorResponse('Catalog data is unavailable', 503);
  }

  if (pathname === '/' || pathname === '/api/' || pathname === '/api') {
    return handleRoot();
  }

  if (pathname === '/api/search') {
    return handleSearch(url.searchParams, searchIndex);
  }

  if (pathname.startsWith('/api/anime/')) {
    return handleAnimeById(pathname, searchIndex);
  }

  if (pathname.startsWith('/api/meta/')) {
    return handleMeta(pathname, searchIndex);
  }

  if (pathname === '/api/stats') {
    return jsonResponse({ data: buildStats(searchIndex) });
  }

  if (pathname === '/api/health') {
    return jsonResponse({
      status: 'ok', version: VERSION, uptime: 'healthy',
      catalogSize: searchIndex.length,
      cache: 'D1-backed + in-memory isolate cache active',
      timestamp: new Date().toISOString(),
    });
  }

  return errorResponse('Not found', 404);
}

// ============================================================================
// Worker Entry Point
// ============================================================================

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return corsPreflight();

    // Allow GET/HEAD/POST for admin sync/update endpoints
    const method = request.method;
    const url = new URL(request.url);
    const isAdmin = url.pathname.startsWith('/api/admin/');

    if (isAdmin) {
      if (!['GET', 'POST', 'HEAD'].includes(method)) {
        return errorResponse('Method not allowed', 405);
      }
    } else {
      if (!['GET', 'HEAD'].includes(method)) {
        return errorResponse('Method not allowed', 405);
      }
    }

    try {
      const response = await routeRequest(request, env, ctx);
      if (method === 'HEAD') {
        return new Response(null, { status: response.status, headers: new Headers(response.headers) });
      }
      return response;
    } catch (err) {
      // Always log the real error server-side (visible via `wrangler tail`),
      // even though the client only ever sees the generic message below.
      console.error(`[Worker] Unhandled error on ${method} ${url.pathname}:`, err.stack || err.message || err);
      return errorResponse('Internal server error', 500, env.DEBUG ? err.message : undefined);
    }
  },
};