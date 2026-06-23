/**
 * Pipeline state, stored in data/.pipeline-state/ and committed to the repo
 * just like everything else (so state survives between Action runs without
 * needing external storage).
 *
 *  - last-updated.json: { [malId]: isoTimestamp } - lets us skip anime that
 *    were already updated recently and aren't airing (rate-limit strategy).
 *  - retry-queue.json: [{ id, reason, attempts, lastAttempt }] - anime that
 *    failed last run. The crawler always processes this queue FIRST on the
 *    next run, satisfying "even if an error happens, do it later."
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const STATE_DIR = path.resolve('data/.pipeline-state');
const LAST_UPDATED_PATH = path.join(STATE_DIR, 'last-updated.json');
const RETRY_QUEUE_PATH = path.join(STATE_DIR, 'retry-queue.json');

async function readJsonSafe(filePath, fallback) {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    console.warn(`[state] failed to read ${filePath}, using fallback. (${err.message})`);
    return fallback;
  }
}

async function writeJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

export async function loadLastUpdated() {
  return readJsonSafe(LAST_UPDATED_PATH, {});
}

export async function saveLastUpdated(map) {
  await writeJson(LAST_UPDATED_PATH, map);
}

export async function markUpdated(map, malId) {
  map[String(malId)] = new Date().toISOString();
  return map;
}

/** @returns {boolean} true if malId was updated within `maxAgeHours` */
export function isFresh(map, malId, maxAgeHours) {
  const ts = map[String(malId)];
  if (!ts) return false;
  const ageMs = Date.now() - new Date(ts).getTime();
  return ageMs < maxAgeHours * 60 * 60 * 1000;
}

export async function loadRetryQueue() {
  return readJsonSafe(RETRY_QUEUE_PATH, []);
}

export async function saveRetryQueue(queue) {
  await writeJson(RETRY_QUEUE_PATH, queue);
}

/**
 * Merges this run's failures into the retry queue. Items that succeeded
 * this run (passed in `succeededIds`) are removed from the queue. Items
 * that keep failing have their `attempts` counter incremented so you can
 * eventually flag/alert on a title that's been failing for a long time.
 *
 * IMPORTANT: a single anime can produce MULTIPLE error entries in `failed`
 * in the same run (e.g. Jikan fails AND Kitsu fails AND AniList fails for
 * the same id). That must still only count as ONE retry attempt - so
 * failures are grouped by id first, and every reason for that id in this
 * run is kept (not just the last one processed).
 */
export function updateRetryQueue(existingQueue, { failed = [], succeededIds = [] }) {
  const succeededSet = new Set(succeededIds.map(String));
  const byId = new Map(existingQueue.map((item) => [String(item.id), item]));

  for (const id of succeededSet) {
    byId.delete(String(id));
  }

  const failuresById = new Map();
  for (const failure of failed) {
    const key = String(failure.id);
    if (!failuresById.has(key)) failuresById.set(key, []);
    failuresById.get(key).push({ source: failure.source, message: failure.message });
  }

  for (const [key, reasons] of failuresById) {
    const prev = byId.get(key);
    const numericId = Number(key);
    byId.set(key, {
      id: Number.isNaN(numericId) ? key : numericId,
      reasons, // e.g. [{ source: "Jikan", message: "..." }, { source: "Kitsu", message: "..." }]
      attempts: (prev?.attempts ?? 0) + 1,
      firstFailedAt: prev?.firstFailedAt ?? new Date().toISOString(),
      lastAttempt: new Date().toISOString(),
    });
  }

  return [...byId.values()];
}
