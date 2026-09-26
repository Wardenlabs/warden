/**
 * Write `warden-release.json`, the manifest every desktop release publishes
 * beside its installers (docs/specs/desktop-auto-update.md §5.1, §8).
 *
 *   node scripts/release-manifest.mjs <out.json> [Info.plist minimum, e.g. 12.0]
 *
 * It describes the build in this checkout: the version from package.json and
 * the model catalogue from the compiled `dist/setup/catalog.js`, so run it
 * after `pnpm run build`. The result is checked with the parser the app
 * itself uses, compiled to `desktop/dist/update-policy.js`, so a manifest the
 * installed base would refuse cannot be published.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [out, minimum] = process.argv.slice(2);
if (!out) {
  console.error('usage: node scripts/release-manifest.mjs <out.json> [minimum macOS]');
  process.exit(2);
}
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const { MODEL_CATALOG } = await import(pathToFileURL(resolve('dist/setup/catalog.js')).href);
const { parseManifest } = await import(pathToFileURL(resolve('desktop/dist/update-policy.js')).href);

const manifest = {
  schema: 1,
  version,
  minimumSystemVersion: minimum ? { darwin: minimum } : {},
  catalog: MODEL_CATALOG.filter((spec) => spec.url).map(({ role, filename, url, approxMB, required }) => ({ role, filename, url, approxMB, required }))
};
const body = JSON.stringify(manifest, null, 2) + '\n';
if (!parseManifest(body)) {
  console.error('the manifest this build would publish is one the app refuses; nothing written');
  process.exit(1);
}
writeFileSync(out, body);
console.log(`[warden] ${out}: v${version}, ${manifest.catalog.length} models, macOS ${minimum ?? 'unstated'}`);
