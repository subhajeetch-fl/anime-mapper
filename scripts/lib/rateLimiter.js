/**
 * Minimal rate limiter: ensures at least `minIntervalMs` passes between
 * calls made through the same limiter instance. One instance per API
 * source, since each has a different safe pace:
 *
 *   MAL Official     ~3-4 req/s                -> 300ms between calls
 *   Jikan (legacy)   ~3 req/s, 60 req/min      -> 450ms between calls
 *   AniList          ~30 req/min (degraded)    -> 2200ms between calls
 *   Kitsu            be polite                 -> 500ms between calls
 *   Zenshin / AniZip be polite                 -> 450ms between calls
 *   idMapping        in-memory Map cache       -> 0-50ms (no wait needed)
 */
import { sleep } from './httpClient.js';

export function createRateLimiter(minIntervalMs) {
  let nextAllowedAt = 0;

  return async function throttle() {
    const now = Date.now();
    const wait = Math.max(0, nextAllowedAt - now);
    if (wait > 0) {
      await sleep(wait);
    }
    nextAllowedAt = Date.now() + minIntervalMs;
  };
}

export const malLimiter = createRateLimiter(300);
export const jikanLimiter = createRateLimiter(450);
export const aniListLimiter = createRateLimiter(2200);
export const kitsuLimiter = createRateLimiter(500);
export const idMappingLimiter = createRateLimiter(50);
export const zenshinLimiter = createRateLimiter(450);
