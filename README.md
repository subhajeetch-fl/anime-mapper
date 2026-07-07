![Home Page](/images/made-in-abyss.jpg)

<div align="center">
<h1>Anime Mapper</h1>
	<p>
		<a href="https://discord.gg/6DhssCN2Ph"><img src="https://img.shields.io/badge/join_our-discord-5865F2?logo=discord&logoColor=white" alt="Discord server" /></a>
        <a href="https://github.com/subhajeetch-fl/anime-mapper"><img src="https://img.shields.io/github/last-commit/subhajeetch-fl/anime-mapper.svg?logo=github&logoColor=ffffff" alt="Last commit." /></a>
</div>

A GitHub-hosted anime database of 30,000+ titles stored as plain JSON files. No API server is needed — consume Anime data by Myanimelist ID directly from [jsDelivr](https://www.jsdelivr.com/?docs=gh) or GitHub's raw CDN.

---

> [!NOTE]
> This repository does not provide, host, or distribute streaming links. It only provides publicly available anime data for informational and development purposes. Any misuse of this repository or its data is solely the responsibility of the user. The repository owner shall not be held liable for any unauthorized, unlawful, or malicious use of the repository or its contents.

## Support

If you like this project, consider giving it a <strong>star 🌟</strong>

Connect with me on X (Twitter): [@subhajeetch](https://x.com/subhajeetch)  
Join the Discord community: [Animekun](https://discord.gg/6DhssCN2Ph)

## Table of Contents

- [Quick Start](#quick-start)
- [Data Access](#data-access)
  - [Homepage Data](#homepage-data)
  - [Individual Anime](#individual-anime)
  - [Anime Index](#anime-index)
  - [Search Index](#search-index)
- [File Structure](#file-structure)
  - [Bucket Layout](#bucket-layout)
  - [The `getBucketName` function](#the-getbucketname-function)
- [Data Schema](#data-schema)
  - [Anime Entry](#anime-entry)
  - [Homepage](#homepage)
  - [Anime Index Entry](#anime-index-entry)
  - [Search Index Entry](#search-index-entry)
- [Update Pipeline](#update-pipeline)
- [License](#license)

---

## Quick Start

Fetch the homepage:

```bash
curl -s https://cdn.jsdelivr.net/gh/subhajeetch-fl/anime-mapper@main/data/homepage.json | head -c 500
```

Fetch a single anime (One Piece, MAL id 21):

```bash
curl -s https://cdn.jsdelivr.net/gh/subhajeetch-fl/anime-mapper@main/data/anime/000/21.json
```

> [!NOTE]
> jsdelivr caches files for 12 hours. If you need the bleeding-edge latest commit, use `https://raw.githubusercontent.com/subhajeetch-fl/anime-mapper/main/...` instead (slower, no CDN).

---

## Data Access

All data lives under the `data/` directory and is served as static JSON via jsdelivr.

> **jsDelivr base URL:**
>
> ```
> https://cdn.jsdelivr.net/gh/subhajeetch-fl/anime-mapper@main/data/
> ```

### Homepage Data

| Endpoint                 | Description                                                                       |
| ------------------------ | --------------------------------------------------------------------------------- |
| **`data/homepage.json`** | Curated homepage sections (spotlight, trending, top-rated, latest episodes, etc.) |

Example:

```bash
curl -s https://cdn.jsdelivr.net/gh/subhajeetch-fl/anime-mapper@main/data/homepage.json
```

The `homepage.json` payload contains these top-level keys:

| Section             | Type          | Description                                   |
| ------------------- | ------------- | --------------------------------------------- |
| `spotlight`         | `AnimeCard[]` | Featured / banner anime                       |
| `trending`          | `AnimeCard[]` | Currently popular anime                       |
| `topByTime`         | `object`      | `{ byDay, byWeek, byMonth }` — most discussed |
| `mostWatched`       | `AnimeCard[]` | Highest viewer counts                         |
| `mostPopular`       | `AnimeCard[]` | Long-term popular titles                      |
| `latestEpisodes`    | `AnimeCard[]` | Episodes that aired most recently             |
| `topRated`          | `AnimeCard[]` | Highest-scoring anime                         |
| `thisSeasonPopular` | `AnimeCard[]` | Top titles for the current season             |

Each `AnimeCard` follows the same shape as the full anime entry described below, but you are free to cherry-pick the fields you need.

---

### Individual Anime

| Endpoint                            | Description                             |
| ----------------------------------- | --------------------------------------- |
| **`data/anime/{bucket}/{id}.json`** | Full metadata record for a single anime |

The **bucket** is derived from the MAL id with the `getBucketName()` function (see [Bucket Layout](#bucket-layout) below).

Example for `id = 21` (One Piece):

```bash
# bucket for id 21  →  getBucketName(21) = "000"
curl -s https://cdn.jsdelivr.net/gh/subhajeetch-fl/anime-mapper@main/data/anime/000/21.json
```

Example for `id = 52991` (Frieren: Beyond Journey's End):

```bash
# bucket for id 52991  →  getBucketName(52991) = "052"
curl -s https://cdn.jsdelivr.net/gh/subhajeetch-fl/anime-mapper@main/data/anime/052/52991.json
```

---

### Anime Index

| Endpoint                    | Description                                              |
| --------------------------- | -------------------------------------------------------- |
| **`data/anime-index.json`** | Lightweight array — one entry per anime (search/list UI) |

Each entry is a small, flat object with just the essential display fields:

```json
{
  "id": 21,
  "title": "One Piece",
  "romajiTitle": "One Piece",
  "nativeTitle": "ワンピース",
  "year": 1999,
  "season": "fall",
  "type": "TV",
  "status": "Currently Airing",
  "episodeCount": null,
  "image": "https://cdn.myanimelist.net/images/anime/21l.jpg",
  "score": 8.69,
  "updatedAt": "2026-07-01T00:00:00.000Z"
}
```

---

### Search Index

| Endpoint                     | Description                                                      |
| ---------------------------- | ---------------------------------------------------------------- |
| **`data/search-index.json`** | Flattened array with every filterable/searchable field per anime |

This index is rebuilt automatically by the pipeline (`scripts/build-indexes.js`) every time anime data changes. It contains the full set of filterable fields (genres, studios, producers, scores, years, etc.) for every anime in the catalog.

> [!WARNING]
> **jsDelivr enforces a 20 MB file size limit.** `data/search-index.json` is typically **larger than 20 MB**, so it **cannot be fetched directly from jsdelivr.**
>
> You have a few options for using it:
>
> - Clone the repository and read the file locally.
> - Use [raw.githubusercontent.com](https://raw.githubusercontent.com/subhajeetch-fl/anime-mapper@main/data/search-index.json) (slower, no CDN).
> - Build your own search index from the `data/anime/` directory using `scripts/build-indexes.js`.
> - Fork this repo and host your own mirror on a platform that supports large files (e.g., Cloudflare R2, AWS S3, or your own backend). The `search-index.json` is just a static file — download it once, host it, and serve it however works for your stack.

---

## File Structure

We are using a structured file hierarchy because GitHub recommends keeping no more than 1,000 JSON files in a single folder.

```
data/
├── anime-index.json          # Lightweight list/search index (all anime, minimal fields)
├── search-index.json         # Full search index (every filterable field, >20 MB)
├── homepage.json             # Curated homepage sections
├── .pipeline-state/          # Pipeline state for automated updates
│   ├── last-updated.json
│   ├── retry-queue.json
│   └── ...
└── anime/
    ├── 000/                  # IDs 0–999
    │   ├── 1.json
    │   ├── 21.json
    │   └── ...
    ├── 001/                  # IDs 1000–1999
    ├── 002/                  # IDs 2000–2999
    ├── ...
    └── other/                # IDs ≥ 1,000,000
```

### Bucket Layout

The `data/anime/` directory is divided into **buckets** of 1,000 MAL IDs each. This keeps any single directory from growing too large and makes the structure predictable.

| ID Range            | Bucket Directory    |
| ------------------- | ------------------- |
| `0` – `999`         | `data/anime/000/`   |
| `1000` – `1999`     | `data/anime/001/`   |
| `50000` – `50999`   | `data/anime/050/`   |
| `999000` – `999999` | `data/anime/999/`   |
| `≥ 1000000`         | `data/anime/other/` |

### The `getBucketName` function

Use this exact logic to compute the bucket folder from any MAL id:

```javascript
function getBucketName(malId) {
  if (id >= 1000000) return "other";
  const bucket = Math.floor(id / 1000);
  return String(bucket).padStart(3, "0");
}
```

**Examples:**

```javascript
getBucketName(21); // "000"
getBucketName(1500); // "001"
getBucketName(52991); // "052"
getBucketName(999000); // "999"
getBucketName(1500000); // "other"
```

**Building the full URL:**

```javascript
function getAnimeUrl(malId) {
  const bucket = getBucketName(malId);
  return `https://cdn.jsdelivr.net/gh/subhajeetch-fl/anime-mapper@main/data/anime/${bucket}/${malId}.json`;
}

getAnimeUrl(52991);
// → "https://cdn.jsdelivr.net/gh/subhajeetch-fl/anime-mapper@main/data/anime/052/52991.json"
```

---

## Data Schema

### Anime Entry

A full anime record (`data/anime/{bucket}/{id}.json`) follows this structure:

```json
{
  "id": 21,
  "idMal": 21,
  "mappings": {
    "mal": 21,
    "anilist": 21,
    "anidb": 69,
    "kitsu": null,
    "simkl": null,
    "tmdb": null,
    "tvdb": null,
    "animeplanet": "one-piece",
    "anisearch": null,
    "notify": null,
    "shikimori": 21,
    "trakt": null,
    "traktType": null,
    "livechart": null
  },
  "title": {
    "romaji": "One Piece",
    "english": "One Piece",
    "native": "ワンピース",
    "synonyms": []
  },
  "type": "TV",
  "source": "Manga",
  "status": "Currently Airing",
  "airing": true,
  "episodeCount": null,
  "episodeLength": 24,
  "aired": {
    "from": "1999-10-20",
    "to": null
  },
  "season": "fall",
  "year": 1999,
  "broadcast": {
    "day": "Sundays",
    "time": "09:30",
    "timezone": "Asia/Tokyo"
  },
  "nextAiringEpisode": null,
  "rating": "PG-13 - Teens 13 or older",
  "score": {
    "malScore": 8.69,
    "anilistScore": 8.7,
    "kitsuRating": 8.69
  },
  "genres": [
    "Action",
    "Adventure",
    "Comedy",
    "Drama",
    "Fantasy",
    "Shounen",
    "Super Power"
  ],
  "studios": ["Toei Animation"],
  "producers": ["Fuji TV", "TAP", "Shueisha"],
  "images": {
    "poster": "https://cdn.myanimelist.net/images/anime/21l.jpg",
    "banner": "https://cdn.myanimelist.net/images/anime/21_1920x1080.jpg",
    "color": "#e4a127"
  },
  "trailer": {
    "youtubeId": "...",
    "url": "https://www.youtube.com/watch?v=...",
    "thumbnail": "https://img.youtube.com/vi/.../maxresdefault.jpg"
  },
  "synopsis": "Gol D. Roger was known as the Pirate King...",
  "sequence": [
    {
      "malId": 466,
      "title": {
        "romaji": "ONE PIECE: Taose! Kaizoku Ganzack",
        "english": "One Piece: Defeat the Pirate Ganzack!",
        "native": "ONE PIECE 倒せ!海賊ギャンザック"
      },
      "image": "...",
      "format": "OVA",
      "episodes": 1,
      "seasonYear": 1998,
      "relationType": "SIDE_STORY"
    }
  ],
  "episodes": {
    "1": {
      "episode": "1",
      "anidbEid": "286674",
      "isFiller": false,
      "isDubbed": true,
      "length": "25m",
      "airdate": "1999-10-20",
      "title": {
        "en": "I'm Luffy! The Man Who's Gonna Be King of the Pirates!"
      },
      "tvdbShowId": 429934,
      "tvdbId": 10152847,
      "seasonNumber": 1,
      "episodeNumber": 1,
      "absoluteEpisodeNumber": 1,
      "runtime": 24,
      "image": "https://artworks.thetvdb.com/banners/v4/episode/10152847/screencap/...",
      "airDate": "1999-10-20"
    }
  },
  "meta": {
    "lastFetched": "2026-07-01T00:00:00.000Z",
    "sourcesUsed": ["jikan", "kitsu", "anilist", "animeapi.my.id", "zenshin"],
    "missingSources": [],
    "dataVersion": 1
  }
}
```

### Homepage

`data/homepage.json` is a single JSON file containing curated sections for a homepage UI. Each section is an array of anime objects that match the **Anime Entry** schema above.

Available sections: `spotlight`, `trending`, `topByTime`, `mostWatched`, `mostPopular`, `latestEpisodes`, `topRated`, `thisSeasonPopular`.

---

### Anime Index Entry

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
  "updatedAt": "2026-07-01T00:00:00.000Z"
}
```

### Search Index Entry

The search index (`data/search-index.json`) uses short keys to minimize file size. Each entry looks like:

```json
{
  "id": 52991,
  "t": "Frieren: Beyond Journey's End",
  "rT": "Sousou no Frieren",
  "nT": "葬送のフリーレン",
  "y": 2023,
  "s": "fall",
  "ty": "TV",
  "st": "Finished Airing",
  "eC": 28,
  "img": "https://cdn.myanimelist.net/images/anime/1015/138006l.jpg",
  "sc": 9.26,
  "uA": "2026-07-01T00:00:00.000Z",
  "g": ["Adventure", "Award Winning", "Drama", "Fantasy"],
  "stu": ["Madhouse"],
  "pro": ["Aniplex", "Dentsu", "Shogakukan-Shueisha Productions"],
  "r": "PG-13 - Teens 13 or older",
  "se": "frieren: beyond journey's end sousou no frieren 葬送のフリーレン"
}
```

**Short key mapping:**

| Short Key | Long Field     |
| --------- | -------------- |
| `id`      | `id`           |
| `t`       | `title`        |
| `rT`      | `romajiTitle`  |
| `nT`      | `nativeTitle`  |
| `y`       | `year`         |
| `s`       | `season`       |
| `ty`      | `type`         |
| `st`      | `status`       |
| `eC`      | `episodeCount` |
| `img`     | `image`        |
| `sc`      | `score`        |
| `uA`      | `updatedAt`    |
| `g`       | `genres`       |
| `stu`     | `studios`      |
| `pro`     | `producers`    |
| `r`       | `rating`       |
| `se`      | `searchTitle`  |

---

## Update Pipeline

The data is kept fresh by GitHub Actions workflows:

| Workflow           | Trigger               | What it does                   |
| ------------------ | --------------------- | ------------------------------ |
| `homepage.yml`     | Every 12 hours        | Refreshes `data/homepage.json` |
| `smart-update.yml` | Every 10 hours        | Updates stale or airing anime  |
| `auto-add.yml`     | Daily at 03:30 UTC    | Discovers and adds new anime   |
| `discover-ids.yml` | Weekly (Sunday 02:15) | Discovers new MAL IDs to add   |

Each fetch pulls from multiple sources with automatic fallback:

| Source             | Role                                                     |
| ------------------ | -------------------------------------------------------- |
| **Jikan**          | Primary metadata (synopsis, genres, studios, score, ...) |
| **Kitsu**          | Fallback when Jikan is down/missing fields               |
| **AniList**        | Enrichment (banner art, sequence, next airing episode)   |
| **animeapi.my.id** | Cross-platform ID mappings                               |
| **Zenshin**        | Per-episode data (filler flags, TVDB IDs, etc.)          |

---

## License

MIT — The anime metadata is sourced from public APIs (Jikan, Kitsu, AniList, etc.). Use responsibly and respect the terms of each service.
