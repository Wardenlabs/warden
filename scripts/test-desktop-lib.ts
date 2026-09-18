/**
 * The desktop shell reaches the server by name, through a dynamic import of
 * the compiled `src/setup/` modules, and declares what it expects in two
 * types in `desktop/first-run.ts`. Nothing static ties the two together: a
 * function the shell calls can be deleted from `src/` with every typecheck
 * green, and the app then opens with "lib.X is not a function" — which is
 * exactly what v0.1.37 did. This reads the shell's declared contract and
 * checks every member exists on the module it will import.
 *
 * Run: pnpm run test:desktop
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const shell = readFileSync('desktop/first-run.ts', 'utf8');

function members(typeName: string): string[] {
  const block = new RegExp(`type ${typeName} = \\{([^}]*)\\}`).exec(shell)?.[1];
  assert.ok(block, `desktop/first-run.ts no longer declares ${typeName}`);
  return [...block.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]!);
}

const download = await import('../src/setup/download.js');
for (const name of members('DownloadLib')) {
  assert.equal(typeof (download as Record<string, unknown>)[name], 'function', `src/setup/download.ts must export function ${name}: the desktop shell calls it`);
}
const catalog = await import('../src/setup/catalog.js');
for (const name of members('CatalogLib')) {
  assert.ok(name in catalog, `src/setup/catalog.ts must export ${name}: the desktop shell reads it`);
}
console.log(`✓ the desktop shell's contract holds: ${[...members('DownloadLib'), ...members('CatalogLib')].join(', ')}`);

const temporary = mkdtempSync(join(tmpdir(), 'warden-setup-models-'));
const settingsPath = join(temporary, 'settings.json');
const baseRoles = ['detector', 'adjudicator', 'embedder'];
const localRoles = ['detector', 'adjudicator', 'compiler', 'embedder'];
const savedCompiler = (provider: string, extra = {}) => ({ provider, baseUrl: '', apiKey: '', model: '', redactNames: false, ...extra });
const roles = (extras = false, env: NodeJS.ProcessEnv = {}) => catalog.setupModelDownloads(settingsPath, extras, env).map((spec) => spec.role);
const save = (value: unknown) => writeFileSync(settingsPath, JSON.stringify(value));

try {
  assert.deepEqual(roles(), baseRoles, 'fresh Claude-default installs need only existing guard models');
  assert.equal(catalog.setupModelDownloads(settingsPath, false, {}).reduce((total, spec) => total + spec.approxMB, 0), 4315);
  save({ adjudicator: { model: 'default' } });
  assert.deepEqual(roles(), baseRoles, 'unrelated prior settings do not opt into a local compiler');
  for (const provider of ['claude-cli', 'codex-cli', 'gemini-cli', 'opencode-cli', 'cursor-cli', 'copilot-cli']) {
    save({ compiler: savedCompiler(provider) });
    assert.deepEqual(roles(), baseRoles, `${provider} does not require bundled compiler weights`);
  }
  save({ compiler: savedCompiler('custom', { baseUrl: 'https://example.invalid/v1', apiKey: 'test-key' }) });
  assert.deepEqual(roles(), baseRoles, 'saved remote endpoint');
  save({ compiler: savedCompiler('custom', { baseUrl: 'http://127.0.0.1:8081/v1' }) });
  assert.deepEqual(roles(), baseRoles, 'saved loopback endpoint without an API key');
  save({ compiler: savedCompiler('catalog', { modelId: '37a597f3-07ac-4d88-8b66-cf2cc07c3256' }) });
  assert.deepEqual(roles(), baseRoles, 'imported compiler owns its own weights or endpoint');
  console.log('✓ new/default CLI and saved endpoint/imported compilers skip the 1100 MB local compiler');

  save({ compiler: savedCompiler('local') });
  assert.deepEqual(roles(), localRoles, 'choosing local after first run adds the download back');
  assert.equal(catalog.setupModelDownloads(settingsPath, false, {}).reduce((total, spec) => total + spec.approxMB, 0), 5415);
  for (const key of ['WARDEN_COMPILER_CLI', 'WARDEN_COMPILER_API', 'WARDEN_MODEL_COMPILER']) {
    assert.deepEqual(roles(false, { [key]: 'explicit-configuration' }), baseRoles, `${key} preserves its own compiler selection`);
    assert.deepEqual(roles(false, { [key]: '  ' }), localRoles, `${key} with whitespace is not a selection`);
  }
  save({ compiler: savedCompiler('custom') });
  assert.deepEqual(roles(), localRoles, 'legacy incomplete endpoint falls back to local at runtime');
  for (const value of [null, [], { compiler: null }, { compiler: { provider: 'claude-cli' } }]) {
    save(value);
    assert.deepEqual(roles(), localRoles, 'invalid prior settings keep the existing local fallback usable');
  }
  writeFileSync(settingsPath, '{broken');
  assert.deepEqual(roles(), localRoles);
  assert.equal(readFileSync(settingsPath, 'utf8'), '{broken', 'planning downloads never rewrites configuration');
  console.log('✓ explicit local and environment choices are preserved; unreadable prior settings stay local');

  save({ compiler: savedCompiler('claude-cli'), adjudicator: { model: 'base' } });
  assert.deepEqual(roles(), localRoles, 'Qwen analyzer needs its shared file even with a Claude compiler');
  assert.deepEqual(roles(true), localRoles, 'shared compiler/base-analyzer file is never downloaded twice');
  assert.deepEqual(roles(true, { WARDEN_MODEL_ADJUDICATOR: '/explicit/analyzer.gguf' }), baseRoles);
  for (const seat of ['large', 'dynaguard', 'dynaguard-8b', 'shieldstral', 'granite-guardian']) {
    save({ compiler: savedCompiler('claude-cli'), adjudicator: { model: seat } });
    assert.deepEqual(roles(), baseRoles, 'optional analyzer download does not gate automatic demo exit');
    assert.deepEqual(roles(true), [...baseRoles, `adjudicator-${seat}`], `desktop explicitly downloads selected ${seat} analyzer`);
  }
  save({ adjudicator: { model: 'base', modelId: '37a597f3-07ac-4d88-8b66-cf2cc07c3256' } });
  assert.deepEqual(roles(true), baseRoles, 'custom analyzer does not trigger an unused bundled seat');
  console.log('✓ analyzer defaults and selected alternate downloads remain intact, including the shared Qwen base seat');

  // Use the actual disk-presence algorithm with small stand-ins for large
  // weights. The selected plan is what both desktop boot and setup consume.
  save({ compiler: savedCompiler('claude-cli') });
  const tiny = catalog.setupModelDownloads(settingsPath, false, {}).map((spec) => ({ ...spec, approxMB: 0.00001 }));
  assert.equal(download.missingModels(temporary, tiny).length, 3);
  for (const spec of tiny) writeFileSync(join(temporary, spec.filename), 'test-weights');
  assert.deepEqual(download.missingModels(temporary, tiny), [], 'Claude-default desktop can boot without Qwen compiler file');
  save({ compiler: savedCompiler('local') });
  const selectedLocal = catalog.setupModelDownloads(settingsPath, false, {}).map((spec) => ({ ...spec, approxMB: 0.00001 }));
  assert.deepEqual(download.missingModels(temporary, selectedLocal).map((spec) => spec.role), ['compiler']);
  const compiler = selectedLocal.find((spec) => spec.role === 'compiler')!;
  writeFileSync(join(temporary, compiler.filename), 'test-weights');
  assert.deepEqual(download.missingModels(temporary, selectedLocal), [], 'local selection becomes ready once its download arrives');
  console.log('✓ actual missing-model checks accept Claude-only setup and request weights after selecting local');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
