/**
 * Advanced Anime Search API for Vercel
 *
 * Features:
 * - Full-text search (title, romaji, native)
 * - Filter by: genres, studios, producers, type, status, rating
 * - Range filters: year (min/max), score (min/max), episodes (min/max)
 * - Sort by: score, popularity, year, title, episodes, updatedAt
 * - Pagination: max 24 per page, cursor-based or page-based
 * - Optimized for Vercel Edge/Node runtime with in-memory caching
 *
 * Endpoints:
 * GET /api/search?q=&genre=&studio=&producer=&type=&status=&rating=
 *       &year_min=&year_max=&score_min=&score_max=&episodes_min=&episodes_max=
 *       &sort=&order=&page=&limit=&cursor=
 * GET /api/anime/:id
 * GET /api/meta/genres
 * GET /api/meta/studios
 * GET /api/meta/producers
 * GET /api/meta/types
 * GET /api/meta/statuses
 * GET /api/meta/ratings
 * GET /api/stats
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import levenshtein from 'fast-levenshtein';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// Configuration
// ============================================================================

const DATA_FILE = join(__dirname, 'search-index.json');
const MAX_LIMIT = 24;
const DEFAULT_LIMIT = 20;
const CACHE_TTL_MS = 300000; // 5 minutes

// ============================================================================
// In-Memory Cache (persists across invocations in same container)
// ============================================================================

let searchIndexCache = null;
let indexMetaCache = null;
let lastLoadTime = 0;
let filterOptionsCache = null;

// ============================================================================
// Utility Functions
// ============================================================================

function createResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      ...init.headers,
    },
  });
}

function createErrorResponse(status, message, details = null) {
  return createResponse(
    { error: message, ...(details && { details }) },
    { status }
  );
}

function parseIntSafe(val, fallback = null) {
  if (val === undefined || val === null || val === '') return fallback;
  const n = parseInt(val, 10);
  return Number.isNaN(n) ? fallback : n;
}

function parseFloatSafe(val, fallback = null) {
  if (val === undefined || val === null || val === '') return fallback;
  const n = parseFloat(val);
  return Number.isNaN(n) ? fallback : n;
}

function parseList(val) {
  if (!val) return [];
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

function normalizeText(str) {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove diacritics
    .toLowerCase()
    .trim();
}

function fuzzyMatch(query, target, threshold = 0.3) {
  if (!query || !target) return false;
  const q = normalizeText(query);
  const t = normalizeText(target);
  if (t.includes(q)) return true;
  // Levenshtein for short queries
  if (q.length <= 3) return false;
  const dist = levenshtein.get(q, t);
  return dist / Math.max(q.length, t.length) <= threshold;
}

// ============================================================================
// Data Loading & Caching
// ============================================================================

async function loadSearchIndex() {
  const now = Date.now();
  if (searchIndexCache && (now - lastLoadTime) < CACHE_TTL_MS) {
    return searchIndexCache;
  }

  try {
    const raw = await readFile(DATA_FILE, 'utf-8');
    searchIndexCache = JSON.parse(raw);
    lastLoadTime = now;
    return searchIndexCache;
  } catch (err) {
    console.error('[API] Failed to load search-index.json:', err.message);
    throw new Error('Search index unavailable');
  }
}

function buildFilterOptions(index) {
  if (filterOptionsCache) return filterOptionsCache;

  const genres = new Set();
  const studios = new Set();
  const producers = new Set();
  const types = new Set();
  const statuses = new Set();
  const ratings = new Set();
  let minYear = Infinity, maxYear = -Infinity;
  let minScore = Infinity, maxScore = -Infinity;
  let minEpisodes = Infinity, maxEpisodes = -Infinity;

  for (const anime of index) {
    anime.genres?.forEach(g => genres.add(g));
    anime.studios?.forEach(s => studios.add(s));
    anime.producers?.forEach(p => producers.add(p));
    if (anime.type) types.add(anime.type);
    if (anime.status) statuses.add(anime.status);
    if (anime.rating) ratings.add(anime.rating);
    if (anime.year != null) {
      minYear = Math.min(minYear, anime.year);
      maxYear = Math.max(maxYear, anime.year);
    }
    if (anime.score != null) {
      minScore = Math.min(minScore, anime.score);
      maxScore = Math.max(maxScore, anime.score);
    }
    if (anime.episodeCount != null) {
      minEpisodes = Math.min(minEpisodes, anime.episodeCount);
      maxEpisodes = Math.max(maxEpisodes, anime.episodeCount);
    }
  }

  filterOptionsCache = {
    genres: [...genres].sort(),
    studios: [...studios].sort(),
    producers: [...producers].sort(),
    types: [...types].sort(),
    statuses: [...statuses].sort(),
    ratings: [...ratings].sort(),
    yearRange: { min: minYear === Infinity ? null : minYear, max: maxYear === -Infinity ? null : maxYear },
    scoreRange: { min: minScore === Infinity ? null : minScore, max: maxScore === -Infinity ? null : maxScore },
    episodesRange: { min: minEpisodes === Infinity ? null : minEpisodes, max: maxEpisodes === -Infinity ? null : maxEpisodes },
    total: index.length,
  };

  return filterOptionsCache;
}

function buildIndexMeta(index) {
  if (indexMetaCache) return indexMetaCache;

  const byId = new Map();
  for (const anime of index) {
    byId.set(anime.id, anime);
  }

  indexMetaCache = { byId };
  return indexMetaCache;
}

// ==============================================================================================================
// Search & Filter Logic
// ============================================================================

function matchesFilters(anime, filters) {
  // Free text search (searchTitle is pre-lowercased concatenated titles)
  if (filters.q && !anime.searchTitle?.includes(filters.q)) {
    // Fallback to fuzzy match on individual title fields
    const q = filters.q;
    const titleMatch = fuzzyMatch(q, anime.title) ||
                       fuzzyMatch(q, anime.romajiTitle) ||
                       fuzzyMatch(q, anime.nativeTitle);
    if (!titleMatch) return false;
  }

  // Genres (ANY match)
  if (filters.genres?.length && !filters.genres.some(g => anime.genres?.includes(g))) {
    return false;
  }

  // Studios (ANY match)
  if (filters.studios?.length && !filters.studios.some(s => anime.studios?.includes(s))) {
    return false;
  }

  // Producers (ANY match)
  if (filters.producers?.length && !filters.producers.some(p => anime.producers?.includes(p))) {
    return false;
  }

  // Type (exact)
  if (filters.type && anime.type !== filters.type) return false;

  // Status (exact)
  if (filters.status && anime.status !== filters.status) return false;

  // Rating (exact - e.g., "R - 17+ (violence & profanity)", "PG-13")
  if (filters.rating && anime.rating !== filters.rating) return false;

  // Year range
  if (filters.yearMin != null && (anime.year == null || anime.year < filters.yearMin)) return false;
  if (filters.yearMax != null && (anime.year == null || anime.year > filters.yearMax)) return false;

  // Score range
  if (filters.scoreMin != null && (anime.score == null || anime.score < filters.scoreMin)) return false;
  if (filters.scoreMax != null && (anime.score == null || anime.score > filters.scoreMax)) return false;

  // Episodes range
  if (filters.episodesMin != null && (anime.episodeCount == null || anime.episodeCount < filters.episodesMin)) return false;
  if (filters.episodesMax != null && (anime.episodeCount == null || anime.episodeCount > filters.episodesMax)) return false;

  return true;
}

function sortResults(results, sortBy, order) {
  const direction = order === 'asc' ? 1 : -1;

  const getValue = (anime, key) => {
    switch (key) {
      case 'score': return anime.score ?? -Infinity;
      case 'popularity': return anime.popularity ?? -Infinity;
      case 'year': return anime.year ?? -Infinity;
      case 'title': return anime.title?.toLowerCase() ?? '';
      case 'episodes': return anime.episodeCount ?? -Infinity;
      case 'updatedAt': return anime.updatedAt ? new Date(anime.updatedAt).getTime() : -Infinity;
      default: return anime.score ?? -Infinity;
    }
  };

  results.sort((a, b) => {
    const av = getValue(a, sortBy);
    const bv = getValue(b, sortBy);
    if (av === bv) return a.id - b.id; // stable sort by id
    return direction * (av > bv ? 1 : -1);
  });

  return results;
}

function paginateResults(results, page, limit) {
  const total = results.length;
  const totalPages = Math.ceil(total / limit);
  const safePage = Math.max(1, Math.min(page, totalPages || 1));
  const start = (safePage - 1) * limit;
  const end = start + limit;
  const items = results.slice(start, end);

  return {
    items,
    pagination: {
      page: safePage,
      limit,
      total,
      totalPages,
      hasNext: safePage < totalPages,
      hasPrev: safePage > 1,
    },
  };
}

// Cursor-based pagination (more efficient for large datasets)
function paginateCursor(results, cursor, limit) {
  let startIdx = 0;
  if (cursor) {
    const decoded = Buffer.from(cursor, 'base64').toString('utf-8');
    startIdx = parseInt(decoded, 10);
    if (Number.isNaN(startIdx) || startIdx < 0) startIdx = 0;
  }

  const items = results.slice(startIdx, startIdx + limit);
  const nextCursor = startIdx + items.length < results.length
    ? Buffer.from(String(startIdx + limit)).toString('base64')
    : null;

  return {
    items,
    pagination: {
      limit,
      total: results.length,
      nextCursor,
      hasNext: !!nextCursor,
    },
  };
}

// ============================================================================
// Request Handlers
// ============================================================================

async function handleSearch(request, url) {
  const index = await loadSearchIndex();
  const meta = buildIndexMeta(index);

  // Parse query parameters
  const params = url.searchParams;
  const q = normalizeText(params.get('q') || '');

  const filters = {
    q,
    genres: parseList(params.get('genre')),
    studios: parseList(params.get('studio')),
    producers: parseList(params.get('producer')),
    type: params.get('type') || null,
    status: params.get('status') || null,
    rating: params.get('rating') || null,
    yearMin: parseIntSafe(params.get('year_min')),
    yearMax: parseIntSafe(params.get('year_max')),
    scoreMin: parseFloatSafe(params.get('score_min')),
    scoreMax: parseFloatSafe(params.get('score_max')),
    episodesMin: parseIntSafe(params.get('episodes_min')),
    episodesMax: parseIntSafe(params.get('episodes_max')),
  };

  // Sorting
  const sortBy = params.get('sort') || 'score';
  const validSorts = ['score', 'popularity', 'year', 'title', 'episodes', 'updatedAt'];
  const sort = validSorts.includes(sortBy) ? sortBy : 'score';
  const order = params.get('order') === 'asc' ? 'asc' : 'desc';

  // Pagination
  const useCursor = params.has('cursor');
  const limit = Math.min(parseIntSafe(params.get('limit'), DEFAULT_LIMIT), MAX_LIMIT);

  // Filter
  let results = index.filter(anime => matchesFilters(anime, filters));

  // Sort
  results = sortResults(results, sort, order);

  // Paginate
  let pagination;
  if (useCursor) {
    pagination = paginateCursor(results, params.get('cursor'), limit);
  } else {
    const page = Math.max(1, parseIntSafe(params.get('page'), 1));
    pagination = paginateResults(results, page, limit);
  }

  // Build response - include search metadata
  return createResponse({
    data: pagination.items,
    pagination: pagination.pagination,
    meta: {
      query: { ...filters, sort, order, limit },
      filterOptions: buildFilterOptions(index),
      executionTimeMs: 0, // will be filled by wrapper
    },
  });
}

async function handleAnimeById(request, url) {
  const index = await loadSearchIndex();
  const meta = buildIndexMeta(index);

  // Extract ID from pathname: /api/anime/:id
  const pathParts = url.pathname.split('/').filter(Boolean);
  const idStr = pathParts[pathParts.length - 1];
  const id = parseInt(idStr, 10);

  if (Number.isNaN(id)) {
    return createErrorResponse(400, 'Invalid anime ID');
  }

  const anime = meta.byId.get(id);
  if (!anime) {
    return createErrorResponse(404, 'Anime not found', { id });
  }

  return createResponse({ data: anime });
}

async function handleMeta(request, url) {
  const index = await loadSearchIndex();
  const pathParts = url.pathname.split('/').filter(Boolean);
  const metaType = pathParts[pathParts.length - 1]; // genres, studios, etc.

  const options = buildFilterOptions(index);

  switch (metaType) {
    case 'genres':
      return createResponse({ data: options.genres, total: options.genres.length });
    case 'studios':
      return createResponse({ data: options.studios, total: options.studios.length });
    case 'producers':
      return createResponse({ data: options.producers, total: options.producers.length });
    case 'types':
      return createResponse({ data: options.types, total: options.types.length });
    case 'statuses':
      return createResponse({ data: options.statuses, total: options.statuses.length });
    case 'ratings':
      return createResponse({ data: options.ratings, total: options.ratings.length });
    case 'years':
      return createResponse({
        data: {
          min: options.yearRange.min,
          max: options.yearRange.max,
          // Provide common year buckets for UI
          decades: [...new Set(index.map(a => a.year).filter(y => y).map(y => Math.floor(y/10)*10))]
            .sort((a,b) => b-a)
        }
      });
    case 'all':
      return createResponse({
        data: {
          genres: options.genres,
          studios: options.studios,
          producers: options.producers,
          types: options.types,
          statuses: options.statuses,
          ratings: options.ratings,
          yearRange: options.yearRange,
          scoreRange: options.scoreRange,
          episodesRange: options.episodesRange,
          total: options.total,
        },
      });
    default:
      return createErrorResponse(404, `Meta type "${metaType}" not found`);
  }
}

async function handleStats(request, url) {
  const index = await loadSearchIndex();

  const byType = {};
  const byStatus = {};
  const byRating = {};
  const byYear = {};
  const bySeason = {};

  for (const anime of index) {
    if (anime.type) byType[anime.type] = (byType[anime.type] || 0) + 1;
    if (anime.status) byStatus[anime.status] = (byStatus[anime.status] || 0) + 1;
    if (anime.rating) byRating[anime.rating] = (byRating[anime.rating] || 0) + 1;
    if (anime.year) byYear[anime.year] = (byYear[anime.year] || 0) + 1;
    if (anime.season) bySeason[anime.season] = (bySeason[anime.season] || 0) + 1;
  }

  // Top genres
  const genreCounts = {};
  for (const anime of index) {
    anime.genres?.forEach(g => { genreCounts[g] = (genreCounts[g] || 0) + 1; });
  }
  const topGenres = Object.entries(genreCounts)
    .sort((a,b) => b[1] - a[1])
    .slice(0, 20)
    .map(([genre, count]) => ({ genre, count }));

  // Top studios
  const studioCounts = {};
  for (const anime of index) {
    anime.studios?.forEach(s => { studioCounts[s] = (studioCounts[s] || 0) + 1; });
  }
  const topStudios = Object.entries(studioCounts)
    .sort((a,b) => b[1] - a[1])
    .slice(0, 20)
    .map(([studio, count]) => ({ studio, count }));

  return createResponse({
    data: {
      total: index.length,
      byType,
      byStatus,
      byRating,
      byYear: Object.entries(byYear).sort((a,b) => b[0] - a[0]).slice(0, 30).map(([year, count]) => ({ year: +year, count })),
      bySeason,
      topGenres,
      topStudios,
      scoreDistribution: {
        avg: index.reduce((s, a) => s + (a.score || 0), 0) / index.filter(a => a.score).length,
        min: Math.min(...index.map(a => a.score).filter(s => s != null)),
        max: Math.max(...index.map(a => a.score).filter(s => s != null)),
      },
    },
  });
}

async function handleRoot(request, url) {
  return createResponse({
    name: 'Anime Search API',
    version: '1.0.0',
    description: 'Advanced anime search with filtering, pagination, and metadata',
    endpoints: {
      search: 'GET /api/search?q=&genre=&studio=&producer=&type=&status=&rating=&year_min=&year_max=&score_min=&score_max=&episodes_min=&episodes_max=&sort=&order=&page=&limit=&cursor=',
      animeById: 'GET /api/anime/:id',
      meta: {
        all: 'GET /api/meta/all',
        genres: 'GET /api/meta/genres',
        studios: 'GET /api/meta/studios',
        producers: 'GET /api/meta/producers',
        types: 'GET /api/meta/types',
        statuses: 'GET /api/meta/statuses',
        ratings: 'GET /api/meta/ratings',
        years: 'GET /api/meta/years',
      },
      stats: 'GET /api/stats',
    },
    limits: {
      maxLimit: MAX_LIMIT,
      defaultLimit: DEFAULT_LIMIT,
    },
    dataSource: 'search-index.json (updated via GitHub Actions)',
    cache: '5min Edge cache, in-memory cache per instance',
  });
}

// ============================================================================
// Main Request Router
// ============================================================================

function parseFiltersFromUrl(url) {
  // Helper to parse all possible filters from URL for documentation
  return null;
}

export default async function handler(request) {
  const startTime = performance.now();
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '') || '/';

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  try {
    let response;

    // Route matching
    if (path === '/' || path === '') {
      response = await handleRoot(request, url);
    } else if (path === '/search') {
      response = await handleSearch(request, url);
    } else if (path.startsWith('/anime/')) {
      response = await handleAnimeById(request, url);
    } else if (path.startsWith('/meta/')) {
      response = await handleMeta(request, url);
    } else if (path === '/stats') {
      response = await handleStats(request, url);
    } else {
      response = createErrorResponse(404, `Endpoint not found: ${path}`);
    }

    // Add execution time header
    const executionTime = Math.round(performance.now() - startTime);
    response.headers.set('X-Execution-Time-Ms', executionTime.toString());

    // Add execution time to response body if it's JSON
    if (response.headers.get('Content-Type')?.includes('application/json')) {
      const body = await response.clone().json();
      if (body.meta) {
        body.meta.executionTimeMs = executionTime;
        return createResponse(body, { status: response.status, headers: response.headers });
      }
    }

    return response;

  } catch (err) {
    console.error('[API] Error:', err);
    return createErrorResponse(500, 'Internal server error', { message: err.message });
  }
}

// ============================================================================
// Local Development Server (optional)
// ============================================================================

import { createServer } from 'node:http';

if (typeof process !== 'undefined' && process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const PORT = process.env.PORT || 3000;

  console.log(`[API] Starting development server on http://localhost:${PORT}`);
  console.log(`[API] Data file: ${DATA_FILE}`);

  // Load index on startup for faster first request
  loadSearchIndex().then(idx => {
    console.log(`[API] Loaded ${idx.length} anime entries`);
    buildFilterOptions(idx);
    console.log('[API] Filter options built');

    // Create actual HTTP server
    const server = createServer(async (req, res) => {
      try {
        const request = new Request(`http://localhost:${PORT}${req.url}`, {
          method: req.method,
          headers: Object.fromEntries(Object.entries(req.headers).filter(([_, v]) => v)),
        });
        const response = await handler(request);

        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        const body = await response.text();
        res.end(body);
      } catch (err) {
        console.error('[API] Request error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });

    server.listen(PORT, () => {
      console.log(`[API] Server listening on http://localhost:${PORT}`);
    });

    // Graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n[API] Shutting down...');
      server.close(() => process.exit(0));
    });
  }).catch(err => {
    console.error('[API] Failed to load index:', err.message);
    process.exit(1);
  });
}