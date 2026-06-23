/**
 * Playwright browser manager.
 *
 * Key design decisions vs. the old version:
 *
 * - The browser is a singleton (expensive to launch), but contexts are NOT.
 *   A shared context means Cloudflare can fingerprint one page and block all
 *   subsequent ones that share the same cookies/state. Instead, callers get a
 *   fresh context each time via `newContext()` and are responsible for closing
 *   it when done.
 *
 * - Stealth launch args are expanded to better match a real Chrome install and
 *   reduce Cloudflare's bot-detection signal.
 *
 * - `closeBrowser()` is unchanged in API.
 */

import { chromium } from 'playwright';

let browserPromise = null;

const STEALTH_ARGS = [
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disable-setuid-sandbox',

  // Reduce bot signals
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-infobars',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-sync',
  '--metrics-recording-only',
  '--safebrowsing-disable-auto-update',
  '--password-store=basic',
  '--use-mock-keychain',

  // Match a plausible viewport
  '--window-size=1920,1080',
];

/**
 * Returns the shared browser instance, launching it on first call.
 * @returns {Promise<import('playwright').Browser>}
 */
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: STEALTH_ARGS,
    });
  }
  return browserPromise;
}

/**
 * Create a fresh browser context with a realistic user-agent and resource
 * blocking. Callers MUST call `context.close()` when done — this is not
 * managed here.
 *
 * Using a fresh context per scrape target isolates cookies, storage, and TLS
 * fingerprints so a Cloudflare block on one request cannot contaminate others.
 *
 * @returns {Promise<import('playwright').BrowserContext>}
 */
export async function newContext() {
  const browser = await getBrowser();

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    // Mimic a real browser that accepts typical web content
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  // Block heavy assets — we only need the DOM
  await context.route('**/*', route => {
    const type = route.request().resourceType();
    if (type === 'image' || type === 'font' || type === 'media') {
      return route.abort();
    }
    return route.continue();
  });

  return context;
}

/**
 * Shut down the browser. Call this in your process teardown / finally block.
 */
export async function closeBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
  }
  browserPromise = null;
}