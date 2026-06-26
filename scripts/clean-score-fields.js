/**
 * Migration script: trims the `score` object in all existing anime JSON files
 * down to exactly 3 fields (malScore, anilistScore, kitsuRating).
 *
 * It walks all `.json` files under `data/anime/{bucket}/{id}.json`,
 * replaces the score block, and only rewrites the file if the score actually
 * changed. Uses 2-space indentation (matching existing file format).
 *
 * CLI usage:
 *   node scripts/clean-score-fields.js
 *
 * The script is idempotent - running it multiple times is a no-op after
 * the first successful run.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// --- Configuration ---
const ANIME_BASE_DIR = path.resolve('data', 'anime');

// --- Stats tracking ---
const stats = {
  scanned: 0,
  updated: 0,
  unchanged: 0,
  errors: 0,
};

/**
 * Walk a directory 현재 directory recursively and collect all `.json` files.
 * Only goes one level deep since bucket directories are directly under
 * data/anime/ (e.g., data/anime/000/1.json, data/anime/001/1000.json).
 */
async function getAllAnimeJsonFiles() {
  const entries = [];

  try {
    const buckets = await readdir(ANIME_BASE_DIR, { withFileTypes: true });

    for (const bucket of buckets) {
      if (!bucket.isDirectory()) continue;

      const bucketPath = path.join(ANIME_BASE_DIR, bucket.name);
      const files = await readdir(bucketPath);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        entries.push(path.join(bucketPath, file));
      }
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`Directory not found: ${ANIME_BASE_DIR}`);
      process.exit(1);
    }
    throw err;
  }

  return entries;
}

/**
 * Trim the score object to only the 3 allowed fields.
 */
function cleanScore(originalScore) {
  return {
    malScore: originalScore?.malScore ?? null,
    anilistScore: originalScore?.anilistScore ?? null,
    kitsuRating: originalScore?.kitsuRating ?? null,
  };
}

/**
 * Process a single anime JSON file: trim score and rewrite if changed.
 */
async function processFile(filePath) {
  let data;
  try {
    const raw = await readFile(filePath, 'utf-8');
    data = JSON.parse(raw);
  } catch (err) {
    console.error(`  [ERROR] Failed to read/parse ${filePath}: ${err.message}`);
    stats.errors++;
    return;
  }

  // Only touch files that actually have a score object
  if (!data.score || typeof data.score !== 'object') {
    stats.unchanged++;
    return;
  }

  const allowedKeys = new Set(['malScore', 'anilistScore', 'kitsuRating']);
  const keysToRemove = Object.keys(data.score).filter((k) => !allowedKeys.has(k));

  if (keysToRemove.length === 0) {
    stats.unchanged++;
    return;
  }

  data.score = cleanScore(data.score);

  try {
    await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
    stats.updated++;
  } catch (err) {
    console.error(`  [ERROR] Failed to write ${filePath}: ${err.message}`);
    stats.errors++;
  }
}

// --- Main -------------------------------------------------------------------
async function main() {
  console.log('Scanning anime files...');

  const files = await getAllAnimeJsonFiles();
  console.log(`Found ${files.length} JSON file(s) in ${ANIME_BASE_DIR}`);
  console.log('Processing...\n');

  for (const filePath of files) {
    await processFile(filePath);
    stats.scanned++;
  }

  console.log('\n=== Done ===');
  console.log(`  Total scanned:  ${stats.scanned}`);
  console.log(`  Updated:        ${stats.updated}`);
  console.log(`  Unchanged:      ${stats.unchanged}`);
  console.log(`  Errors:         ${stats.errors}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
