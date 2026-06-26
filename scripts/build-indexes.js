/**
 * Rebuilds precomputed index files from data/anime/*.json.
 * Run this after fetch-anime.js has added/updated anime, never compute
 * these on every API request (per spec).
 *
 * Generates:
 *   data/anime-index.json   - lightweight, one entry per anime (search/lists)
 *   data/search-index.json  - flattened array with every filterable field,
 *                             used by the future Cloudflare Worker for
 *                             advanced search (see README "Advanced search")
 *
 * Also removes legacy index files that are no longer generated (homepage
 * data is now fetched separately by scripts/fetch-homepage.js):
 *   data/genre-index.json
 *   data/popular.json
 *   data/top-rated.json
 *   data/trending.json
 *
 * CLI usage: node scripts/build-indexes.js
 */
import { readFile, readdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ANIME_DIR = path.resolve('data/anime');
const DATA_DIR = path.resolve('data');

/** Index files that were removed — deleted on the next build if they still exist. */
const REMOVED_INDEX_FILES = [
  'genre-index.json',
  'popular.json',
  'top-rated.json',
  'trending.json',
];

async function loadAllAnime() {
  // Recursively walk the bucket directories and collect JSON files.
  async function collectFiles(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        result.push(...await collectFiles(full));
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        result.push(full);
      }
    }
    return result;
  }

  let files = [];
  try {
    files = await collectFiles(ANIME_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const records = [];
  for (const filePath of files) {
    try {
      const raw = await readFile(filePath, 'utf-8');
      records.push(JSON.parse(raw));
    } catch (err) {
      console.error(`[build-indexes] skipping unreadable file ${filePath}: ${err.message}`);
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
    // lowercased, accent-free-ish field purely for substring title search
    searchTitle: [anime.title?.english, anime.title?.romaji, anime.title?.native]
      .filter(Boolean)
      .join(' ')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase(),
  };
}

async function writeJson(filePath, data) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

/**
 * Delete index files that are no longer generated. Succeeds silently if they
 * do not exist (e.g. fresh checkout or already cleaned up).
 */
async function cleanRemovedIndexes() {
  for (const file of REMOVED_INDEX_FILES) {
    const filePath = path.join(DATA_DIR, file);
    try {
      await unlink(filePath);
      console.log(`[build-indexes] removed legacy file: ${file}`);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

export async function buildIndexes() {
  const animeList = await loadAllAnime();

  const animeIndex = animeList.map(toIndexEntry).sort((a, b) => a.id - b.id);
  const searchIndex = animeList.map(toSearchEntry).sort((a, b) => a.id - b.id);

  await writeJson(path.join(DATA_DIR, 'anime-index.json'), animeIndex);
  await writeJson(path.join(DATA_DIR, 'search-index.json'), searchIndex);

  await cleanRemovedIndexes();

  return {
    total: animeList.length,
  };
}

const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  const stats = await buildIndexes();
  console.log(`Indexed ${stats.total} anime`);
}
