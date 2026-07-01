/**
 * Anime Search API — Hono + LRU Cache + Vercel
 *
 * Features:
 * - Full-text search (title, romaji, native) with fuzzy matching
 * - Filter by: genres, studios, producers, type, status, rating
 * - Range filters: year, score, episodes (min/max)
 * - Sort by: score, popularity, year, title, episodes, updatedAt
 * - Pagination: page-based or cursor-based, max 24 per page
 * - Response-level LRU cache (2 min), data in-memory cache (5 min)
 * - Edge cache headers (s-maxage) for Vercel CDN
 *
 * Endpoints:
 * GET /api/search?q=&genre=&studio=&producer=&type=&status=&rating=
 *       &year_min=&year_max=&score_min=&score_max=&episodes_min=&episodes_max=
 *       &sort=&order=&page=&limit=&cursor=
 * GET /api/anime/:id
 * GET /api/meta/genres|studios|producers|types|statuses|ratings|years|all
 * GET /api/stats
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Hono } from 'hono';
import { handle } from 'hono/vercel';
import levenshtein from 'fast-levenshtein';
import { LRUCache } from 'lru-cache';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_FILE = join(__dirname, '..', 'search-index.json');
const MAX_LIMIT = 24;
const DEFAULT_LIMIT = 20;

// ============================================================================
// Caches (persist across warm invocations)
// ============================================================================

let searchIndexCache = null;
let filterOptionsCache = null;
let indexMetaCache = null;
let lastLoadTime = 0;

/** Response cache - identical requests served from memory */
const responseCache = new LRUCache({
  max: 500,
  ttl: 1000 * 60 * 2, // 2 minutes
  updateAgeOnGet: true,
});

// ============================================================================
// Helpers
// ============================================================================

