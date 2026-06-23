import { chromium } from 'playwright';

let browserPromise = null;
let contextPromise = null;

export async function getContext() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: [
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ]
    });
  }

  const browser = await browserPromise;

  if (!contextPromise) {
    contextPromise = browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
    });

    const context = await contextPromise;

    await context.route('**/*', route => {
      const type = route.request().resourceType();

      if (
        type === 'image' ||
        type === 'font' ||
        type === 'media'
      ) {
        return route.abort();
      }

      return route.continue();
    });
  }

  return contextPromise;
}

export async function closeBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
  }

  browserPromise = null;
  contextPromise = null;
}