# Anime Search API

A blazing-fast, fully-featured anime search API built for Vercel. Powers advanced filtering, full-text search, and rich metadata aggregation across 27,000+ anime titles.

---

## Features

- **Full-text search** — search by English, romaji, or native title (case-insensitive, diacritic-ignoring, fuzzy-matching)
- **Advanced filtering** — genre, studio, producer, type, status, rating, year range, score range, episode count range
- **Sorting** — by score, popularity, year, title, episode count, or last updated
- **Pagination** — page-based (default) or cursor-based, max **24 items per page**
- **Metadata endpoints** — precomputed lists of all genres, studios, producers, types, statuses, ratings, and year ranges
- **Stats endpoint** — catalog analytics: distribution by type, status, rating, year, and season
- **Single anime lookup** — fetch any anime by its MyAnimeList ID
- **Caching** — in-memory (5 min) + Vercel edge cache (5 min SWR)

---

## Base URL

```
https://your-project.vercel.app
```

All routes below are prefixed with `/api`.

---

## Endpoints

### `GET /api/search`

Advanced anime search with filtering, sorting, and pagination.

#### Query Parameters

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `q` | string | Free-text search (title/romaji/native) | `?q=frieren` |
| `genre` | string | Comma-separated genres (ANY match) | `?genre=Action,Adventure` |
| `studio` | string | Comma-separated studios (ANY match) | `?studio=MAPPA,White+Fox` |
| `producer` | string | Comma-separated producers (ANY match) | `?producer=Aniplex` |
| `type` | string | Exact type match | `?type=TV` |
| `status` | string | Exact status match | `?status=Finished Airing` |
| `rating` | string | Exact rating match | `?rating=PG-13 - Teens 13 or older` |
| `year_min` | integer | Minimum release year | `?year_min=2015` |
| `year_max` | integer | Maximum release year | `?year_max=2024` |
| `score_min` | float | Minimum score (0-10) | `?score_min=8.5` |
| `score_max` | float | Maximum score (0-10) | `?score_max=9.0` |
| `episodes_min` | integer | Minimum episode count | `?episodes_min=12` |
| `episodes_max` | integer | Maximum episode count | `?episodes_max=26` |
| `sort` | string | Sort field: `score`, `popularity`, `year`, `title`, `episodes`, `updatedAt` | `?sort=score` |
| `order` | string | Sort direction: `asc`, `desc` (default) | `?order=desc` |
| `page` | integer | Page number (1-indexed, default: 1) | `?page=2` |
| `limit` | integer | Items per page, max **24** (default: 20) | `?limit=24` |
| `cursor` | string | Base64 cursor for next page (alternative to `page`) | `?cursor=...` |

#### Anime Object Fields

Each anime in the `data` array contains:

```json
{
  "id": 52991,
  "title": "Frieren: Beyond Journey's End",
  "romajiTitle": "Sousou no Frieren",
  "nativeTitle": "葬送のフリーレン",
  "year": 2023,
  "season": "fall",
  "type": "TV",
  "status": "Finished Airing",
  "episodeCount": 28,
  "image": "https://cdn.myanimelist.net/images/anime/1015/138006l.jpg",
  "score": 9.26,
  "updatedAt": "2026-06-30T10:57:49.825Z",
  "genres": ["Adventure", "Award Winning", "Drama", "Fantasy", "Elf", "Magic", "Shounen", "Slice of Life"],
  "studios": ["Madhouse"],
  "producers": ["Aniplex", "Dentsu", "Shogakukan-Shueisha Productions", "Nippon Television Network"],
  "rating": "PG-13 - Teens 13 or older",
  "searchTitle": "frieren: beyond journey's end sousou no frieren ..."
}
```

#### Response Format

```json
{
  "data": [ /* anime objects */ ],
  "pagination": {
    "page": 1,
    "limit": 24,
    "total": 152,
    "totalPages": 7,
    "hasNext": true,
    "hasPrev": false
  },
  "meta": {
    "query": { /* parsed query params */ },
    "filterOptions": { /* all available filters */ },
    "executionTimeMs": 3
  }
}
```

#### Example Requests

**Basic search:**
```bash
curl "https://your-project.vercel.app/api/search?q=frieren&limit=5"
```

**Genre + type + score filter:**
```bash
curl "https://your-project.vercel.app/api/search?genre=Action,Adventure&type=TV&status=Finished%20Airing&score_min=8&sort=score&order=desc&limit=24"
```

**Studio + year range:**
```bash
curl "https://your-project.vercel.app/api/search?studio=Madhouse&year_min=2020&year_max=2024&sort=year&order=desc&limit=10"
```

**Rating filter (e.g. R-17+):**
```bash
curl "https://your-project.vercel.app/api/search?rating=R%20-%2017%2B%20(violence%20%26%20profanity)&sort=score&limit=10"
```

**Pagination (page 3):**
```bash
curl "https://your-project.vercel.app/api/search?genre=Comedy&page=3&limit=24"
```

**Cursor pagination:**
```bash
curl "https://your-project.vercel.app/api/search?genre=Action&limit=24&cursor=MjQ="  # offset=24 base64
```

---

### `GET /api/anime/:id`

Fetch a single anime by its **MyAnimeList ID**.

#### Example

```bash
curl "https://your-project.vercel.app/api/anime/52991"
```

#### Response

