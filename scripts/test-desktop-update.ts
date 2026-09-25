/**
 * The desktop updater's rules, without Electron, a network or a release.
 *
 * `desktop/update-policy.ts` and `desktop/update-marker.ts` import nothing
 * from Electron, which is what lets this run in plain Node. An update itself
 * can only be exercised on two signed, packaged builds (spec §9, §10 S4). This
 * suite pins everything that can be decided before that.
 *
 * Run: pnpm run test:desktop-update
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  adoptionPlan,
  feedUrl,
  isNewer,
  MANIFEST_MAX_BYTES,
  offlineSentence,
  parseManifest,
  previousInstallerUrl,
  resolveAutoUpdate,
  systemAtLeast,
  updateMode
} from '../desktop/update-policy.js';
import {
  adoptPrefetched,
  appendLedger,
  backupData,
  clearMarker,
  readLedger,
  readMarker,
  recordBootAttempt,
  writeMarker,
  type PendingUpdate
} from '../desktop/update-marker.js';

const REV = 'cf94049a948f35ea5b57ad6b3b83cb2e4cc60773';
const model = (filename: string, extra: Record<string, unknown> = {}) => ({
  role: 'adjudicator',
  filename,
  url: `https://huggingface.co/mradermacher/DynaGuard-4B-GGUF/resolve/${REV}/${filename}`,
  approxMB: 3630,
  required: true,
  ...extra
});
const manifest = (extra: Record<string, unknown> = {}) => ({
  schema: 1,
  version: '0.2.24',
  minimumSystemVersion: { darwin: '12.0' },
  catalog: [model('DynaGuard-4B.Q6_K.gguf')],
  ...extra
});
const parse = (value: unknown) => parseManifest(JSON.stringify(value));

// ── manifest ────────────────────────────────────────────────────────────────

const good = parse(manifest());
assert.ok(good);
assert.equal(good.version, '0.2.24');
assert.deepEqual(good.minimumSystemVersion, { darwin: '12.0' });
assert.equal(good.catalog.length, 1);
assert.ok(parse(manifest({ future: 'field' })), 'unknown top-level keys are ignored, so schema 1 can grow');
assert.ok(parse(manifest({ minimumSystemVersion: {} })), 'a release may leave the minimum unsaid');
assert.ok(parse(manifest({ catalog: [] })), 'a release may require no downloadable weights');

const refused: Array<[string, unknown]> = [
  ['schema 2', manifest({ schema: 2 })],
  ['tagged version', manifest({ version: 'v0.2.24' })],
  ['prerelease version', manifest({ version: '0.2.24-beta.1' })],
  ['minimum not a version', manifest({ minimumSystemVersion: { darwin: 'Sonoma' } })],
  ['minimum missing', manifest({ minimumSystemVersion: undefined })],
  ['catalog not a list', manifest({ catalog: {} })],
  ['too many models', manifest({ catalog: Array.from({ length: 33 }, (_, i) => model(`m${i}.gguf`)) })],
  ['duplicate filename', manifest({ catalog: [model('a.gguf'), model('a.gguf')] })],
  ['not gguf', manifest({ catalog: [model('a.bin')] })],
  ['path in filename', manifest({ catalog: [model('../a.gguf')] })],
  ['branch, not a revision', manifest({ catalog: [model('a.gguf', { url: 'https://huggingface.co/o/r/resolve/main/a.gguf' })] })],
  ['short revision', manifest({ catalog: [model('a.gguf', { url: 'https://huggingface.co/o/r/resolve/cf94049a/a.gguf' })] })],
  ['other host', manifest({ catalog: [model('a.gguf', { url: `https://huggingface.co.evil.test/o/r/resolve/${REV}/a.gguf` })] })],
  ['plain http', manifest({ catalog: [model('a.gguf', { url: `http://huggingface.co/o/r/resolve/${REV}/a.gguf` })] })],
  ['url names another file', manifest({ catalog: [model('a.gguf', { url: `https://huggingface.co/o/r/resolve/${REV}/b.gguf` })] })],
  ['query string', manifest({ catalog: [model('a.gguf', { url: `https://huggingface.co/o/r/resolve/${REV}/a.gguf?x=1` })] })],
  ['size zero', manifest({ catalog: [model('a.gguf', { approxMB: 0 })] })],
  ['size absurd', manifest({ catalog: [model('a.gguf', { approxMB: 99_999 })] })],
  ['required missing', manifest({ catalog: [model('a.gguf', { required: undefined })] })],
  ['array at top', [manifest()]]
];
for (const [why, value] of refused) assert.equal(parse(value), null, `refused: ${why}`);
assert.equal(parseManifest('{not json'), null);
assert.equal(parseManifest(' '.repeat(MANIFEST_MAX_BYTES + 1)), null, 'oversized bodies are refused before parsing');
console.log(`✓ the release manifest parser accepts schema 1 and refuses ${refused.length + 2} malformed shapes, all-or-nothing`);

// ── versions ────────────────────────────────────────────────────────────────

assert.ok(isNewer('0.2.24', '0.2.23'));
assert.ok(isNewer('0.3.0', '0.2.99'));
assert.ok(isNewer('1.0.0', '0.99.99'));
assert.ok(isNewer('0.2.10', '0.2.9'), 'numeric, not lexical');
assert.ok(!isNewer('0.2.23', '0.2.23'));
assert.ok(!isNewer('0.2.22', '0.2.23'));
assert.ok(!isNewer('v0.2.24', '0.2.23'), 'unreadable is never newer');
assert.ok(!isNewer('0.2.24', 'dev'));

assert.ok(systemAtLeast('15.5', '12.0'));
assert.ok(systemAtLeast('12.0.0', '12'));
assert.ok(systemAtLeast('12.6.1', '12.6'));
assert.ok(!systemAtLeast('11.7.10', '12.0'));
assert.ok(systemAtLeast('10.15', undefined), 'an unsaid minimum passes');
assert.ok(!systemAtLeast('unknown', '12.0'), 'an unreadable running system does not');
console.log('✓ release and macOS versions compare numerically, and unreadable ones fail safe');

// ── settings precedence ─────────────────────────────────────────────────────

const resolve = (managed: string, environment: string | undefined, saved: boolean) => resolveAutoUpdate({ managed, environment, saved });
assert.deepEqual(resolve('', undefined, true), { enabled: true, source: 'settings' });
assert.deepEqual(resolve('', undefined, false), { enabled: false, source: 'settings' });
assert.deepEqual(resolve('', '0', true), { enabled: false, source: 'environment' });
assert.deepEqual(resolve('', 'true', false), { enabled: true, source: 'environment' });
assert.deepEqual(resolve('', 'maybe', false), { enabled: false, source: 'settings' }, 'an unreadable environment value is ignored');
assert.deepEqual(resolve('0', '1', true), { enabled: false, source: 'managed' }, 'managed beats environment');
assert.deepEqual(resolve('1', '0', false), { enabled: true, source: 'managed' });
assert.deepEqual(resolve('off-please', undefined, true), { enabled: false, source: 'managed' }, 'an unreadable managed value is off');
console.log('✓ managed preference, then environment, then settings; a managed typo turns checks off');

// ── mode, URLs, copy ────────────────────────────────────────────────────────

assert.equal(updateMode({ platform: 'darwin', packaged: true, smoke: false }), 'squirrel-mac');
assert.equal(updateMode({ platform: 'darwin', packaged: false, smoke: false }), 'off');
assert.equal(updateMode({ platform: 'darwin', packaged: true, smoke: true }), 'off');
assert.equal(updateMode({ platform: 'linux', packaged: true, smoke: false }), 'notice');
assert.equal(updateMode({ platform: 'win32', packaged: true, smoke: false }), 'off', 'Windows waits for signing');

assert.equal(feedUrl('0.2.23', 'arm64'), 'https://update.electronjs.org/Wardenlabs/warden/darwin-arm64/0.2.23');
assert.equal(feedUrl('0.2.23', 'x64'), 'https://update.electronjs.org/Wardenlabs/warden/darwin-x64/0.2.23');
assert.equal(feedUrl('0.2.23', 'ia32'), null);
assert.equal(feedUrl('0.2.23-dev', 'arm64'), null);
assert.equal(previousInstallerUrl('0.2.23', 'arm64'), 'https://github.com/Wardenlabs/warden/releases/download/v0.2.23/Warden-arm64.dmg');

assert.match(offlineSentence(false), /for a short time\. Prompts your team sends during that time are not checked\.$/);
assert.doesNotMatch(offlineSentence(false), /public address/);
assert.match(offlineSentence(true), /public address will change/);
console.log('✓ only packaged macOS updates in place; the feed always names the architecture; the warning names the tunnel');

// ── prefetch adoption ───────────────────────────────────────────────────────

const NEXT_URL = `https://huggingface.co/o/r/resolve/${REV}/Next.gguf`;
const next = [
  { filename: 'Next.gguf', url: NEXT_URL },
  { filename: 'Local.gguf', url: null }
];
assert.deepEqual(
  adoptionPlan([
    { filename: 'Next.gguf', url: `https://huggingface.co/o/r/resolve/${REV}/Next.gguf`, forVersion: '0.2.24' },
    { filename: 'Swapped.gguf', url: `https://huggingface.co/o/r/resolve/${REV}/Swapped.gguf`, forVersion: '0.2.24' },
    { filename: 'Next-moved.gguf', url: `https://huggingface.co/o/r/resolve/${REV}/Next.gguf`, forVersion: '0.2.24' },
    { filename: '../escape.gguf', url: 'x', forVersion: '0.2.24' }
  ], next),
  { keep: ['Next.gguf'], remove: ['Swapped.gguf', 'Next-moved.gguf'] }
);
console.log('✓ a prefetched file survives only if the new signed catalogue names the same file at the same URL');

// ── on disk ─────────────────────────────────────────────────────────────────

const userData = mkdtempSync(join(tmpdir(), 'warden-update-'));
const mode = (path: string) => statSync(path).mode & 0o777;
try {
  const marker: PendingUpdate = {
    schema: 1, from: '0.2.23', to: '0.2.24', requestedAt: new Date().toISOString(), stoppedAt: null,
    port: 8080, tunnelWasOn: true, cutOff: 0, backup: 'update/backup-0.2.23', bootAttempts: 0
  };
  assert.equal(readMarker(userData), null);
  writeMarker(userData, marker);
  assert.deepEqual(readMarker(userData), marker);
  assert.equal(mode(join(userData, 'update', 'pending.json')), 0o600);
  assert.equal(mode(join(userData, 'update')), 0o700);
  const attempted = recordBootAttempt(userData, marker);
  assert.equal(attempted.bootAttempts, 1);
  assert.equal(readMarker(userData)?.bootAttempts, 1, 'the attempt is on disk before boot continues');
  for (const broken of ['{', JSON.stringify({ ...marker, port: 0 }), JSON.stringify({ ...marker, to: 'next' }), JSON.stringify({ ...marker, schema: 2 })]) {
    writeFileSync(join(userData, 'update', 'pending.json'), broken);
    assert.equal(readMarker(userData), null);
  }
  clearMarker(userData);
  clearMarker(userData);
  assert.ok(!existsSync(join(userData, 'update', 'pending.json')));
  assert.ok(readdirSync(join(userData, 'update')).every((f) => !f.endsWith('.partial')), 'no torn writes left behind');
  console.log('✓ the pending marker round-trips privately, counts boot attempts first, and reads a broken file as absent');

  mkdirSync(join(userData, 'data', 'nested'), { recursive: true });
  writeFileSync(join(userData, 'data', 'policies.json'), '{"rules":[]}', { mode: 0o644 });
  writeFileSync(join(userData, 'data', 'audit.jsonl'), '{"a":1}\n');
  writeFileSync(join(userData, 'data', 'prompts.jsonl'), 'masked text\n');
  writeFileSync(join(userData, 'data', 'prompts.jsonl.partial'), 'masked text\n');
  writeFileSync(join(userData, 'data', 'nested', 'x.json'), '{}');
  writeFileSync(join(userData, 'credential-key.encrypted'), 'secret');
  mkdirSync(join(userData, 'models'));
  writeFileSync(join(userData, 'models', 'w.gguf'), 'weights');

  mkdirSync(join(userData, 'update', 'backup-0.2.22'), { recursive: true });
  const first = backupData(userData, '0.2.23');
  assert.equal(first, join('update', 'backup-0.2.23'));
  const copied = join(userData, first, 'data');
  assert.equal(readFileSync(join(copied, 'policies.json'), 'utf8'), '{"rules":[]}');
  assert.ok(existsSync(join(copied, 'audit.jsonl')));
  assert.ok(existsSync(join(copied, 'nested', 'x.json')));
  assert.ok(!existsSync(join(copied, 'prompts.jsonl')), 'masked prompts keep their retention promise');
  assert.ok(!existsSync(join(copied, 'prompts.jsonl.partial')));
  assert.ok(!existsSync(join(userData, first, 'credential-key.encrypted')));
  assert.ok(!existsSync(join(userData, first, 'models')));
  assert.equal(mode(join(copied, 'policies.json')), 0o600, 'a 0644 source is copied private');
  assert.equal(mode(join(copied, 'nested')), 0o700);
  assert.ok(!existsSync(join(userData, 'update', 'backup-0.2.22')), 'one backup at a time');
  backupData(userData, '0.2.24');
  assert.deepEqual(readdirSync(join(userData, 'update')).filter((f) => f.startsWith('backup-')), ['backup-0.2.24']);
  assert.throws(() => backupData(userData, '../x'));
  console.log('✓ the backup copies data/ privately, without prompts, credentials or models, and keeps only the latest');

  const models = join(userData, 'models');
  writeFileSync(join(models, 'Next.gguf'), 'n');
  writeFileSync(join(models, 'Swapped.gguf'), 's');
  appendLedger(userData, { filename: 'Next.gguf', url: NEXT_URL, forVersion: '0.2.24' });
  appendLedger(userData, { filename: 'Swapped.gguf', url: `https://huggingface.co/o/r/resolve/${REV}/Swapped.gguf`, forVersion: '0.2.24' });
  appendLedger(userData, { filename: 'Next.gguf', url: NEXT_URL, forVersion: '0.2.24' });
  assert.equal(readLedger(userData).length, 2, 'recording a file twice keeps one record');
  assert.throws(() => appendLedger(userData, { filename: '../x.gguf', url: 'u', forVersion: '0.2.24' }));
  assert.deepEqual(adoptPrefetched(userData, models, next), { keep: ['Next.gguf'], remove: ['Swapped.gguf'] });
  assert.ok(existsSync(join(models, 'Next.gguf')));
  assert.ok(!existsSync(join(models, 'Swapped.gguf')));
  assert.ok(existsSync(join(models, 'w.gguf')), 'files the updater never downloaded are never touched');
  assert.deepEqual(readLedger(userData), [], 'the ledger is consumed once');
  console.log('✓ adoption deletes only ledgered files the new catalogue does not vouch for, then forgets the ledger');
} finally {
  rmSync(userData, { recursive: true, force: true });
}
