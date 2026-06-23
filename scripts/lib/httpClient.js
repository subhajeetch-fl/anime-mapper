/**
 * Shared HTTP client used by every source adapter (Jikan, Kitsu, AniList,
 * animeapi.my.id, AniZip).
 *
 * Responsibilities:
 *  - Retries with exponential backoff
 *  - Honors `Retry-After` on 429s (rate limiting)
 *  - Distinguishes "not found" (404 -> null, not an error) from real failures
 *  - Times out hung requests
 *  - Throws a structured FetchError so callers/Discord reporting can log
 *    something useful instead of "fetch failed"
 */

export class FetchError extends Error {
  constructor(message, { url, status = null, attempts, cause = null } = {}) {
    super(message);
    this.name = 'FetchError';
    this.url = url;
    this.status = status;
    this.attempts = attempts;
    this.cause = cause;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} url
 * @param {object} options
 * @param {object} [options.fetchOptions] - passed straight to fetch()
 * @param {number} [options.retries=3] - retry attempts after the first try
 * @param {number} [options.baseDelayMs=1000] - base backoff delay
 * @param {number} [options.timeoutMs=15000]
 * @param {boolean} [options.treat404AsNull=true]
 * @param {string} [options.label] - human readable name for error messages, e.g. "Jikan"
 */
export async function fetchJson(url, options = {}) {
  const {
    fetchOptions = {},
    retries = 3,
    baseDelayMs = 1000,
    timeoutMs = 15000,
    treat404AsNull = true,
    label = 'HTTP',
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, { ...fetchOptions, signal: controller.signal });
      clearTimeout(timeout);

      if (res.status === 404 && treat404AsNull) {
        return null;
      }

      if (res.status === 429) {
        const retryAfterHeader = res.headers.get('retry-after');
        const retryAfterMs = retryAfterHeader
          ? Number(retryAfterHeader) * 1000
          : baseDelayMs * 2 ** attempt;
        lastError = new FetchError(`${label} rate limited (429)`, {
          url,
          status: 429,
          attempts: attempt + 1,
        });
        if (attempt < retries) {
          await sleep(retryAfterMs);
          continue;
        }
        throw lastError;
      }

      if (res.status >= 500) {
        lastError = new FetchError(`${label} server error (${res.status})`, {
          url,
          status: res.status,
          attempts: attempt + 1,
        });
        if (attempt < retries) {
          await sleep(baseDelayMs * 2 ** attempt);
          continue;
        }
        throw lastError;
      }

      if (!res.ok) {
        // 4xx other than 404/429 - not worth retrying, fail fast
        const body = await res.text().catch(() => '');
        throw new FetchError(`${label} returned ${res.status}`, {
          url,
          status: res.status,
          attempts: attempt + 1,
          cause: body.slice(0, 500),
        });
      }

      return await res.json();
    } catch (err) {
      clearTimeout(timeout);

      if (err instanceof FetchError) {
        lastError = err;
      } else if (err.name === 'AbortError') {
        lastError = new FetchError(`${label} timed out after ${timeoutMs}ms`, {
          url,
          attempts: attempt + 1,
          cause: err,
        });
      } else {
        lastError = new FetchError(`${label} network error: ${err.message}`, {
          url,
          attempts: attempt + 1,
          cause: err,
        });
      }

      if (attempt < retries) {
        await sleep(baseDelayMs * 2 ** attempt);
        continue;
      }
      throw lastError;
    }
  }

  throw lastError;
}

export { sleep };