```json
{
  "data": {
    "id": 52991,
    "title": "Frieren: Beyond Journey's End",    "romajiTitle": "Sousou no Frieren",
    "nativeTitle": "葬送のフリーレン",
    "year": 2023,
    "season": "fall",
    "type": "TV",
    "status": "Finished Airing",
    "episodeCount": 28,
    "image": "https://cdn.myanimelist.net/images/anime/1015/138006l.jpg",
    "score": 9.26,
    "updatedAt": "2026-06-30T10:57:49.825Z",
    "genres": ["Adventure", "Award Winning", "Drama", "Fantasy", "Elf", "Magic", "Shounen", "Slice of Life"],
    "studios": ["Madhouse"],
    "producers": ["Aniplex", "Dentsu", "Shogakukan-Shueisha Productions", "Nippon Television Network", "TOHO animation", "Shogakukan"],
    "rating": "PG-13 - Teens 13 or older",
    "searchTitle": "frieren: beyond journey's end sousou no frieren ..."
  }
}
```

---

### `GET /api/meta/all`

Returns all available filter options in one request. Use this to populate dropdown menus in your frontend.

#### Response

```json
{
  "data": {
    "genres": ["Action", "Adventure", "Comedy", "Drama", ...],
    "studios": ["Madhouse", "MAPPA", "Bones", "A-1 Pictures", ...],
    "producers": ["Aniplex", "Bandai Visual", ...],
    "types": ["TV", "Movie", "OVA", "ONA", "TV Special", "Special", "Music", "CM"],
    "statuses": ["Finished Airing", "Currently Airing", "Not yet aired"],
    "ratings": ["R - 17+ (violence & profanity)", "PG-13 - Teens 13 or older", "PG - Children", "G - All Ages", ...],
    "yearRange": { "min": 1917, "max": 2027 },
    "scoreRange": { "min": 1.89, "max": 9.26 },
    "episodesRange": { "min": 1, "max": 366 },
    "total": 27424
  }
}
```

---

### `GET /api/meta/:type`

Get specific filter options. `:type` can be: `genres`, `studios`, `producers`, `types`, `statuses`, `ratings`, `years`.

#### Examples

```bash
curl "https://your-project.vercel.app/api/meta/genres"
curl "https://your-project.vercel.app/api/meta/studios"
curl "https://your-project.vercel.app/api/meta/types"
curl "https://your-project.vercel.app/api/meta/statuses"
curl "https://your-project.vercel.app/api/meta/ratings"
curl "https://your-project.vercel.app/api/meta/years"
```

---

### `GET /api/stats`

Catalog analytics and distribution data.

#### Response

```json
{
  "data": {
    "total": 27424,
    "byType": { "TV": 7922, "Movie": 4283, "OVA": 4077, "ONA": 3682, ... },
    "byStatus": { "Finished Airing": 27155, "Currently Airing": 155, ... },
    "byRating": { "PG-13 - Teens 13 or older": 9422, "G - All Ages": 7894, ... },
    "byYear": [{ "year": 2027, "count": 2 }, { "year": 2026, "count": 60 }, ...],
    "topGenres": [
      { "genre": "Comedy", "count": 9064 },
      { "genre": "Fantasy", "count": 7194 },
      ...
    ],
    "topStudios": [
      { "studio": "Toei Animation", "count": 871 },
      { "studio": "Sunrise", "count": 558 },
      ...
    ],
    "scoreDistribution": {
      "avg": 6.43,
      "min": 1.89,
      "max": 9.26
    }
  }
}
```

---

## Error Responses

| Status | Meaning | Example |
|--------|---------|---------|
| `400` | Bad Request | Invalid anime ID |
| `404` | Not Found | Anime not found or endpoint not found |
| `500` | Server Error | Internal server error |

#### Error Response Format

```json
{
  "error": "Anime not found",
  "details": { "id": 99999999 }
}
```

---

## Common Filter Values

### Types
```
TV, Movie, OVA, ONA, TV Special, Special, Music, CM
```

### Statuses
```
Finished Airing
Currently Airing
Not yet aired
```

### Ratings
```
G - All Ages
PG - Children
PG-13 - Teens 13 or older
R - 17+ (violence & profanity)
R+ - Mild Nudity
Rx - Hentai
```

---

## Deployment

### 1. Install Vercel CLI (if not already installed)

```bash
npm i -g vercel
```

### 2. Deploy

```bash
cd data/other-data-api
vercel --prod
```

Or connect via Vercel Dashboard:
1. Import your GitHub repo
2. Set **Root Directory** to `data/other-data-api`
3. Deploy

---

## Architecture

```
data/other-data-api/
  index.js           # API handler (ESM, ~630 lines)
  search-index.json    # Flattened anime data (19MB, 27K entries)
  package.json       # ESM package with fast-levenshtein
  vercel.json        # Vercel routing, caching, function config
  README.md          # This file
```

- **Data source**: `search-index.json` is rebuilt by the GitHub Actions pipeline (`scripts/build-indexes.js`) whenever anime data changes.
- **Runtime**: Node.js 20+ ESM, no framework (pure Node.js `http` module for local dev, Vercel handler for production).
- **Caching**: In-memory (5 min TTL per instance) + Vercel Edge cache (headers in `vercel.json`).
- **Performance**: Sub-5ms filtering/sorting on 27K entries per request.

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2025-07-01 | Initial release |

---

## License

MIT — feel free to use, modify, and distribute.
