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
 * Simkl is treated as an enrichment source only:
 * failures should NOT block anime generation.
 */

import * as cheerio from 'cheerio';
import { sleep } from './httpClient.js';
import { getContext } from './browser.js';

const BASE_URL = 'https://simkl.com/anime';
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15000;
const BASE_DELAY_MS = 2000;

/**
 * Fetch episode data from Simkl.
 *
 * @param {number|string} simklId
 * @returns {Promise<object|null>}
 */
export async function getEpisodesBySimklId(simklId) {
  if (!simklId) return null;
//  console.log("parsing:", simklId)

  const url = `${BASE_URL}/${simklId}/m/episodes/`;

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const context = await getContext();

      const page = await context.newPage();

      try {
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: REQUEST_TIMEOUT_MS
        });

        await page.waitForTimeout(2000);

        const html = await page.content();

        if (
          html.includes('Just a moment') ||
          html.includes('Enable JavaScript and cookies')
        ) {
          throw new Error('Cloudflare challenge not solved');
        }

        return parseEpisodes(html, simklId);
      } finally {
        await page.close();
      }
    } catch (error) {
      lastError =
        error instanceof Error
          ? error
          : new Error(String(error));

      if (attempt < MAX_ATTEMPTS) {
        await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
        continue;
      }
    }
  }

  console.warn(
    `[Simkl] Failed to fetch episodes for ${simklId}: ${lastError?.message}`
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

    const epText = $el
      .find('.SimklTVEpisodesEpNumber')
      .text()
      .trim();

    if (!/^Ep\.\s*\d+$/i.test(epText)) {
      return;
    }

    const episodeNumber = Number(
      epText.replace(/[^\d]/g, '')
    );

    episodes.push({
      episode: episodeNumber,
      hasDub: $el.hasClass('has-dub'),
      simklEpisodeId: $el.attr('data-id') || null
    });
  });

  return {
    simklId: String(simklId),
    totalEpisodes: episodes.length,
    dubbedEpisodes: episodes.filter(
      ep => ep.hasDub
    ).length,
    episodes
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
 * @returns {Record<string, {
 *   isDubbed: boolean,
 *   simklEpisodeId: string|null
 * }>}
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