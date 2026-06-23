/**
 * PREVIEW / NOT WIRED UP YET - per the project's phase order, the API layer
 * (Phase 5) comes after the data pipeline is proven out. This file is a
 * reference for HOW the advanced-search endpoint would work once you start
 * Phase 5, kept here so the design is written down while it's fresh.
 *
 * Where the data comes from:
 *   The Worker fetches data/search-index.json from your GitHub repo (via
 *   jsdelivr's GitHub CDN, which is faster and better-cached than raw
 *   GitHub URLs) and caches it in the Workers Cache API for a few minutes.
 *   At 10,000-50,000 entries, filtering/sorting that array in plain JS on
 *   each request is well under Cloudflare Workers' CPU budget (a few ms),
 *   so there's no need for D1/KV/a real database for this. If the catalog
 *   eventually grows past ~100k entries or you want fuzzy/typo-tolerant
 *   text search, that's the point to look at D1 (SQLite) or a hosted
 *   search service (Meilisearch, Typesense) instead - not before.
 *
 * Supported query params (combine freely - this is what makes it
 * "advanced" rather than a single `q=` text box):
 *   q            substring match against title (romaji/english/native)
 *   genre        comma-separated, ANY-match, e.g. genre=Action,Comedy
 *   studio       comma-separated, ANY-match
 *   producer     comma-separated, ANY-match
 *   status       exact match, e.g. status=Currently Airing
 *   type         exact match, e.g. type=TV
 *   year_min     inclusive
 *   year_max     inclusive
 *   score_min    inclusive, 0-10 scale
 *   score_max    inclusive
 *   sort         score | popularity | year | title  (default: popularity)
 *   order        asc | desc                          (default: desc)
 *   page         1-indexed                            (default: 1)
 *   limit        page size, capped at 50              (default: 20)
 *
 * Example:
 *   GET /search?genre=Action,Adventure&status=Currently Airing
 *       &score_min=7.5&sort=score&order=desc&page=1&limit=20
 */

const SEARCH_INDEX_URL =
  'https://cdn.jsdelivr.net/gh/YOUR_GH_USERNAME/YOUR_REPO@main/data/search-index.json';
const CACHE_TTL_SECONDS = 300;
const MAX_LIMIT = 50;

async function loadSearchIndex(ctx) {
  const cache = caches.default;
  const cacheKey = new Request(SEARCH_INDEX_URL);

  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const res = await fetch(SEARCH_INDEX_URL);
  if (!res.ok) {
    throw new Error(`Failed to load search-index.json: ${res.status}`);
  }

  // Clone so we can both cache the raw response and read its JSON body.
  const cacheable = new Response(res.body, res);
  cacheable.headers.set('Cache-Control', `public, max-age=${CACHE_TTL_SECONDS}`);
  ctx.waitUntil(cache.put(cacheKey, cacheable.clone()));

  return cacheable.json();
}

function parseList(value) {
  return value ? value.split(',').map((v) => v.trim().toLowerCase()).filter(Boolean) : null;
}

function matchesAny(haystack, wantedLowercase) {
  if (!wantedLowercase) return true;
  const haystackLower = (haystack ?? []).map((v) => v.toLowerCase());
  return wantedLowercase.some((w) => haystackLower.includes(w));
}

export function filterAndSort(searchIndex, params) {
  const q = params.get('q')?.toLowerCase().trim() || null;
  const genres = parseList(params.get('genre'));
  const studios = parseList(params.get('studio'));
  const producers = parseList(params.get('producer'));
  const status = params.get('status');
  const type = params.get('type');
  const yearMin = params.has('year_min') ? Number(params.get('year_min')) : null;
  const yearMax = params.has('year_max') ? Number(params.get('year_max')) : null;
  const scoreMin = params.has('score_min') ? Number(params.get('score_min')) : null;
  const scoreMax = params.has('score_max') ? Number(params.get('score_max')) : null;
  const sortKey = params.get('sort') || 'popularity';
  const order = params.get('order') === 'asc' ? 1 : -1;
  const page = Math.max(1, Number(params.get('page')) || 1);
  const limit = Math.min(MAX_LIMIT, Number(params.get('limit')) || 20);

  let results = searchIndex.filter((anime) => {
    if (q && !anime.searchTitle?.includes(q)) return false;
    if (!matchesAny(anime.genres, genres)) return false;
    if (!matchesAny(anime.studios, studios)) return false;
    if (!matchesAny(anime.producers, producers)) return false;
    if (status && anime.status !== status) return false;
    if (type && anime.type !== type) return false;
    if (yearMin != null && (anime.year == null || anime.year < yearMin)) return false;
    if (yearMax != null && (anime.year == null || anime.year > yearMax)) return false;
    if (scoreMin != null && (anime.score == null || anime.score < scoreMin)) return false;
    if (scoreMax != null && (anime.score == null || anime.score > scoreMax)) return false;
    return true;
  });

  const sortFns = {
    score: (a, b) => (a.score ?? -Infinity) - (b.score ?? -Infinity),
    popularity: (a, b) => (a.popularity ?? -Infinity) - (b.popularity ?? -Infinity),
    year: (a, b) => (a.year ?? -Infinity) - (b.year ?? -Infinity),
    title: (a, b) => (a.title ?? '').localeCompare(b.title ?? ''),
  };
  const sortFn = sortFns[sortKey] ?? sortFns.popularity;
  results = results.sort((a, b) => order * sortFn(a, b));

  const total = results.length;
  const start = (page - 1) * limit;
  const pageResults = results.slice(start, start + limit);

  return {
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    results: pageResults,
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== '/search') {
      return new Response('Not found', { status: 404 });
    }

    try {
      const searchIndex = await loadSearchIndex(ctx);
      const result = filterAndSort(searchIndex, url.searchParams);
      return Response.json(result, {
        headers: { 'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}` },
      });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 502 });
    }
  },
};
