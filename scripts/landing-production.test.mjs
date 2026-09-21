import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { origin, pages } from './landing/site.mjs';
import { securityHeaders } from './landing/security.mjs';
const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const run = (script, args = [], extraEnv = {}) => execFileSync(process.execPath,
  [fileURLToPath(new URL(script, root)), ...args], { env: { ...process.env, ...extraEnv }, stdio: 'pipe' });
const meta = (html, key) => html.match(new RegExp(`<meta (?:name|property)="${key}" content="([^"]+)"`))?.[1];

test('all public pages have unique, current metadata and complete social images', async () => {
  run('scripts/landing/metadata.mjs', ['--check']);
  const titles = new Set(), descriptions = new Set();
  for (const page of pages) {
    const html = await read(`landing/${page.file}`);
    const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
    assert.equal(canonical, origin + page.path);
    assert.equal(meta(html, 'og:url'), canonical);
    assert.equal((html.match(/<h1(?:\s|>)/g) || []).length, 1);
    assert.ok(meta(html, 'robots').includes('index, follow'));
    assert.equal(meta(html, 'og:image'), meta(html, 'twitter:image'));
    assert.ok(meta(html, 'og:image:alt'));
    titles.add(html.match(/<title>(.*?)<\/title>/)[1]);
    descriptions.add(meta(html, 'description'));
    const schema = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    assert.equal(schema['@graph'].find(n => n['@type'] === 'WebPage').url, canonical);
    assert.equal(schema['@graph'].find(n => n['@type'] === 'SoftwareApplication').softwareVersion,
      JSON.parse(await read('package.json')).version);
    const image = await readFile(new URL(`landing${new URL(meta(html, 'og:image')).pathname}`, root));
    assert.equal(image.subarray(1, 4).toString(), 'PNG');
    assert.equal(image.readUInt32BE(16), 1200);
    assert.equal(image.readUInt32BE(20), 630);
    assert.ok(image.length < 300_000, 'Share images must stay under 300 KB');
    // No inline executable code can depend on unsafe-inline in the script policy.
    for (const script of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
      assert.ok(script[1].includes('src=') || script[1].includes('application/ld+json'));
    }
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  }
  assert.equal(titles.size, pages.length); assert.equal(descriptions.size, pages.length);
});

test('built public output contains valid local links and excludes source/state', async () => {
  run('scripts/build-landing.mjs', [], { VERCEL_ENV: 'production' });
  const output = '.landing-dist/';
  const names = await readdir(new URL(output, root));
  for (const name of names) assert.ok(!name.startsWith('.') && !name.endsWith('.md'));
  assert.ok(!names.includes('social-card.html'));
  const sitemap = await read(`${output}sitemap.xml`);
  const urls = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);
  assert.deepEqual(urls.sort(), pages.map(p => origin + p.path).sort());
  for (const page of pages) {
    const html = await read(output + page.file);
    for (const match of html.matchAll(/(?:href|src|poster)="([^"]+)"/g)) {
      const url = new URL(match[1].replaceAll('&amp;', '&'), origin + page.path);
      if (url.origin !== origin) continue;
      const targetPage = pages.find(p => p.path === url.pathname || `/${p.file}` === url.pathname);
      const target = targetPage?.file || url.pathname.slice(1);
      assert.ok((await stat(new URL(output + target, root))).isFile(), `Missing ${url.pathname}`);
      if (url.hash && target.endsWith('.html')) {
        assert.ok((await read(output + target)).includes(`id="${url.hash.slice(1)}"`), `Missing anchor ${url.href}`);
      }
    }
  }
  const config = JSON.parse(await read('vercel.json'));
  assert.equal(config.outputDirectory, '.landing-dist');
  assert.deepEqual(Object.fromEntries(config.headers[0].headers.map(h => [h.key, h.value])), securityHeaders);
  assert.ok(securityHeaders['Content-Security-Policy'].includes("object-src 'none'"));
  assert.ok(!securityHeaders['Content-Security-Policy'].split(';').find(d => d.trim().startsWith('script-src')).includes('unsafe-'));
});

test('preview output is noindex while source and production remain indexable', async () => {
  try {
    run('scripts/build-landing.mjs', [], { VERCEL_ENV: 'preview' });
    for (const page of pages) {
      assert.equal(meta(await read(`.landing-dist/${page.file}`), 'robots'), 'noindex, follow');
      assert.ok(meta(await read(`landing/${page.file}`), 'robots').startsWith('index'));
    }
    assert.match(await read('.landing-dist/robots.txt'), /Disallow: \//);
  } finally { run('scripts/build-landing.mjs', [], { VERCEL_ENV: 'production' }); }
});