function normalizeText(str) {
  if (!str) return '';
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function parseList(val) {
  if (!val) return [];
  return val.split(',').map((s) => s.trim()).filter(Boolean);
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

function fuzzyMatch(query, target, threshold = 0.3) {
  if (!query || !target) return false;
  const q = normalizeText(query);
  const t = normalizeText(target);
  if (t.includes(q)) return true;
  if (q.length <= 3) return false;
  const dist = levenshtein.get(q, t);
  return dist / Math.max(q.length, t.length) <= threshold;
}

// ============================================================================
// Data Loading
// ============================================================================

async function loadSearchIndex() {
  const now = Date.now();
  if (searchIndexCache && now - lastLoadTime < 300000) {
    return searchIndexCache;
  }
  try {
    console.log('[API] Loading search index from:', DATA_FILE);
    const t0 = Date.now();
    const raw = await readFile(DATA_FILE, 'utf-8');
    console.log(`[API] Read ${raw.length} bytes in ${Date.now() - t0}ms`);
    searchIndexCache = JSON.parse(raw);
    lastLoadTime = now;
    console.log(`[API] Parsed ${searchIndexCache.length} entries, total ${Date.now() - t0}ms`);
    return searchIndexCache;
  } catch (err) {
    console.error('[API] FAILED to load search index:', err.code, err.message, 'path was:', DATA_FILE);
    throw err;
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
    anime.genres?.forEach((g) => genres.add(g));
    anime.studios?.forEach((s) => studios.add(s));
    anime.producers?.forEach((p) => producers.add(p));
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
  for (const anime of index) byId.set(anime.id, anime);
  indexMetaCache = { byId };
  return indexMetaCache;
}

// ============================================================================
// Search Logic
// ============================================================================

function matchesFilters(anime, filters) {
  if (filters.q && !anime.searchTitle?.includes(filters.q)) {
    if (!fuzzyMatch(filters.q, anime.title) &&
        !fuzzyMatch(filters.q, anime.romajiTitle) &&
        !fuzzyMatch(filters.q, anime.nativeTitle)) {
      return false;
    }
  }

  if (filters.genres.length && !filters.genres.some((g) => anime.genres?.includes(g))) return false;
  if (filters.studios.length && !filters.studios.some((s) => anime.studios?.includes(s))) return false;
  if (filters.producers.length && !filters.producers.some((p) => anime.producers?.includes(p))) return false;

  if (filters.type && anime.type !== filters.type) return false;
  if (filters.status && anime.status !== filters.status) return false;
  if (filters.rating && anime.rating !== filters.rating) return false;

  if (filters.yearMin != null && (anime.year == null || anime.year < filters.yearMin)) return false;
  if (filters.yearMax != null && (anime.year == null || anime.year > filters.yearMax)) return false;
  if (filters.scoreMin != null && (anime.score == null || anime.score < filters.scoreMin)) return false;
  if (filters.scoreMax != null && (anime.score == null || anime.score > filters.scoreMax)) return false;
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
    const av = getValue(a, sortBy), bv = getValue(b, sortBy);
    if (av === bv) return a.id - b.id;
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
    pagination: { page: safePage, limit, total, totalPages, hasNext: safePage < totalPages, hasPrev: safePage > 1 },
  };
}

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
  return { items, pagination: { limit, total: results.length, nextCursor, hasNext: !!nextCursor } };
}

// ============================================================================
// Hono App (basePath /api — Hono strips it before matching routes below)
// ============================================================================

const app = new Hono().basePath('/api');

/** CORS middleware */
app.use('*', async (c, next) => {
  if (c.req.method === 'OPTIONS') {
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
  await next();
});

// ─── GET /api ─────────────────────────────────────────────────────────────
app.get('/', (c) => {
  return c.json({
    name: 'Anime Search API',
    version: '1.1.0',
    description: 'Advanced anime search with Hono, filtering, pagination, and LRU caching',
    endpoints: {
      search: 'GET /api/search?q=&genre=&studio=&producer=&type=&status=&rating=&year_min=&year_max=&score_min=&score_max=&episodes_min=&episodes_max=&sort=&order=&page=&limit=&cursor=',
      animeById: 'GET /api/anime/:id',
      meta: 'GET /api/meta/{genres|studios|producers|types|statuses|ratings|years|all}',
      stats: 'GET /api/stats',
    },
    limits: { maxLimit: MAX_LIMIT, defaultLimit: DEFAULT_LIMIT },
    cache: '2 min LRU + Edge s-maxage',
  });
});

// ─── GET /api/search ───────────────────────────────────────────────────────
app.get('/search', async (c) => {
  const url = c.req.url;
  const cached = responseCache.get(url);
  if (cached) return cached.clone();

  const index = await loadSearchIndex();
  const params = c.req.query();

  const filters = {
    q: normalizeText(params.q || ''),
    genres: parseList(params.genre),
    studios: parseList(params.studio),
    producers: parseList(params.producer),
    type: params.type || null,
    status: params.status || null,
    rating: params.rating || null,
    yearMin: parseIntSafe(params.year_min),
    yearMax: parseIntSafe(params.year_max),
    scoreMin: parseFloatSafe(params.score_min),
    scoreMax: parseFloatSafe(params.score_max),
    episodesMin: parseIntSafe(params.episodes_min),
    episodesMax: parseIntSafe(params.episodes_max),
  };

  const sortBy = params.sort || 'score';
  const validSorts = ['score', 'popularity', 'year', 'title', 'episodes', 'updatedAt'];
  const sort = validSorts.includes(sortBy) ? sortBy : 'score';
  const order = params.order === 'asc' ? 'asc' : 'desc';
  const useCursor = params.cursor !== undefined;
  const limit = Math.min(parseIntSafe(params.limit, DEFAULT_LIMIT), MAX_LIMIT);

  let results = index.filter((anime) => matchesFilters(anime, filters));
  results = sortResults(results, sort, order);

  let pagination;
  if (useCursor) {
    pagination = paginateCursor(results, params.cursor, limit);
  } else {
    pagination = paginateResults(results, Math.max(1, parseIntSafe(params.page, 1)), limit);
  }

  const response = c.json({
    data: pagination.items,
    pagination: pagination.pagination,
    meta: {
      query: { ...filters, sort, order, limit },
      filterOptions: buildFilterOptions(index),
    },
  });

  responseCache.set(url, response.clone());
  return response;
});

// ─── GET /api/anime/:id ───────────────────────────────────────────────────
app.get('/anime/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (Number.isNaN(id)) return c.json({ error: 'Invalid anime ID' }, 400);

  const index = await loadSearchIndex();
  const meta = buildIndexMeta(index);
  const anime = meta.byId.get(id);
  if (!anime) return c.json({ error: 'Anime not found', id }, 404);

  return c.json({ data: anime });
});

// ─── GET /api/meta/:type ──────────────────────────────────────────────────
app.get('/meta/:type', async (c) => {
  const metaType = c.req.param('type');
  const index = await loadSearchIndex();
  const options = buildFilterOptions(index);

  switch (metaType) {
    case 'genres':
      return c.json({ data: options.genres, total: options.genres.length });
    case 'studios':
      return c.json({ data: options.studios, total: options.studios.length });
    case 'producers':
      return c.json({ data: options.producers, total: options.producers.length });
    case 'types':
      return c.json({ data: options.types, total: options.types.length });
    case 'statuses':
      return c.json({ data: options.statuses, total: options.statuses.length });
    case 'ratings':
      return c.json({ data: options.ratings, total: options.ratings.length });
    case 'years':
      return c.json({
        data: {
          min: options.yearRange.min,
          max: options.yearRange.max,
          decades: [...new Set(index.map((a) => a.year).filter((y) => y).map((y) => Math.floor(y / 10) * 10))]
            .sort((a, b) => b - a),
        },
      });
    case 'all':
      return c.json({
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
      return c.json({ error: `Meta type "${metaType}" not found` }, 404);
  }
});

// ─── GET /api/stats ────────────────────────────────────────────────────────
app.get('/stats', async (c) => {
  const index = await loadSearchIndex();

  const byType = {}, byStatus = {}, byRating = {}, byYear = {}, bySeason = {};
  const genreCounts = {}, studioCounts = {};

  for (const anime of index) {
    if (anime.type) byType[anime.type] = (byType[anime.type] || 0) + 1;
    if (anime.status) byStatus[anime.status] = (byStatus[anime.status] || 0) + 1;
    if (anime.rating) byRating[anime.rating] = (byRating[anime.rating] || 0) + 1;
    if (anime.year) byYear[anime.year] = (byYear[anime.year] || 0) + 1;
    if (anime.season) bySeason[anime.season] = (bySeason[anime.season] || 0) + 1;
    anime.genres?.forEach((g) => { genreCounts[g] = (genreCounts[g] || 0) + 1; });
    anime.studios?.forEach((s) => { studioCounts[s] = (studioCounts[s] || 0) + 1; });
  }

  const topGenres = Object.entries(genreCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([genre, count]) => ({ genre, count }));

  const topStudios = Object.entries(studioCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([studio, count]) => ({ studio, count }));

  return c.json({
    data: {
      total: index.length,
      byType,
      byStatus,
      byRating,
      byYear: Object.entries(byYear)
        .sort((a, b) => b[0] - a[0])
        .slice(0, 30)
        .map(([year, count]) => ({ year: +year, count })),
      bySeason,
      topGenres,
      topStudios,
      scoreDistribution: {
        avg: index.reduce((s, a) => s + (a.score || 0), 0) / index.filter((a) => a.score).length,
        min: Math.min(...index.map((a) => a.score).filter((s) => s != null)),
        max: Math.max(...index.map((a) => a.score).filter((s) => s != null)),
      },
    },
  });
});

// ─── 404 fallback ──────────────────────────────────────────────────────────
app.notFound((c) => {
  return c.json({ error: 'Not found', path: c.req.path }, 404);
});

// ─── Error handler ─────────────────────────────────────────────────────────
app.onError((err, c) => {
  console.error('[API] Error:', err);
  return c.json({ error: 'Internal server error', message: err.message }, 500);
});

// ============================================================================
// Export for Vercel (using Hono's official Vercel adapter)
// ============================================================================
export default handle(app);

// ============================================================================
// Local Development Server
// ============================================================================
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    try {
      const index = await loadSearchIndex();
      buildFilterOptions(index);
      buildIndexMeta(index);

      const PORT = process.env.PORT || 3000;
      const server = createServer(async (req, res) => {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        const request = new Request(url, {
          method: req.method,
          headers: Object.fromEntries(
            Object.entries(req.headers).filter(([_, v]) => v != null)
          ),
        });
        // Use app.fetch directly for local dev (same as handle() does)
        const response = await app.fetch(request);

        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        res.end(Buffer.from(await response.arrayBuffer()));
      });

      server.listen(PORT, () => {
        console.log(`[API] Server listening on http://localhost:${PORT}`);
      });
    } catch (err) {
      console.error('[API] Failed to start:', err.message);
      process.exit(1);
    }
  })();
}
