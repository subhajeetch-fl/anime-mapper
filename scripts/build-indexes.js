/**
 * Rebuilds every precomputed list/index file from data/anime/*.json.
 * Run this after fetch-anime.js has added/updated anime, never compute
 * these on every API request (per spec).
 *
 * Generates:
 *   data/anime-index.json   - lightweight, one entry per anime (search/lists)
 *   data/trending.json      - currently airing, sorted by AniList `popularity`
 *                             (closest proxy we have to "trending" without
 *                             tracking week-over-week deltas ourselves)
 *   data/popular.json       - all-time, sorted by MAL members
 *   data/top-rated.json     - sorted by MAL score, with a minimum vote
 *                             threshold so a single 10/10 vote can't rank #1
 *   data/genre-index.json   - { genreName: [malId, ...] }
 *   data/search-index.json  - flattened array with every filterable field,
 *                             used by the future Cloudflare Worker for
 *                             advanced search (see README "Advanced search")
 *
 * CLI usage: node scripts/build-indexes.js
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ANIME_DIR = path.resolve('data/anime');
const DATA_DIR = path.resolve('data');

const TOP_RATED_MIN_VOTES = 1000; // tune as the dataset grows
const LIST_LIMIT = 50; // how many entries trending/popular/top-rated each keep

async function loadAllAnime() {
  let files;
  try {
    files = (await readdir(ANIME_DIR)).filter((f) => f.endsWith('.json'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const records = [];
  for (const file of files) {
    try {
      const raw = await readFile(path.join(ANIME_DIR, file), 'utf-8');
      records.push(JSON.parse(raw));
    } catch (err) {
      console.error(`[build-indexes] skipping unreadable file ${file}: ${err.message}`);
    }
  }
  return records;
}

function toIndexEntry(anime) {
  return {
    id: anime.id,
    title: anime.title?.english ?? anime.title?.romaji ?? null,
    romajiTitle: anime.title?.romaji ?? null,
    nativeTitle: anime.title?.native ?? null,
    year: anime.year ?? null,
    season: anime.season ?? null,
    type: anime.type ?? null,
    status: anime.status ?? null,
    episodeCount: anime.episodeCount ?? null,
    image: anime.images?.poster ?? null,
    score: anime.score?.malScore ?? null,
    updatedAt: anime.meta?.lastFetched ?? null,
  };
}

function toSearchEntry(anime) {
  return {
    ...toIndexEntry(anime),
    genres: anime.genres ?? [],
    studios: anime.studios ?? [],
    producers: anime.producers ?? [],
    rating: anime.rating ?? null,
    scoredBy: anime.score?.malScoredBy ?? null,
    popularity: anime.score?.malPopularity ?? null,
    members: anime.score?.malMembers ?? null,
    // lowercased, accent-free-ish field purely for substring title search
    searchTitle: [anime.title?.english, anime.title?.romaji, anime.title?.native]
      .filter(Boolean)
      .join(' ')
      .toLowerCase(),
  };
}

function buildGenreIndex(animeList) {
  const index = {};
  for (const anime of animeList) {
    for (const genre of anime.genres ?? []) {
      if (!index[genre]) index[genre] = [];
      index[genre].push(anime.id);
    }
  }
  // keep stable, sorted output so diffs are clean
  for (const genre of Object.keys(index)) {
    index[genre].sort((a, b) => a - b);
  }
  return index;
}

async function writeJson(filePath, data) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

export async function buildIndexes() {
  const animeList = await loadAllAnime();

  const animeIndex = animeList.map(toIndexEntry).sort((a, b) => a.id - b.id);

  const trending = [...animeList]
    .filter((a) => a.status === 'Currently Airing')
    .sort((a, b) => (b.score?.anilistPopularity ?? 0) - (a.score?.anilistPopularity ?? 0))
    .slice(0, LIST_LIMIT)
    .map(toIndexEntry);

  const popular = [...animeList]
    .sort((a, b) => (b.score?.malMembers ?? 0) - (a.score?.malMembers ?? 0))
    .slice(0, LIST_LIMIT)
    .map(toIndexEntry);

  const topRated = [...animeList]
    .filter((a) => (a.score?.malScoredBy ?? 0) >= TOP_RATED_MIN_VOTES)
    .sort((a, b) => (b.score?.malScore ?? 0) - (a.score?.malScore ?? 0))
    .slice(0, LIST_LIMIT)
    .map(toIndexEntry);

  const genreIndex = buildGenreIndex(animeList);
  const searchIndex = animeList.map(toSearchEntry).sort((a, b) => a.id - b.id);

  await writeJson(path.join(DATA_DIR, 'anime-index.json'), animeIndex);
  await writeJson(path.join(DATA_DIR, 'trending.json'), trending);
  await writeJson(path.join(DATA_DIR, 'popular.json'), popular);
  await writeJson(path.join(DATA_DIR, 'top-rated.json'), topRated);
  await writeJson(path.join(DATA_DIR, 'genre-index.json'), genreIndex);
  await writeJson(path.join(DATA_DIR, 'search-index.json'), searchIndex);

  return {
    total: animeList.length,
    trending: trending.length,
    popular: popular.length,
    topRated: topRated.length,
    genres: Object.keys(genreIndex).length,
  };
}

const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  const stats = await buildIndexes();
  console.log(`Indexed ${stats.total} anime -> trending: ${stats.trending}, popular: ${stats.popular}, top-rated: ${stats.topRated}, genres: ${stats.genres}`);
}
