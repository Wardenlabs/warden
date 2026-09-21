import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const folder = mkdtempSync(join(tmpdir(), 'warden-credential-test-'));
const file = join(folder, 'settings.json');
const key = join(folder, 'key');
const moduleUrl = pathToFileURL(resolve('src/security/credentials.ts')).href;
function run(code: string, keyPath = key) {
  const env: NodeJS.ProcessEnv = { ...process.env, WARDEN_CREDENTIAL_KEY_PATH: keyPath };
  delete env.WARDEN_CREDENTIAL_KEY;
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import assert from 'node:assert/strict'; import { readCredentialJSON, writeCredentialJSON, migrateCredentialJSON } from ${JSON.stringify(moduleUrl)}; const file=${JSON.stringify(file)}; ${code}`],
  { env, encoding: 'utf8' });
}
try {
  const raw = { compiler: { apiKey: 'secret-for-roundtrip-test', model: 'sample' }, untouched: [1, true] };
  writeFileSync(file, JSON.stringify(raw));
  let result = run(`const value = readCredentialJSON(file, 'settings'); migrateCredentialJSON(file, value, 'settings');`);
  assert.equal(result.status, 0, result.stderr);
  const sealed = readFileSync(file, 'utf8');
  assert(!sealed.includes(raw.compiler.apiKey));
  assert.equal(JSON.parse(sealed).compiler.model, 'sample');
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(key).mode & 0o777, 0o600);
  }
  result = run(`assert.deepEqual(readCredentialJSON(file, 'settings'), ${JSON.stringify(raw)});`);
  assert.equal(result.status, 0, result.stderr); // a fresh process can unlock it
  result = run(`assert.throws(() => readCredentialJSON(file, 'models'));`);
  assert.equal(result.status, 0, result.stderr); // bound to the intended store
  const missing = join(folder, 'missing-key');
  result = run(`assert.throws(() => readCredentialJSON(file, 'settings'));`, missing);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(file, 'utf8'), sealed); // never overwrite on lost keys
  const wrongKey = join(folder, 'wrong-key');
  writeFileSync(wrongKey, Buffer.alloc(32, 7), { mode: 0o600 });
  result = run(`assert.throws(() => readCredentialJSON(file, 'settings'));`, wrongKey);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(file, 'utf8'), sealed);
  const tampered = JSON.parse(sealed);
  const encoded = tampered.compiler.apiKey.slice('warden:v1:'.length);
  const bytes = Buffer.from(encoded, 'base64');
  bytes[28] = bytes[28]! ^ 1;
  tampered.compiler.apiKey = 'warden:v1:' + bytes.toString('base64');
  writeFileSync(file, JSON.stringify(tampered));
  result = run(`assert.throws(() => readCredentialJSON(file, 'settings'));`);
  assert.equal(result.status, 0, result.stderr);
  // Exercise the actual directory migration: a published key must no longer
  // authenticate even after the employee's name or role has changed.
  process.env['WARDEN_COMPANY_PATH'] = join(folder, 'company.json');
  process.env['WARDEN_CREDENTIAL_KEY_PATH'] = key;
  const published = 'synthetic-revoked-directory-credential';
  const { publishedCredentialHashes } = await import('../src/security/published-credentials.js');
  publishedCredentialHashes.add(createHash('sha256').update(published).digest('hex'));
  writeFileSync(process.env['WARDEN_COMPANY_PATH'], JSON.stringify({
    name: 'Changed company', roles: ['admin'], employees: [{ id: 'renamed', name: 'Changed name', role: 'admin', apiKey: published }]
  }));
  const people = await import('../src/policy/people.js');
  assert.equal(people.findByApiKey(published), null);
  const issued = people.loadDirectory().employees[0]!.apiKey;
  assert.notEqual(issued, published);
  assert(!readFileSync(process.env['WARDEN_COMPANY_PATH'], 'utf8').includes(issued));
  people.invalidate();
  assert.equal(people.findByApiKey(issued)?.id, 'renamed');
  console.log('✓ credential migration, restart, permissions, context binding, missing key and tamper rejection');
} finally { rmSync(folder, { recursive: true, force: true }); }
