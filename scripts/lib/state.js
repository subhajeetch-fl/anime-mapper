/**
 * Pipeline state stored in data/.pipeline-state/ and committed with the repo.
 * There is no external database: every workflow can resume from these files.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const STATE_DIR = path.resolve('data/.pipeline-state');

const LAST_UPDATED_PATH = path.join(STATE_DIR, 'last-updated.json');
const RETRY_QUEUE_PATH = path.join(STATE_DIR, 'retry-queue.json');
const DISCOVERED_IDS_PATH = path.join(STATE_DIR, 'discovered-ids.json');
const ADD_CURSOR_PATH = path.join(STATE_DIR, 'add-cursor.json');
const UPDATE_CURSOR_PATH = path.join(STATE_DIR, 'update-cursor.json');
const FAILED_PERMANENT_PATH = path.join(STATE_DIR, 'failed-permanent.json');

async function readJsonSafe(filePath, fallback) {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return structuredClone(fallback);
    console.warn(`[state] failed to read ${filePath}; using fallback (${err.message})`);
    return structuredClone(fallback);
  }
}

async function writeJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

function normalizeIdArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((id) => Number.isInteger(id) && id > 0))].sort(
    (a, b) => a - b
  );
}

function normalizeCursorIndex(value, maxLength = Number.MAX_SAFE_INTEGER) {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0) return 0;
  return Math.min(index, Math.max(0, maxLength));
}

// last-updated: tracks successful checks, not only file writes.

export async function loadLastUpdated() {
  const value = await readJsonSafe(LAST_UPDATED_PATH, {});
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export async function saveLastUpdated(map) {
  await writeJson(LAST_UPDATED_PATH, map && typeof map === 'object' ? map : {});
}

export function markUpdated(map, malId) {
  map[String(malId)] = new Date().toISOString();
  return map;
}

export function isFresh(map, malId, maxAgeHours) {
  const timestamp = map[String(malId)];
  if (!timestamp) return false;

  const checkedAt = new Date(timestamp).getTime();
  if (!Number.isFinite(checkedAt)) return false;

  return Date.now() - checkedAt < maxAgeHours * 60 * 60 * 1000;
}

// retry queue: retry any anime that had hard or soft source errors.

export async function loadRetryQueue() {
  const value = await readJsonSafe(RETRY_QUEUE_PATH, []);
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => ({
      id: Number(item.id),
      reasons: Array.isArray(item.reasons) ? item.reasons : [],
      attempts: Number.isInteger(item.attempts) && item.attempts > 0 ? item.attempts : 1,
      firstFailedAt: item.firstFailedAt ?? new Date().toISOString(),
      lastAttempt: item.lastAttempt ?? item.firstFailedAt ?? new Date().toISOString(),
    }))
    .filter((item) => Number.isInteger(item.id) && item.id > 0);
}

export async function saveRetryQueue(queue) {
  const clean = Array.isArray(queue)
    ? queue
        .filter((item) => Number.isInteger(Number(item.id)) && Number(item.id) > 0)
        .sort((a, b) => Number(a.id) - Number(b.id))
    : [];

  await writeJson(RETRY_QUEUE_PATH, clean);
}

/**
 * Merge this run's source errors into the retry queue.
 *
 * If an id succeeded with no errors, it is removed from the queue. If it
 * succeeded with soft source errors, pass both succeededIds and failed; the
 * id is removed first, then re-added with the new failure reasons.
 */
