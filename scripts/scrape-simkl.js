import fs from 'fs';
import * as cheerio from 'cheerio';
import { getContext } from './lib/browser.js';

const SIMKL_ID = 784557;
const URL = `https://simkl.com/anime/${SIMKL_ID}/m/episodes/`;

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

const context = await getContext();
const page = await context.newPage();

try {
  console.log(`Fetching ${URL}`);

  await page.goto(URL, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });

  await page.waitForTimeout(3000);

  const html = await page.content();

  fs.writeFileSync(
    'loaded-html.html',
    html
  );

  const result = parseEpisodes(
    html,
    SIMKL_ID
  );

  fs.writeFileSync(
    'anime.json',
    JSON.stringify(result, null, 2)
  );

  console.log(
    `Episodes: ${result.totalEpisodes}`
  );

  console.log(
    `Dubbed: ${result.dubbedEpisodes}`
  );

  console.log(
    result.episodes.slice(0, 10)
  );

} finally {
  await page.close();
}