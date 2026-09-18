/** Fresh-install compiler onboarding with real HTTP and bounded subprocess
 * fixtures. No real account, login, policy content or model service is used. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';

const temporary = mkdtempSync(join(tmpdir(), 'warden-claude-setup-'));
const bin = join(temporary, 'bin'); mkdirSync(bin);
const fixtureState = join(temporary, 'state.json');
const fixtureLog = join(temporary, 'calls.jsonl');
const settingsPath = join(temporary, 'settings.json');
for (const field of ['SETTINGS', 'COMPANY', 'POLICY', 'AUDIT', 'PROMPT', 'PROMPT_TEMPLATES', 'MODEL_CATALOG', 'RATE_STATE']) process.env[`WARDEN_${field}_PATH`] = join(temporary, `${field.toLowerCase()}.json`);
for (const key of ['WARDEN_ADAPTER', 'WARDEN_COMPILER_CLI', 'WARDEN_COMPILER_API', 'WARDEN_COMPILER_API_KEY', 'WARDEN_COMPILER_MODEL', 'WARDEN_MODEL_COMPILER', 'WARDEN_MODEL_ADJUDICATOR']) delete process.env[key];
process.env.WARDEN_ADMIN_REQUIRE_KEY = '1';
process.env.WARDEN_RATE_REQUESTS = '10000';
process.env.WARDEN_CLAUDE_FIXTURE_STATE = fixtureState;
process.env.WARDEN_CLAUDE_FIXTURE_LOG = fixtureLog;
process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
writeFileSync(process.env.WARDEN_COMPANY_PATH!, JSON.stringify({ name: 'Synthetic setup company', roles: ['admin', 'employee'], employees: [
  { id: 'admin', name: 'Administrator', role: 'admin', apiKey: 'setup-admin' }, { id: 'employee', name: 'Employee', role: 'employee', apiKey: 'setup-employee' }
] }));
const fixture = join(bin, 'fixture.mjs');
writeFileSync(fixture, `import {readFileSync,appendFileSync} from 'node:fs';
const state=JSON.parse(readFileSync(process.env.WARDEN_CLAUDE_FIXTURE_STATE,'utf8'));const args=process.argv.slice(2);
const log=(data)=>appendFileSync(process.env.WARDEN_CLAUDE_FIXTURE_LOG,JSON.stringify(data)+'\\n');
if(args[0]==='auth'){log({kind:'auth',args});if(state.auth==='unknown'){console.log('private-email@example.test private-credential');process.exit(1);}console.log(JSON.stringify({loggedIn:state.auth==='signed-in',email:'private-email@example.test',apiKey:'private-credential'}));process.exit(state.auth==='signed-in'?0:1);}
log({kind:'generation',args,cwd:process.cwd(),internal:process.env.WARDEN_INTERNAL});
if(state.generation==='old'&&args.includes('--safe-mode')){console.error("unknown option '--safe-mode'");process.exit(1);}
if(state.generation==='timeout'){setTimeout(()=>{},60000);}
else {let input='';process.stdin.setEncoding('utf8').on('data',chunk=>input+=chunk).on('end',()=>{log({kind:'input',input});if(state.generation==='error'){console.error('Authentication failed for private-email@example.test private-credential');process.exit(1);}if(state.generation==='bad'){console.log('private-email@example.test private-credential');}else console.log('{"status":"ready"}');});}
`);
writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`); chmodSync(join(bin, 'claude'), 0o755);
function mode(auth = 'signed-in', generation = 'good') { writeFileSync(fixtureState, JSON.stringify({ auth, generation })); }
function calls(): any[] { return existsSync(fixtureLog) ? readFileSync(fixtureLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []; }
mode('signed-out');
const { loadCompilerSettings, compilerSettingsConfigured, compilerSetupRequired, saveCompilerSettings } = await import('../src/settings.js');
const { cliCompilerConfig, CliCompilerAdapter } = await import('../src/qvac/cli-compiler.js');
const { probeClaudeStatus } = await import('../src/qvac/cli-setup.js');
const { adapter, remoteCompiler } = await import('../src/qvac/index.js');
const { CompilerSetupRequiredError } = await import('../src/qvac/types.js');
const { MockQvacAdapter } = await import('../src/qvac/mock.js');
const { createApp } = await import('../src/server/app.js');
const app = createApp(); const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); assert(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}`;
async function request(path = '/api/settings/compiler?refresh=1', method = 'GET', body?: unknown, key = 'setup-admin') {
  const response = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
}
const local = { provider: 'local', baseUrl: '', apiKey: '', model: '', redactNames: false };
const claude = { ...local, provider: 'claude-cli' };
const schema = z.object({ status: z.literal('ready') });
const json = { type: 'object', properties: { status: { type: 'string', enum: ['ready'] } }, required: ['status'], additionalProperties: false };
try {
  assert.equal(loadCompilerSettings().provider, 'claude-cli'); assert.equal(loadCompilerSettings().model, '');
  assert.equal(compilerSettingsConfigured(), false); assert.equal(compilerSetupRequired(), true);
  assert.equal(cliCompilerConfig()?.tool, 'claude'); assert.equal(cliCompilerConfig()?.model, '');
  assert(remoteCompiler()?.includes('Claude')); // Readiness reporting never throws.
  await assert.rejects(adapter().completeJSON({ role: 'compiler', system: 'Do not send.', user: 'Do not send.' }, schema, json), CompilerSetupRequiredError);
  assert.equal(calls().filter((call) => call.kind === 'generation').length, 0);
  const draft = await request('/api/policy/draft', 'POST', { text: 'Do not publish private payroll.' });
  assert.equal(draft.status, 409); assert.equal(draft.body.kind, 'compiler-setup-required');
  const fresh = await request(); assert.equal(fresh.status, 200); assert.equal(fresh.body.setupRequired, true); assert.equal(fresh.body.inForce, null);
  assert.equal(fresh.body.claude.auth, 'signed-out'); assert.equal(fresh.body.claude.status, 'sign-in-required');
  assert(!JSON.stringify(fresh.body).includes('private-email')); assert(!JSON.stringify(fresh.body).includes('private-credential'));
  const freshInventory = await request('/api/models'); const compilerInventory = freshInventory.body.models.find((entry: any) => entry.role === 'compiler');
  assert.equal(compilerInventory.optional, true); assert.equal(compilerInventory.fetchable, false);
  for (const path of ['/api/settings/compiler?refresh=1', '/api/settings/compiler/test']) assert.equal((await request(path, path.includes('/test') ? 'POST' : 'GET', path.includes('/test') ? { provider: 'claude-cli' } : undefined, 'setup-employee')).status, 403);
  console.log('✓ Fresh installations propose Claude with its own model default; real compilation waits for setup; status and employee boundaries remain safe');

  const signedOut = await request('/api/settings/compiler/test', 'POST', { provider: 'claude-cli', model: '' });
  assert.equal(signedOut.status, 400); assert.equal(signedOut.body.code, 'cli_sign_in_required'); assert.equal(existsSync(settingsPath), false);
  mode(); const ready = await request(); assert.equal(ready.body.claude.auth, 'signed-in');
  const tested = await request('/api/settings/compiler/test', 'POST', { provider: 'claude-cli', model: '' });
  assert.equal(tested.status, 200); assert.equal(tested.body.reply, 'ready'); assert.equal(tested.body.model, '');
  assert.equal(existsSync(settingsPath), false); assert.equal(compilerSetupRequired(), true);
  const beforeApply = calls().filter((call) => call.kind === 'generation').length;
  const applied = await request('/api/settings/compiler', 'PUT', claude); assert.equal(applied.status, 200); assert.equal(applied.body.setupRequired, false);
  assert.equal(loadCompilerSettings().provider, 'claude-cli'); assert.equal(loadCompilerSettings().model, '');
  assert(calls().filter((call) => call.kind === 'generation').length > beforeApply, 'Apply must repeat actual connection validation');
  const result = await adapter().completeJSON({ role: 'compiler', system: 'Connection check.', user: 'Return ready.' }, schema, json); assert.equal(result.value.status, 'ready');
  for (const call of calls().filter((call) => call.kind === 'generation')) {
    assert(call.args.includes('--safe-mode')); assert(call.args.includes('--disallowed-tools')); assert(!call.args.includes('--bare')); assert(!call.args.includes('--model')); assert.equal(call.internal, '1'); assert.equal(realpathSync(call.cwd), realpathSync(tmpdir()));
  }
  for (const input of calls().filter((call) => call.kind === 'input')) assert(!input.input.includes('Do not publish private payroll.'));
  console.log('✓ Test sends only a fixed structured completion and never saves; Apply retests before saving; no forced model or bare mode');

  await request('/api/settings/compiler', 'PUT', local); const previous = readFileSync(settingsPath, 'utf8');
  mode('signed-in', 'bad'); const failed = await request('/api/settings/compiler', 'PUT', claude); assert.equal(failed.status, 400); assert.equal(failed.body.code, 'cli_test_failed'); assert.equal(readFileSync(settingsPath, 'utf8'), previous);
  assert(!JSON.stringify(failed.body).includes('private-email')); assert(!JSON.stringify(failed.body).includes('private-credential'));
  mode('signed-in', 'error'); const authError = await request('/api/settings/compiler/test', 'POST', { provider: 'claude-cli' }); assert.equal(authError.status, 400); assert.equal(authError.body.code, 'cli_sign_in_required'); assert(!JSON.stringify(authError.body).includes('private-credential'));
  mode('unknown'); const unknown = await request(); assert.equal(unknown.body.claude.auth, 'unknown'); assert(!JSON.stringify(unknown.body).includes('private-email'));
  const absent = await probeClaudeStatus({ PATH: join(temporary, 'not-installed') }); assert.equal(absent.installed, false); assert.equal(absent.status, 'install-required');
  const localInventory = await request('/api/models'); const localRow = localInventory.body.models.find((entry: any) => entry.role === 'compiler'); assert.equal(localRow.optional, false); assert.equal(localRow.fetchable, true);
  console.log('✓ Signed-out, absent, unknown and failed connections are actionable and redacted; failed Apply preserves the previous compiler');

  mode('signed-in', 'old'); const legacy = await request('/api/settings/compiler/test', 'POST', { provider: 'claude-cli', model: 'sonnet' }); assert.equal(legacy.status, 200);
  const lastGenerations = calls().filter((call) => call.kind === 'generation').slice(-2); assert(lastGenerations[0].args.includes('--safe-mode')); assert(!lastGenerations[1].args.includes('--safe-mode')); assert(lastGenerations[1].args.includes('sonnet')); assert(!lastGenerations[1].args.includes('--bare'));
  mode('signed-in', 'timeout'); const started = Date.now(); await assert.rejects(new CliCompilerAdapter(new MockQvacAdapter(), { tool: 'claude', model: '', timeoutMs: 100 }).complete({ role: 'compiler', system: 'probe', user: 'probe', timeoutMs: 50 }), /timed out|deadline/i); assert(Date.now() - started < 2000);
  const generations = calls().filter((call) => call.kind === 'generation').length;
  await new CliCompilerAdapter(new MockQvacAdapter(), { tool: 'claude', model: '', timeoutMs: 100 }).completeJSON({ role: 'adjudicator', system: 'schema probe', user: 'schema probe' }, schema, json);
  assert.equal(calls().filter((call) => call.kind === 'generation').length, generations);
  console.log('✓ Older safe-mode handling and deadlines remain bounded; analysis never reaches the compiler subprocess');

  mode(); saveCompilerSettings(claude);
  process.env.WARDEN_COMPILER_API = 'http://127.0.0.1:34567'; process.env.WARDEN_COMPILER_MODEL = 'synthetic-endpoint-model';
  assert.equal(cliCompilerConfig(), null); assert(remoteCompiler()?.includes('synthetic-endpoint-model')); assert.equal(compilerSetupRequired(), false);
  delete process.env.WARDEN_COMPILER_API; delete process.env.WARDEN_COMPILER_MODEL; process.env.WARDEN_MODEL_COMPILER = resolve('models/Qwen3-0.6B-Q4_0.gguf');
  assert.equal(cliCompilerConfig(), null); assert.equal(remoteCompiler(), null); assert.equal(compilerSetupRequired(), false);
  process.env.WARDEN_COMPILER_CLI = 'codex'; assert.equal(cliCompilerConfig()?.tool, 'codex'); delete process.env.WARDEN_COMPILER_CLI; delete process.env.WARDEN_MODEL_COMPILER;
  for (const provider of ['local', 'custom', 'claude-cli', 'codex-cli', 'catalog']) { saveCompilerSettings({ ...local, provider }); assert.equal(loadCompilerSettings().provider, provider); assert.equal(compilerSetupRequired(), false); }
  writeFileSync(settingsPath, '{invalid private settings'); assert.equal(loadCompilerSettings().provider, 'local'); assert.equal(compilerSetupRequired(), false); assert.throws(() => saveCompilerSettings(claude)); assert.equal(readFileSync(settingsPath, 'utf8'), '{invalid private settings');
  writeFileSync(settingsPath, JSON.stringify({ adjudicator: { model: 'default' } })); assert.equal(loadCompilerSettings().provider, 'claude-cli'); assert.equal(compilerSetupRequired(), true);
  console.log('✓ Saved providers and explicit compiler environment choices are preserved; corrupt state never starts a new external provider');
  const beforeInvalid = calls().filter((call) => call.kind === 'generation').length;
  for (const invalid of ['cluade', '__proto__', 'constructor']) {
    process.env.WARDEN_COMPILER_CLI = invalid;
    assert.equal(cliCompilerConfig(), null); assert.equal(remoteCompiler(), null);
    await assert.rejects(adapter().completeJSON({ role: 'compiler', system: 'not sent', user: 'not sent' }, schema, json), /supported CLI/);
    const status = await request(); assert.equal(status.status, 200); assert.match(status.body.configurationError, /supported CLI/); assert.equal(status.body.inForce, null);
  }
  delete process.env.WARDEN_COMPILER_CLI;
  process.env.WARDEN_COMPILER_API = 'https://example.test/v1';
  await assert.rejects(adapter().completeJSON({ role: 'compiler', system: 'not sent', user: 'not sent' }, schema, json), /incomplete or invalid/);
  const invalidEndpoint = await request(); assert.equal(invalidEndpoint.status, 200); assert.match(invalidEndpoint.body.configurationError, /incomplete or invalid/);
  delete process.env.WARDEN_COMPILER_API;
  assert.equal(calls().filter((call) => call.kind === 'generation').length, beforeInvalid);
  console.log('✓ Invalid explicit CLI/endpoint overrides fail clearly without silently switching providers');

  rmSync(settingsPath); const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `const {adapter}=await import('./src/qvac/index.ts'); const {z}=await import('zod'); await adapter().completeJSON({role:'compiler',system:'mock',user:'mock'},z.object({status:z.literal('ready')}),${JSON.stringify(json)});`], { cwd: process.cwd(), env: { ...process.env, WARDEN_ADAPTER: 'mock' }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr); assert.equal(calls().filter((call) => call.kind === 'generation').length, generations);
  console.log('✓ A fresh mock demo never executes the implicit Claude compiler');
} finally { server.close(); await adapter().dispose(); rmSync(temporary, { recursive: true, force: true }); }