export function updateRetryQueue(existingQueue, { failed = [], succeededIds = [] } = {}) {
  const now = new Date().toISOString();
  const byId = new Map();

  for (const item of Array.isArray(existingQueue) ? existingQueue : []) {
    const id = Number(item.id);
    if (!Number.isInteger(id) || id <= 0) continue;

    byId.set(String(id), {
      id,
      reasons: Array.isArray(item.reasons) ? item.reasons : [],
      attempts: Number.isInteger(item.attempts) && item.attempts > 0 ? item.attempts : 1,
      firstFailedAt: item.firstFailedAt ?? now,
      lastAttempt: item.lastAttempt ?? now,
    });
  }

  for (const id of succeededIds) {
    byId.delete(String(Number(id)));
  }

  const failuresById = new Map();
  for (const failure of Array.isArray(failed) ? failed : []) {
    const id = Number(failure.id);
    if (!Number.isInteger(id) || id <= 0) continue;

    const key = String(id);
    if (!failuresById.has(key)) failuresById.set(key, []);
    failuresById.get(key).push({
      source: failure.source ?? 'unknown',
      message: failure.message ?? 'Unknown error',
      status: failure.status ?? null,
    });
  }

  for (const [key, reasons] of failuresById) {
    const previous = byId.get(key);
    byId.set(key, {
      id: Number(key),
      reasons,
      attempts: (previous?.attempts ?? 0) + 1,
      firstFailedAt: previous?.firstFailedAt ?? now,
      lastAttempt: now,
    });
  }

  return [...byId.values()].sort((a, b) => a.id - b.id);
}

// discovered ids: full MAL id list discovered from Jikan search pages.

export async function loadDiscoveredIds() {
  const value = await readJsonSafe(DISCOVERED_IDS_PATH, {
    ids: [],
    lastDiscoveredAt: null,
    lastPageScanned: 0,
  });

  return {
    ids: normalizeIdArray(value.ids),
    lastDiscoveredAt: value.lastDiscoveredAt ?? null,
    lastPageScanned:
      Number.isInteger(value.lastPageScanned) && value.lastPageScanned > 0
        ? value.lastPageScanned
        : 0,
  };
}

export function mergeDiscoveredIds(current, newIds, { lastPageScanned = null } = {}) {
  const ids = normalizeIdArray([...(current?.ids ?? []), ...(newIds ?? [])]);
  const knownLastPage =
    Number.isInteger(current?.lastPageScanned) && current.lastPageScanned > 0
      ? current.lastPageScanned
      : 0;

  return {
    ids,
    lastDiscoveredAt: new Date().toISOString(),
    lastPageScanned:
      Number.isInteger(lastPageScanned) && lastPageScanned > 0
        ? Math.max(knownLastPage, lastPageScanned)
        : knownLastPage,
  };
}

export async function saveDiscoveredIds(state) {
  await writeJson(DISCOVERED_IDS_PATH, {
    ids: normalizeIdArray(state?.ids),
    lastDiscoveredAt: state?.lastDiscoveredAt ?? new Date().toISOString(),
    lastPageScanned:
      Number.isInteger(state?.lastPageScanned) && state.lastPageScanned > 0
        ? state.lastPageScanned
        : 0,
  });
}

// add cursor: progress through discovered ids in batches of at most 2000.

export async function loadAddCursor() {
  const value = await readJsonSafe(ADD_CURSOR_PATH, {
    nextIndex: 0,
    addedIds: [],
    lastRunAt: null,
  });

  return {
    nextIndex: normalizeCursorIndex(value.nextIndex),
    addedIds: normalizeIdArray(value.addedIds),
    lastRunAt: value.lastRunAt ?? null,
  };
}

export async function saveAddCursor(cursor) {
  await writeJson(ADD_CURSOR_PATH, {
    nextIndex: normalizeCursorIndex(cursor?.nextIndex),
    addedIds: normalizeIdArray(cursor?.addedIds),
    lastRunAt: cursor?.lastRunAt ?? new Date().toISOString(),
  });
}

