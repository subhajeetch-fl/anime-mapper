/**
 * Simkl episode scraper.
 *
 * Scrapes episode data from Simkl's HTML pages — specifically the `hasDub`
 * flag (via the `has-dub` CSS class on episode divs) which other APIs tend to
 * get wrong or leave as false.
 *
 * URL pattern:
 * https://simkl.com/anime/{simklId}/m/episodes/
 *
 * This is an HTML scraper (not an API), so it requires cheerio and a
 * browser-like User-Agent.
 *
 * Cloudflare notes
 * ────────────────
 * Simkl sits behind Cloudflare. To avoid blocks:
 *
 * 1. Fresh context per request — a shared context means one fingerprinted
 *    context blocks ALL subsequent requests. `newContext()` from browser.js
 *    creates an isolated context (cookies, storage, TLS) each time.
 *
 * 2. Wait for a real DOM selector — Cloudflare's JS challenge takes 4-6 s to
 *    resolve. A fixed `waitForTimeout` races against that. Instead we wait for
 *    the selector that proves the actual page loaded.
 *
 * 3. Jittered inter-request delay — rapid sequential requests are a strong bot
 *    signal. A randomised delay between calls blends into human-ish traffic.
 *
 * Simkl is treated as an enrichment source only:
 * failures should NOT block anime generation.
 */

import * as cheerio from 'cheerio';
import { newContext } from './browser.js';

const BASE_URL = 'https://simkl.com/anime';
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 20000;

// Delay between consecutive top-level calls (not retries).
// Jitter keeps the pattern from looking mechanical.
const INTER_REQUEST_DELAY_MS = 3000;
const INTER_REQUEST_JITTER_MS = 2000;

// How long to wait for the Cloudflare challenge + real page to settle.
// Cloudflare's managed-challenge JS typically resolves in 4-6 s.
const CF_SETTLE_TIMEOUT_MS = 10000;

// A selector that only appears on the real episode page, not the CF challenge.
const READY_SELECTOR = '.SimklTVAboutTabsDetailsDiv, .SimklTVAboutTabsDetailsSeasonHead';

// Exponential back-off base for retries (ms).
const RETRY_BASE_DELAY_MS = 3000;

// Track the timestamp of the last fetch so we can enforce inter-request delay
// even across different simklIds called in tight succession from the outside.
let lastFetchAt = 0;

/**
 * Sleep for `ms` milliseconds.
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Enforce a minimum gap between outbound requests.
 * Adds random jitter to avoid perfectly regular timing.
 */
async function throttle() {
  const jitter = Math.random() * INTER_REQUEST_JITTER_MS;
  const delay = INTER_REQUEST_DELAY_MS + jitter;
  const elapsed = Date.now() - lastFetchAt;
  const remaining = delay - elapsed;
  if (remaining > 0) {
    await sleep(remaining);
  }
}

/**
 * Fetch episode data from Simkl.
 *
 * @param {number|string} simklId
 * @returns {Promise<object|null>}
 */
export async function getEpisodesBySimklId(simklId) {
  if (!simklId) return null;

  const url = `${BASE_URL}/${simklId}/m/episodes/`;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Enforce inter-request gap on every attempt (not just the first),
    // so retries also back off from the server's perspective.
    await throttle();

    let context = null;

    try {
      // Fresh isolated context — no shared cookies/state with previous requests.
      context = await newContext();
      const page = await context.newPage();

      try {
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: REQUEST_TIMEOUT_MS,
        });

        // Wait for either the real page content OR a Cloudflare challenge node.
        // We give it enough time for the CF JS challenge to auto-solve (4-6 s).
        await page
          .waitForSelector(READY_SELECTOR, { timeout: CF_SETTLE_TIMEOUT_MS })
          .catch(() => null); // If it times out, fall through to the CF check below

        const html = await page.content();

        if (
          html.includes('Just a moment') ||
          html.includes('Enable JavaScript and cookies')
        ) {
          throw new Error('Cloudflare challenge not solved');
        }

        lastFetchAt = Date.now();
        return parseEpisodes(html, simklId);
      } finally {
        await page.close();
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < MAX_ATTEMPTS) {
        const backoff = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        console.warn(
          `[Simkl] Attempt ${attempt}/${MAX_ATTEMPTS} failed for ${simklId}: ${lastError.message} — retrying in ${backoff}ms`
        );
        await sleep(backoff);
        continue;
      }
    } finally {
      // Always close the context so its cookies/state don't persist.
      if (context) {
        await context.close().catch(() => null);
      }
    }
  }

  console.warn(
    `[Simkl] Failed to fetch episodes for ${simklId} after ${MAX_ATTEMPTS} attempts: ${lastError?.message}`
  );

  return null;
}

/**
 * Parse Simkl episode page HTML.
 *
 * Only the main "Episodes" section is parsed.
 * Specials / OVAs / Extras are ignored.
 *
 * @param {string} html
 * @param {number|string} simklId
 * @returns {object}
 */
function parseEpisodes(html, simklId) {
  const $ = cheerio.load(html);

  const episodes = [];
  let currentSection = '';

  $('td > *').each((_, el) => {
    const $el = $(el);

    if ($el.hasClass('SimklTVAboutTabsDetailsSeasonHead')) {
      currentSection = $el.text().trim().toLowerCase();
      return;
    }

    if (
      currentSection !== 'episodes' ||
      !$el.hasClass('SimklTVAboutTabsDetailsDiv') ||
      !$el.hasClass('goEpisode')
    ) {
      return;
    }

    const epText = $el.find('.SimklTVEpisodesEpNumber').text().trim();

    if (!/^Ep\.\s*\d+$/i.test(epText)) {
      return;
    }

    const episodeNumber = Number(epText.replace(/[^\d]/g, ''));

    episodes.push({
      episode: episodeNumber,
      hasDub: $el.hasClass('has-dub'),
      simklEpisodeId: $el.attr('data-id') || null,
    });
  });

  return {
    simklId: String(simklId),
    totalEpisodes: episodes.length,
    dubbedEpisodes: episodes.filter(ep => ep.hasDub).length,
    episodes,
  };
}

/**
 * Build lookup map keyed by episode number.
 *
 * Example:
 *
 * {
 *   "1": {
 *     isDubbed: true,
 *     simklEpisodeId: "4737507"
 *   }
 * }
 *
 * @param {object|null} simklResult
 * @returns {Record<string, { isDubbed: boolean, simklEpisodeId: string|null }>}
 */
export function buildSimklLookup(simklResult) {
  if (!simklResult?.episodes) {
    return {};
  }

  const lookup = {};
  for (const ep of simklResult.episodes) {
    lookup[String(ep.episode)] = {
      isDubbed: ep.hasDub,
      simklEpisodeId: ep.simklEpisodeId,
    };
  }

  return lookup;
}