// Read-only deployment check. No downloads, analytics events or form submissions.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { origin, pages } from './landing/site.mjs';
import { securityHeaders } from './landing/security.mjs';
const root = new URL('../', import.meta.url);
const checkedImages = new Set();
for (const page of pages) {
  const response = await fetch(origin + page.path, { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, page.path);
  for (const [name, value] of Object.entries(securityHeaders)) assert.equal(response.headers.get(name), value, `${page.path}: ${name}`);
  const html = await response.text();
  const local = await readFile(new URL(`landing/${page.file}`, root), 'utf8');
  const metadata = text => text.match(/<!-- site-metadata:start[\s\S]*?<!-- site-metadata:end -->/)?.[0];
  assert.equal(metadata(html), metadata(local), `${page.path}: deployed metadata differs`);
  assert.ok(!response.headers.get('x-robots-tag')?.includes('noindex'));
  if (!checkedImages.has(page.image)) {
    const image = await fetch(`${origin}/assets/share/${page.image}`, { signal: AbortSignal.timeout(15000) });
    assert.equal(image.status, 200); assert.match(image.headers.get('content-type'), /image\/png/);
    const bytes = Buffer.from(await image.arrayBuffer());
    const expected = await readFile(new URL(`landing/assets/share/${page.image}`, root));
    assert.ok(bytes.equals(expected), 'Deployed image differs');
    checkedImages.add(page.image);
  }
  console.log(`Verified ${page.path}: metadata, headers, social image`);
}
for (const path of ['robots.txt', 'sitemap.xml', 'llms.txt']) {
  const response = await fetch(`${origin}/${path}`, { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), await readFile(new URL(`landing/${path}`, root), 'utf8'));
}
for (const path of ['warden-missing-page-check', 'README.md', 'social-card.html', '.env', 'data/settings.json']) {
  const response = await fetch(`${origin}/${path}`, { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 404, `${path} must not be published`);
}
console.log('Verified crawl files, 404 behavior and private/source exclusions.');
