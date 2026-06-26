/**
 * One-time migration: moves flat anime JSON files from data/anime/ into
 * bucket subdirectories (data/anime/000/, data/anime/001/, etc.).
 *
 * Safe to re-run — skips files already in the right bucket.
 *
 * Usage: node scripts/migrate-to-buckets.js [--dry-run]
 */
import { readdir, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

const ANIME_DIR = path.resolve('data/anime');

function getBucketName(id) {
  if (id >= 1000000) return 'other';
  const bucket = Math.floor(id / 1000);
  return String(bucket).padStart(3, '0');
}

async function migrate(dryRun = false) {
  const entries = await readdir(ANIME_DIR, { withFileTypes: true });

  let moved = 0;
  let skipped = 0;
  let errors = 0;

  for (const entry of entries) {
    // Only operate on .json files directly in the anime dir (flat layout)
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      skipped++;
      continue;
    }

    const idStr = entry.name.replace(/\.json$/, '');
    const id = Number(idStr);

    if (!Number.isInteger(id) || id < 0) {
      console.warn(`  skipping non-numeric file: ${entry.name}`);
      skipped++;
      continue;
    }

    const bucket = getBucketName(id);
    const srcPath = path.join(ANIME_DIR, entry.name);
    const bucketDir = path.join(ANIME_DIR, bucket);
    const destPath = path.join(bucketDir, entry.name);

    if (dryRun) {
      console.log(`  [dry-run] ${entry.name} -> ${bucket}/${entry.name}`);
      moved++;
      continue;
    }

    try {
      await mkdir(bucketDir, { recursive: true });
      await rename(srcPath, destPath);
      moved++;
    } catch (err) {
      console.error(`  ERROR moving ${entry.name} -> ${bucket}/${entry.name}: ${err.message}`);
      errors++;
    }
  }

  console.log(
    `\nMigration ${dryRun ? '(dry-run) ' : ''}complete: ` +
      `moved=${moved} skipped=${skipped} errors=${errors}`
  );
}

const dryRun = process.argv.includes('--dry-run');
migrate(dryRun);
