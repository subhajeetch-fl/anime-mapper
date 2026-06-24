/**
 * Minimal rate limiter: ensures at least `minIntervalMs` passes between
 * calls made through the same limiter instance. One instance per API
 * source, since each has a different safe pace:
 *
 *   Jikan            ~3 req/s, 60 req/min      -> 450ms between calls
 *   AniList          ~30 req/min (degraded)    -> 2200ms between calls
 *   Kitsu            no published hard limit   -> 600ms (be polite)
 *   animeapi.my.id   no published hard limit   -> 300ms (be polite)
 *   Zenshin           no published hard limit   -> 500ms (be polite)
 *   Simkl            HTML scrape, be polite    -> 1500ms between calls
 *
 * This is intentionally simple (sequential pacing, not a token bucket)
 * because the crawler processes anime one at a time, not in parallel -
 * parallel fetching across 4-5 free APIs is the fastest way to get IP
 * banned, and isn't worth it for an incremental update job.
 */
import { sleep } from './httpClient.js';

export function createRateLimiter(minIntervalMs) {
  let lastCallAt = 0;

  return async function throttle() {
    const now = Date.now();
    const elapsed = now - lastCallAt;
    if (elapsed < minIntervalMs) {
      await sleep(minIntervalMs - elapsed);
    }
    lastCallAt = Date.now();
  };
}

export const jikanLimiter = createRateLimiter(450);
export const aniListLimiter = createRateLimiter(2200);
export const kitsuLimiter = createRateLimiter(600);
export const idMappingLimiter = createRateLimiter(300);
export const zenshinLimiter = createRateLimiter(500);
