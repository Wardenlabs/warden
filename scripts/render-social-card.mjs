import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// Run with Playwright installed, or point PLAYWRIGHT_MODULE to its index.mjs.
// BROWSER_EXECUTABLE optionally selects a locally installed Chromium browser.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'landing/assets/share/warden-share-v2.png');
const source = process.env.SOCIAL_CARD_URL || pathToFileURL(path.join(root, 'landing/social-card.html')).href;

await mkdir(path.dirname(output), { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}),
});

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.goto(source, { waitUntil: 'load' });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images, image => image.decode()));
    if (!document.fonts.check('650 84px Manrope')) throw new Error('Card font failed to load');
  });
  await page.locator('.card').screenshot({ path: output, animations: 'disabled' });
  console.log(output);
} finally {
  await browser.close();
}
