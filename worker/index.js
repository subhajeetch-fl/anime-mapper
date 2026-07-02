/**
 * Anime Mapper — Advanced Search API for Cloudflare Workers
 */

// ============================================================================
// Configuration
// ============================================================================

const SEARCH_INDEX_URL =
  'https://pub-986f8236d2c7439dbc1bf3babc33865f.r2.dev/search-index.json';

const CACHE = {
  rawDataMaxAge: 1200,
  rawDataSMaxAge: 3600,
  rawDataStaleRevalidate: 7200,
  responseMaxAge: 86400,
  responseSMaxAge: 43200,
};

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 24;
const VERSION = '2.0.0';

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

function toKebabCase(str) {
  if (!str) return '';
  return str
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeText(str) {
  if (!str) return '';
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
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

function fuzzyMatch(query, target, threshold) {
  if (!query || !target) return false;
  const q = normalizeText(query);
  const t = normalizeText(target);
  if (t.includes(q)) return true;
  if (q.length <= 3) return false;
  const dist = levenshteinDistance(q, t);
  return dist / Math.max(q.length, t.length) <= (threshold || 0.3);
}

// ============================================================================
// Data Loading (dual-layer cache: edge + in-memory)
// ============================================================================

async function loadSearchIndex(env, ctx) {
  const now = Date.now();

  // 1. In-memory isolate cache
  if (_searchIndex && now - _lastLoadTime < ISOLATE_CACHE_TTL) {
    return _searchIndex;
  }

  // 2. Cloudflare Cache API
  const cacheKey = new Request(SEARCH_INDEX_URL);
  const cache = safeCache();
  let cachedResponse = null;
  try { cachedResponse = await cache.match(cacheKey); } catch (_) { /* no-op */ }

  if (cachedResponse) {
    try {
      const json = await cachedResponse.clone().json();
      if (Array.isArray(json)) {
        _searchIndex = json;
        _lastLoadTime = Date.now();
        return _searchIndex;
      }
    } catch (_) { /* corrupt cache, continue */ }
  }

  // 3. Fetch from CDN
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(SEARCH_INDEX_URL, {
      signal: controller.signal,
      cf: { cacheTtl: CACHE.rawDataMaxAge },
    });
    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const clonedRes = res.clone();
    const json = await res.json();
    if (!Array.isArray(json)) throw new Error('Not an array');

    // Cache raw response
    if (ctx && ctx.waitUntil) {
      const cacheable = new Response(clonedRes.body, {
        status: clonedRes.status,
        headers: {
          ...Object.fromEntries(clonedRes.headers.entries()),
          'Cache-Control': `public, max-age=${CACHE.rawDataMaxAge}, s-maxage=${CACHE.rawDataSMaxAge}, stale-while-revalidate=${CACHE.rawDataStaleRevalidate}`,
        },
      });
      ctx.waitUntil(cache.put(cacheKey, cacheable).catch(() => {}));
    }

    _searchIndex = json;
    _lastLoadTime = Date.now();
    _filterOptionsCache = null;
    _statsCache = null;
    return _searchIndex;
  } catch (err) {
    if (_searchIndex) { console.warn('[Worker] Stale fallback:', err.message); return _searchIndex; }
    clearTimeout(timeoutId);
    throw err;
  }
}

function safeCache() {
  try { return caches.default; } catch (_) { return null; }
}

// ============================================================================
// Filter Engine
// ============================================================================

function parseFilters(params) {
  return {
    q: normalizeText(params.q || ''),
    genres: parseList(params.genre).map(toKebabCase),
    studios: parseList(params.studio).map(toKebabCase),
    producers: parseList(params.producer).map(toKebabCase),
    type: params.type || null,
    status: params.status || null,
    rating: params.rating || null,
    yearMin: parseIntSafe(params.year_min, null),
    yearMax: parseIntSafe(params.year_max, null),
    scoreMin: parseFloatSafe(params.score_min, null),
    scoreMax: parseFloatSafe(params.score_max, null),
    episodesMin: parseIntSafe(params.episodes_min, null),
    episodesMax: parseIntSafe(params.episodes_max, null),
  };
}

function matchesFilters(anime, filters) {
  if (filters.q) {
    const searchText = anime.searchTitle || '';
    const hasMatch =
      searchText.includes(filters.q) ||
      fuzzyMatch(filters.q, anime.title) ||
      fuzzyMatch(filters.q, anime.romajiTitle) ||
      fuzzyMatch(filters.q, anime.nativeTitle);
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

  if (filters.yearMin != null && (anime.year == null || anime.year < filters.yearMin)) return false;
  if (filters.yearMax != null && (anime.year == null || anime.year > filters.yearMax)) return false;
  if (filters.scoreMin != null && (anime.score == null || anime.score < filters.scoreMin)) return false;
  if (filters.scoreMax != null && (anime.score == null || anime.score > filters.scoreMax)) return false;
  if (filters.episodesMin != null && (anime.episodeCount == null || anime.episodeCount < filters.episodesMin)) return false;
  if (filters.episodesMax != null && (anime.episodeCount == null || anime.episodeCount > filters.episodesMax)) return false;

  return true;
}

// ============================================================================
// Sorting & Pagination
// ============================================================================

const VALID_SORTS = ['score', 'popularity', 'year', 'title', 'episodes', 'updatedAt', 'id'];

function sortResults(results, sortKey, order) {
  const direction = order === 'asc' ? 1 : -1;
  const getValue = (a, key) => {
    switch (key) {
      case 'score': return a.score ?? -Infinity;
      case 'popularity': return a.popularity ?? -Infinity;
      case 'year': return a.year ?? -Infinity;
      case 'title': return (a.title || '').toLowerCase();
      case 'episodes': return a.episodeCount ?? -Infinity;
      case 'updatedAt': return a.updatedAt ? new Date(a.updatedAt).getTime() : -Infinity;
      case 'id': return a.id ?? -Infinity;
      default: return a.score ?? -Infinity;
    }
  };

  results.sort((a, b) => {
    const av = getValue(a, sortKey);
    const bv = getValue(b, sortKey);
    if (av === bv) return (a.id ?? 0) - (b.id ?? 0);
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
    if (anime.year != null) { minYear = Math.min(minYear, anime.year); maxYear = Math.max(maxYear, anime.year); }
    if (anime.score != null) { minScore = Math.min(minScore, anime.score); maxScore = Math.max(maxScore, anime.score); }
    if (anime.episodeCount != null) { minEpisodes = Math.min(minEpisodes, anime.episodeCount); maxEpisodes = Math.max(maxEpisodes, anime.episodeCount); }
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
    if (anime.year) byYear[anime.year] = (byYear[anime.year] || 0) + 1;
    if (anime.season) bySeason[anime.season] = (bySeason[anime.season] || 0) + 1;
    anime.genres?.forEach((g) => { genreCounts[g] = (genreCounts[g] || 0) + 1; });
    anime.studios?.forEach((s) => { studioCounts[s] = (studioCounts[s] || 0) + 1; });
    if (anime.score != null) { totalScore += anime.score; scoreCount++; minScore = Math.min(minScore, anime.score); maxScore = Math.max(maxScore, anime.score); }
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
// Route Handlers
// ============================================================================

function handleRoot() {
  return jsonResponse({
    name: 'Anime Mapper Search API',
    version: VERSION,
    description: 'Advanced anime search with Cloudflare Workers',
    endpoints: {
      search: '/api/search?q=&genre=&studio=&producer=&type=&status=&rating=&year_min=&year_max=&score_min=&score_max=&episodes_min=&episodes_max=&sort=&order=&page=&limit=',
      anime: '/api/anime/:id',
      meta: '/api/meta/{genres|studios|producers|types|statuses|ratings|years|all}',
      stats: '/api/stats',
      health: '/api/health',
    },
    limits: { maxLimit: MAX_LIMIT, defaultLimit: DEFAULT_LIMIT },
    cache: 'Client: 24hr / Edge: 12hr / Stale-while-revalidate: 7 days',
  });
}

async function handleSearch(params, searchIndex) {
  const filters = parseFilters(params);

  const rawSort = (params.sort || 'popularity').toLowerCase();
  const sort = VALID_SORTS.includes(rawSort) ? rawSort : 'popularity';
  const order = (params.order || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';

  const page = Math.max(1, parseIntSafe(params.page, 1));
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseIntSafe(params.limit, DEFAULT_LIMIT)));

  let results = searchIndex.filter((anime) => matchesFilters(anime, filters));
  results = sortResults(results, sort, order);
  const paginated = paginateResults(results, page, limit);

  return jsonResponse({
    data: paginated.items,
    pagination: paginated.pagination,
    meta: { query: { ...filters, sort, order, limit, page }, filterOptions: buildFilterOptions(searchIndex) },
  });
}

async function handleAnimeById(path, searchIndex) {
  const match = path.match(/\/(\d+)$/);
  if (!match) return errorResponse('Not found', 404);

  const id = parseInt(match[1], 10);
  if (Number.isNaN(id)) return errorResponse('Invalid anime ID', 400);

  const anime = searchIndex.find((a) => a.id === id);
  if (!anime) return jsonResponse({ error: 'Anime not found', id }, 404);

  return jsonResponse({ data: anime });
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
          decades: [...new Set(searchIndex.map((a) => a.year).filter((y) => y).map((y) => Math.floor(y / 10) * 10))].sort((a, b) => b - a),
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
      cache: 'Edge Cache API + in-memory isolate cache active',
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
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return errorResponse('Method not allowed', 405);
    }

    try {
      const response = await routeRequest(request, env, ctx);
      if (request.method === 'HEAD') {
        return new Response(null, { status: response.status, headers: new Headers(response.headers) });
      }
      return response;
    } catch (err) {
      console.error('[Worker] Unhandled error:', err);
      return errorResponse('Internal server error', 500, env.DEBUG ? err.message : undefined);
    }
  },
};
