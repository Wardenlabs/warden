import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
execFileSync(process.execPath, [fileURLToPath(new URL('scripts/landing/metadata.mjs', root)), '--check'], { stdio: 'inherit' });
await import('./build-kool-browser.mjs');
const output = new URL('.landing-dist/', root);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
// Only public site formats and asset trees enter the deployment output.
for (const entry of await readdir(new URL('landing/', root), { withFileTypes: true })) {
  const assetTree = entry.isDirectory() && ['assets', 'vendor'].includes(entry.name);
  const publicFile = entry.isFile() && /\.(html|css|js|png|svg|xml|txt)$/.test(entry.name)
    && entry.name !== 'social-card.html';
  if (!assetTree && !publicFile) continue;
  const destination = new URL(entry.name, output);
  await cp(new URL(`landing/${entry.name}`, root), destination, { recursive: assetTree });
  if (process.env.VERCEL_ENV === 'preview' && entry.name.endsWith('.html')) {
    const html = await readFile(destination, 'utf8');
    await writeFile(destination, html.replace(/<meta name="robots"[^>]*>/, '<meta name="robots" content="noindex, follow">'));
  }
}
if (process.env.VERCEL_ENV === 'preview') await writeFile(new URL('robots.txt', output), 'User-agent: *\nDisallow: /\n');
console.log('Built public site in .landing-dist/');
