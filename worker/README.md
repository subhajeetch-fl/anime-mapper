# Anime Mapper — Cloudflare Worker Search API

Production-ready advanced anime search API deployed to Cloudflare Workers. No database needed — filters, sorts, and paginates a flat JSON search index in-memory.

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `GET /` | GET | API info |
| `GET /api/` | GET | API info |
| `GET /api/search?...` | GET | Advanced search |
| `GET /api/anime/:id` | GET | Single anime by MAL id |
| `GET /api/meta/:type` | GET | `genres`, `studios`, `producers`, `types`, `statuses`, `ratings`, `years`, `all` |
| `GET /api/stats` | GET | Aggregated stats |
| `GET /api/health` | GET | Health check |

## Search Parameters

| Param | Type | Description |
|-------|------|-------------|
| `q` | string | Free-text search (title, romaji, native) — fuzzy + typo-tolerant |
| `genre` | comma-list | Filter by genres (kebab-case, e.g `action,sci-fi`) |
| `studio` | comma-list | Filter by studios (kebab-case) |
| `producer` | comma-list | Filter by producers (kebab-case) |
| `type` | string | Filter by type: TV, Movie, OVA, etc. |
| `status` | string | Filter by status: `Finished Airing`, `Currently Airing`, etc. |
| `rating` | string | Filter by rating: `PG-13`, `R - 17+`, etc. |
| `year_min` | int | Minimum year (inclusive) |
| `year_max` | int | Maximum year (inclusive) |
| `score_min` | float | Minimum score 0–10 (inclusive) |
| `score_max` | float | Maximum score 0–10 (inclusive) |
| `episodes_min` | int | Minimum episode count |
| `episodes_max` | int | Maximum episode count |
| `sort` | string | `score`, `popularity`, `year`, `title`, `episodes`, `updatedAt`, `id` (default: `popularity`) |
| `order` | string | `asc` or `desc` (default: `desc`) |
| `page` | int | Page number, 1-indexed (default: `1`) |
| `limit` | int | Items per page, capped at **50** (default: `24`) |

## Examples

**Search for high-rated action/sci-fi animes:**
```
/api/search?genre=action,sci-fi&score_min=7.5&sort=score&order=desc&limit=24
```

**Studio-specific with year range:**
```
/api/search?studio=maple,gainax&year_min=1995&year_max=2010&limit=24
```

**Paginated title search:**
```
/api/search?q=cowboy&page=2&limit=24&sort=popularity&order=desc
```

## Caching Strategy

```
Client:  24hr max-age, immutable
Edge:    12hr s-maxage
Stale:   7-day stale-while-revalidate
Data:    5-min in-memory + 20-min Cloudflare Cache API
```

Since anime metadata changes rarely, API responses are cached heavily. The raw search-index.json (fetched from jsdelivr CDN) is cached in the Worker’s in-memory isolate cache (5 min) and the Cloudflare Cache API (20 min).

## Deployment

1. Set `/worker` as the root folder in your deployment tool (Wrangler, Cloudflare dashboard, etc.)
2. Deploy with Wrangler:
   ```bash
   cd worker
   npm install -g wrangler
   npx wrangler deploy
   ```

No build step or dependencies required.