export function pickNextAddBatch(discovered, cursor, skipIds = [], batchSize = 2000) {
  const ids = normalizeIdArray(discovered?.ids);
  const blocked = new Set([
    ...normalizeIdArray(cursor?.addedIds).map(String),
    ...normalizeIdArray(skipIds).map(String),
  ]);
  const limit = Math.max(0, Math.floor(Number(batchSize) || 0));

  const items = [];
  for (let index = 0; index < ids.length; index++) {
    if (items.length >= limit) break;
    const id = ids[index];
    if (!blocked.has(String(id))) {
      items.push({ id, index });
    }
  }

  const lastItem = items[items.length - 1];
  const nextIndex = lastItem ? lastItem.index + 1 : 0;
  return { items, nextIndex };
}

export function pickNextBatch(discovered, cursor, permanentlyFailed, batchSize) {
  const { items, nextIndex } = pickNextAddBatch(
    discovered,
    cursor,
    permanentlyFailed,
    batchSize
  );
  return { batch: items.map((item) => item.id), newIndex: nextIndex };
}

// update cursor: round-robin progress through non-completed catalog ids.

export async function loadUpdateCursor() {
  const value = await readJsonSafe(UPDATE_CURSOR_PATH, {
    nextIndex: 0,
    lastRunAt: null,
  });

  return {
    nextIndex: normalizeCursorIndex(value.nextIndex),
    lastRunAt: value.lastRunAt ?? null,
  };
}

export async function saveUpdateCursor(cursor) {
  await writeJson(UPDATE_CURSOR_PATH, {
    nextIndex: normalizeCursorIndex(cursor?.nextIndex),
    lastRunAt: cursor?.lastRunAt ?? new Date().toISOString(),
  });
}

export function pickRoundRobinBatch(ids, cursor, batchSize, skipIds = []) {
  const cleanIds = normalizeIdArray(ids);
  const blocked = new Set(normalizeIdArray(skipIds).map(String));
  const limit = Math.max(0, Math.floor(Number(batchSize) || 0));

  if (cleanIds.length === 0) {
    return { items: [], nextIndex: 0 };
  }

  if (limit === 0) {
    return {
      items: [],
      nextIndex: normalizeCursorIndex(cursor?.nextIndex, cleanIds.length - 1),
    };
  }

  const start = normalizeCursorIndex(cursor?.nextIndex, cleanIds.length - 1);
  const items = [];
  let visited = 0;
  let index = start;

  while (visited < cleanIds.length && items.length < limit) {
    const id = cleanIds[index];
    if (!blocked.has(String(id))) {
      items.push({ id, index });
    }

    index = (index + 1) % cleanIds.length;
    visited += 1;
  }

  return { items, nextIndex: index };
}

// permanent failures: discovered ids that do not exist on primary sources.

export async function loadPermanentlyFailed() {
  const value = await readJsonSafe(FAILED_PERMANENT_PATH, []);
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => ({
      id: Number(entry.id),
      reason: entry.reason ?? 'Permanent primary-source miss',
      failedAt: entry.failedAt ?? new Date().toISOString(),
    }))
    .filter((entry) => Number.isInteger(entry.id) && entry.id > 0)
    .sort((a, b) => a.id - b.id);
}

export function mergePermanentlyFailed(existing, newEntries) {
  const byId = new Map();

  for (const entry of Array.isArray(existing) ? existing : []) {
    const id = Number(entry.id);
    if (Number.isInteger(id) && id > 0) {
      byId.set(String(id), {
        id,
        reason: entry.reason ?? 'Permanent primary-source miss',
        failedAt: entry.failedAt ?? new Date().toISOString(),
      });
    }
  }

  for (const entry of Array.isArray(newEntries) ? newEntries : []) {
    const id = Number(entry.id);
    if (!Number.isInteger(id) || id <= 0 || byId.has(String(id))) continue;

    byId.set(String(id), {
      id,
      reason: entry.reason ?? 'Permanent primary-source miss',
      failedAt: new Date().toISOString(),
    });
  }

  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export async function savePermanentlyFailed(list) {
  await writeJson(FAILED_PERMANENT_PATH, mergePermanentlyFailed([], list));
}
