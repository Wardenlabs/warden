import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { downloadModel, missingModels, type DownloadSpec } from '../src/setup/download.js';
import { artifactPaths, installedModel, sourceFingerprint } from '../src/setup/model-files.js';
import { acquireTransfer, currentTransfer } from '../src/setup/transfer-lock.js';
import { MAX_MODEL_BYTES } from '../src/setup/model-files.js';
import { publicAddress, type ModelRequest, type ModelResponse } from '../src/setup/model-http.js';

const root = mkdtempSync(join(tmpdir(), 'warden-builtin-downloads-'));
const fixture = Buffer.alloc(128, 1);
fixture.write('GGUF'); fixture.writeUInt32LE(3, 4); fixture.writeBigUInt64LE(1n, 8); fixture.writeBigUInt64LE(1n, 16);
const spec: DownloadSpec = { role: 'compiler', filename: 'fixture.gguf', url: 'https://models.example.test/fixture.gguf', approxMB: fixture.length / 1e6, required: true };
function response(body = Buffer.alloc(0), statusCode = 200, headers: Record<string, string> = {}): ModelResponse {
  return Object.assign(Readable.from([body]), { statusCode, headers: { 'content-length': String(body.length), etag: '"revision-one"', ...headers } });
}
const normal: ModelRequest = async (_url, method) => response(method === 'HEAD' ? Buffer.alloc(0) : fixture, 200, { 'content-length': String(fixture.length) });
const directory = (name: string) => join(root, name);
// AbortSignal.timeout does not hold the event loop open. A gateway's listening
// socket does; a test script waiting only on that timer would simply exit.
const alive = setInterval(() => undefined, 1000);
try {
  const dir = directory('normal');
  const phases: string[] = [];
  const progress: number[] = [];
  const result = await downloadModel(spec, dir, p => {
    assert.equal(existsSync(join(dir, spec.filename)), false);
    progress.push(p.received);
  }, 1, { request: normal, onPhase: phase => phases.push(phase) });
  assert.equal(result.ok, true);
  assert.deepEqual(readFileSync(join(dir, spec.filename)), fixture);
  assert.equal(installedModel(spec, dir).verifiedDownload, true);
  assert.deepEqual(missingModels(dir, [spec]), []);
  assert.ok(phases.includes('verifying'));
  assert.equal(progress.at(-1), fixture.length);
  assert.equal(currentTransfer(dir), null);
  const cached = await downloadModel(spec, dir, undefined, 1, { request: async () => { throw new Error('No network for installed weights'); } });
  assert.equal(cached.ok, true);

  const invalidDir = directory('invalid');
  const invalid = await downloadModel(spec, invalidDir, undefined, 1, { request: async (_url, method) => response(method === 'HEAD' ? Buffer.alloc(0) : Buffer.alloc(128), 200, { 'content-length': '128' }) });
  assert.equal(invalid.ok, false);
  assert.equal(existsSync(join(invalidDir, spec.filename)), false);
  assert.equal(currentTransfer(invalidDir), null);

  const cancelDir = directory('cancel');
  const controller = new AbortController();
  const cancelled = await downloadModel(spec, cancelDir, () => controller.abort(), 1, { request: normal, signal: controller.signal });
  assert.equal(cancelled.ok, false);
  assert.equal(existsSync(join(cancelDir, spec.filename)), false);
  assert.equal(currentTransfer(cancelDir), null);

  const resumeDir = directory('resume');
  let offset = '';
  const cut: ModelRequest = async (_url, method) => method === 'HEAD' ? response(undefined, 200, { 'content-length': '128' }) : response(fixture.subarray(0, 64), 200, { 'content-length': '128' });
  assert.equal((await downloadModel(spec, resumeDir, undefined, 1, { request: cut })).ok, false);
  assert.equal(existsSync(join(resumeDir, spec.filename)), false);
  assert.equal(readFileSync(artifactPaths(spec, resumeDir).partial).length, 64);
  const resumed = await downloadModel(spec, resumeDir, undefined, 1, { request: async (_url, method, headers) => {
    if (method === 'HEAD') return response(undefined, 200, { 'content-length': '128' });
    offset = headers.Range ?? '';
    return response(fixture.subarray(64), 206, { 'content-range': 'bytes 64-127/128' });
  } });
  assert.equal(resumed.ok, true); assert.equal(offset, 'bytes=64-');
  assert.deepEqual(readFileSync(join(resumeDir, spec.filename)), fixture);

  const leaseDir = directory('lease');
  const lease = acquireTransfer(leaseDir, { name: 'First model', source: 'builtin', jobId: 'first' });
  assert.throws(() => acquireTransfer(leaseDir, { name: 'Second model', source: 'custom', jobId: null }), /First model/);
  assert.equal(currentTransfer(leaseDir)?.jobId, 'first');
  lease.release(); assert.equal(currentTransfer(leaseDir), null);

  const paths = artifactPaths(spec, directory('legacy'), true);
  writeFileSync(paths.destination, 'test-weights');
  assert.equal(installedModel(spec, directory('legacy')).onDisk, false);
  assert.ok(installedModel(spec, directory('legacy')).downloadBlockedReason);
  assert.equal((await downloadModel(spec, directory('legacy'), undefined, 1, { request: normal })).ok, false);
  assert.equal(readFileSync(paths.destination, 'utf8'), 'test-weights');

  // Every way a continuation can go wrong ends in a whole correct file or in no
  // file. None of them may append a body to a prefix it does not belong to.
  const half = (name: string) => {
    const paths = artifactPaths(spec, directory(name), true);
    writeFileSync(paths.partial, fixture.subarray(0, 64));
    writeFileSync(paths.resume, JSON.stringify({ version: 1, fingerprint: sourceFingerprint(spec), total: 128, etag: '"revision-one"' }));
    return directory(name);
  };
  const head = (headers: Record<string, string> = {}) => response(undefined, 200, { 'content-length': '128', ...headers });
  let ranged: string | undefined;
  const ignored = await downloadModel(spec, half('ignored-range'), undefined, 1, { request: async (_url, method, headers) => {
    if (method === 'HEAD') return head();
    ranged = headers.Range;
    return response(fixture, 200, { 'content-length': '128' });
  } });
  assert.equal(ignored.ok, true); assert.equal(ranged, 'bytes=64-');
  assert.deepEqual(readFileSync(join(directory('ignored-range'), spec.filename)), fixture, 'a full body restarts the partial instead of extending it');

  ranged = 'unset';
  const changed = await downloadModel(spec, half('changed-validator'), undefined, 1, { request: async (_url, method, headers) => {
    if (method === 'HEAD') return head({ etag: '"revision-two"' });
    ranged = headers.Range;
    return response(fixture, 200, { 'content-length': '128', etag: '"revision-two"' });
  } });
  assert.equal(changed.ok, true); assert.equal(ranged, undefined, 'a different object is fetched from zero');

  const weak = await downloadModel(spec, half('weak-validator'), undefined, 1, { request: async (_url, method, headers) => {
    if (method === 'HEAD') return head({ etag: 'W/"revision-one"' });
    assert.equal(headers.Range, undefined, 'a weak validator cannot vouch for a prefix');
    return response(fixture, 200, { 'content-length': '128' });
  } });
  assert.equal(weak.ok, true);

  for (const [name, status, headers] of [
    ['wrong-offset', 206, { 'content-range': 'bytes 32-127/128' }], ['wrong-total', 206, { 'content-range': 'bytes 64-127/256' }],
    ['no-content-range', 206, {}], ['refused-range', 416, {}]
  ] as const) {
    const dir = half(name);
    const outcome = await downloadModel(spec, dir, undefined, 4, { retryDelayMs: 1, request: async (_url, method) => method === 'HEAD' ? head() : response(fixture.subarray(64), status, headers) });
    assert.equal(outcome.ok, false, name); assert.equal(outcome.code, 'range_rejected', name);
    assert.equal(existsSync(join(dir, spec.filename)), false, name);
    assert.equal(existsSync(artifactPaths(spec, dir).partial), false, `${name}: a prefix the server disowned is not kept`);
    assert.equal(currentTransfer(dir), null, name);
  }
  const compressed = await downloadModel(spec, directory('compressed'), undefined, 4, { retryDelayMs: 1, request: async (_url, method) => method === 'HEAD' ? head() : response(fixture, 200, { 'content-length': '128', 'content-encoding': 'gzip' }) });
  assert.equal(compressed.code, 'invalid_encoding');
  const oversize = await downloadModel(spec, directory('oversize'), undefined, 4, { retryDelayMs: 1, request: async () => response(undefined, 200, { 'content-length': String(MAX_MODEL_BYTES + 1) }) });
  assert.equal(oversize.code, 'model_too_large');
  const overrun = await downloadModel(spec, directory('overrun'), undefined, 4, { retryDelayMs: 1, request: async (_url, method) => method === 'HEAD' ? response(undefined, 200, { 'content-length': '64' }) : response(fixture, 200, {}) });
  assert.equal(overrun.ok, false); assert.equal(existsSync(join(directory('overrun'), spec.filename)), false);
  const lengthless = await downloadModel(spec, directory('lengthless'), undefined, 4, { retryDelayMs: 1, request: async () => response(undefined, 200, { 'content-length': '' }) });
  assert.equal(lengthless.code, 'missing_length');
  let gone = 0;
  const missing = await downloadModel(spec, directory('gone'), undefined, 4, { retryDelayMs: 1, request: async () => { gone++; return response(undefined, 404); } });
  assert.equal(missing.ok, false); assert.equal(gone, 1, 'a missing resource is not retried like a dropped socket');

  // Dropped sockets are retried, a bounded number of times, and the wait is abortable.
  let calls = 0;
  const phases2: string[] = [];
  const flaky = await downloadModel(spec, directory('flaky'), undefined, 4, { retryDelayMs: 1, onPhase: (phase, attempt) => phases2.push(`${phase}:${attempt}`), request: async (_url, method) => {
    if (method === 'HEAD') return head();
    if (++calls < 3) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    return response(fixture, 200, { 'content-length': '128' });
  } });
  assert.equal(flaky.ok, true); assert.equal(calls, 3); assert.ok(phases2.includes('retrying:2') && phases2.includes('retrying:3'));
  let exhausted = 0;
  const dead = await downloadModel(spec, directory('exhausted'), undefined, 4, { retryDelayMs: 1, request: async () => { exhausted++; throw new Error('socket hang up'); } });
  assert.equal(dead.ok, false); assert.equal(exhausted, 4); assert.equal(dead.retryable, true);
  const waiting = new AbortController();
  const started = Date.now();
  const stopped = await downloadModel(spec, directory('abort-backoff'), undefined, 4, { retryDelayMs: 60_000, signal: waiting.signal, onPhase: (phase) => { if (phase === 'retrying') waiting.abort(); }, request: async () => { throw new Error('socket hang up'); } });
  assert.equal(stopped.code, 'cancelled'); assert.ok(Date.now() - started < 5_000, 'a cancel does not wait out the backoff');
  const duringHead = new AbortController();
  const headCancelled = await downloadModel(spec, directory('abort-head'), undefined, 4, { signal: duringHead.signal, request: (_url, _method, _headers, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason)); duringHead.abort(); }) });
  assert.equal(headCancelled.code, 'cancelled'); assert.equal(currentTransfer(directory('abort-head')), null);
  const late = await downloadModel(spec, directory('timeout'), undefined, 4, { timeoutMs: 20, request: (_url, _method, _headers, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))) });
  assert.equal(late.code, 'transfer_timeout');

  // Somebody else's file at the destination survives, whatever it is.
  const raceDir = directory('race');
  const raced = await downloadModel(spec, raceDir, () => { if (!existsSync(join(raceDir, spec.filename))) writeFileSync(join(raceDir, spec.filename), 'placed by another writer'); }, 1, { request: normal });
  assert.equal(raced.ok, false); assert.equal(raced.code, 'existing_file_invalid');
  assert.equal(readFileSync(join(raceDir, spec.filename), 'utf8'), 'placed by another writer');
  // A cancel that arrives once publication has begun cannot take the file back.
  const lateCancel = new AbortController();
  const published = await downloadModel(spec, directory('late-cancel'), undefined, 1, { request: normal, signal: lateCancel.signal, onPublish: () => queueMicrotask(() => lateCancel.abort()) });
  assert.equal(published.ok, true); assert.equal(installedModel(spec, directory('late-cancel')).verifiedDownload, true);

  // The process died after the final name appeared and before its receipt did.
  const crashDir = directory('crash');
  assert.equal((await downloadModel(spec, crashDir, undefined, 1, { request: normal })).ok, true);
  const crashed = artifactPaths(spec, crashDir);
  const receipt = JSON.parse(readFileSync(crashed.receipt, 'utf8'));
  unlinkSync(crashed.receipt);
  writeFileSync(crashed.resume, JSON.stringify({ version: 1, fingerprint: receipt.fingerprint, total: 128, etag: null, verified: receipt }));
  assert.equal(installedModel(spec, crashDir).onDisk, false, 'not reported complete until the record is');
  const offline: ModelRequest = async () => { throw new Error('reconciliation needs no network'); };
  assert.equal((await downloadModel(spec, crashDir, undefined, 1, { request: offline })).note, 'cached');
  assert.equal(installedModel(spec, crashDir).verifiedDownload, true);
  assert.deepEqual(readFileSync(join(crashDir, spec.filename)), fixture);
  // A receipt that no longer describes the file is not proof of anything.
  writeFileSync(join(crashDir, spec.filename), Buffer.concat([fixture, fixture]));
  assert.equal(installedModel(spec, crashDir).onDisk, false);
  assert.deepEqual(missingModels(crashDir, [spec]), [spec]);

  // A lock whose owner is gone is reclaimed; one that cannot be read is not.
  const staleDir = directory('stale-lock');
  mkdirSync(join(staleDir, '.downloads'), { recursive: true });
  writeFileSync(join(staleDir, '.downloads', 'transfer.lock'), JSON.stringify({ name: 'Old gateway', source: 'builtin', jobId: null, pid: 2 ** 22 - 3, token: '00000000-0000-4000-8000-000000000000' }));
  assert.equal(currentTransfer(staleDir), null);
  acquireTransfer(staleDir, { name: 'New gateway', source: 'builtin', jobId: null }).release();
  writeFileSync(join(staleDir, '.downloads', 'transfer.lock'), JSON.stringify({ name: 'This PID, another life', source: 'builtin', jobId: null, pid: process.pid, token: '00000000-0000-4000-8000-000000000001' }));
  acquireTransfer(staleDir, { name: 'Restarted container', source: 'builtin', jobId: null }).release();
  writeFileSync(join(staleDir, '.downloads', 'transfer.lock'), '{broken');
  assert.throws(() => acquireTransfer(staleDir, { name: 'Ambiguous', source: 'builtin', jobId: null }), /unreadable ownership/);
  assert.equal((await downloadModel(spec, staleDir, undefined, 1, { request: normal })).code, 'transfer_busy');
  assert.throws(() => artifactPaths({ filename: '../escape.gguf' }, staleDir), /Invalid catalogue model filename/);

  for (const address of ['127.0.0.1', '10.0.0.1', '::1', '::ffff:127.0.0.1', '2002:7f00:1::']) assert.equal(publicAddress(address), false);
  assert.equal(publicAddress('1.1.1.1'), true);

  // The job service, over the real downloader and filesystem; only the network
  // is a fixture. Settings and the working directory are pointed at the
  // temporary root first, because both are read when these modules load.
  const home = directory('gateway');
  mkdirSync(home, { recursive: true });
  process.env['WARDEN_SETTINGS_PATH'] = join(home, 'settings.json');
  process.env['WARDEN_MODELS_DIR'] = join(home, 'models');
  delete process.env['WARDEN_MODEL_ADJUDICATOR'];
  process.chdir(home);
  const { BuiltinDownloads } = await import('../src/models/builtin-downloads.js');
  const { LIBRARY_BUILTINS, libraryBuiltin, MODEL_CATALOG } = await import('../src/setup/catalog.js');
  const models = process.env['WARDEN_MODELS_DIR'];
  assert.equal(LIBRARY_BUILTINS.length, 7);
  assert.equal(new Set(LIBRARY_BUILTINS.map((b) => libraryBuiltin(b.id)!.spec.filename)).size, 7, 'one row per physical file');
  assert.deepEqual(libraryBuiltin('compiler')!.builtin.roles, ['compiler', 'adjudicator'], 'Qwen3 1.7B is one artifact doing two jobs');
  for (const outside of ['detector', 'embedder', 'assistant', 'ocr', 'adjudicator-qwen3-4b', '../adjudicator', '']) assert.equal(libraryBuiltin(outside), null);
  assert.ok(MODEL_CATALOG.some((m) => m.role === 'detector'), 'setup keeps the broader catalogue');

  let open = false;
  let release = (): void => undefined;
  const gated: ModelRequest = async (_url, method, _headers, signal) => {
    if (method === 'HEAD') return response(undefined, 200, { 'content-length': '128' });
    if (!open) await new Promise<void>((resolve, reject) => { release = resolve; if (signal.aborted) reject(signal.reason); signal.addEventListener('abort', () => reject(signal.reason)); });
    return response(fixture, 200, { 'content-length': '128' });
  };
  const service = () => new BuiltinDownloads(() => models, (s, dir, progress, attempts, options) => downloadModel(s, dir, progress, attempts, { ...options, request: gated, retryDelayMs: 1 }));
  const settle = async (svc: InstanceType<typeof BuiltinDownloads>, id: string, state: string) => {
    for (let i = 0; i < 400 && svc.list().find((j) => j.builtinId === id)?.state !== state; i++) await new Promise((r) => setTimeout(r, 5));
    const job = svc.list().find((j) => j.builtinId === id)!;
    assert.equal(job.state, state, `${id} settled as ${job.state}: ${job.error}`);
    return job;
  };

  const first = service();
  assert.throws(() => first.start('embedder'), (e: { code?: string; status?: number }) => e.code === 'unknown_builtin' && e.status === 404);
  const accepted = first.start('adjudicator-dynaguard');
  assert.equal(accepted.status, 202);
  assert.ok(accepted.status === 202 && !accepted.body.reused);
  const again = first.start('adjudicator-dynaguard');
  assert.ok(again.status === 202 && again.body.reused && accepted.status === 202 && again.body.job.id === accepted.body.job.id, 'a double click is one job');
  assert.throws(() => first.start('adjudicator-large'), (e: { code?: string; status?: number; active?: { name: string } }) => e.code === 'transfer_busy' && e.status === 409 && e.active?.name === 'DynaGuard 1.7B');
  assert.equal(first.transfer().active?.jobId, accepted.body.job.id);
  assert.throws(() => acquireTransfer(models, { name: 'pnpm run setup', source: 'setup', jobId: null }), /DynaGuard 1.7B/, 'terminal setup cannot take a second lease');
  assert.equal(first.builtins().find((b) => b.id === 'adjudicator-dynaguard')!.onDisk, false);

  // The gateway stops mid-transfer. The next one reports it and starts nothing.
  await first.shutdown();
  assert.equal(first.list()[0]!.state, 'interrupted');
  assert.throws(() => first.start('adjudicator-large'), (e: { code?: string }) => e.code === 'model_management_unavailable');
  const second = service();
  const recovered = second.list().find((j) => j.builtinId === 'adjudicator-dynaguard')!;
  assert.equal(recovered.state, 'interrupted'); assert.equal(recovered.canRetry, true); assert.equal(recovered.canCancel, false);
  assert.equal(second.transfer().active, null, 'a dead job holds no lease');
  assert.equal(JSON.stringify(second.list()).includes(home), false, 'jobs carry no filesystem paths');
  assert.equal(JSON.stringify(second.list()).includes('huggingface'), false, 'jobs carry no source addresses');

  // Retry is the same call and a new job. Cancel gives the bytes up; it is
  // acknowledged at once and finished only after the cleanup.
  const retried = second.start('adjudicator-dynaguard');
  assert.ok(retried.status === 202 && !retried.body.reused && retried.body.job.id !== recovered.id);
  assert.equal(second.list().length, 1, 'the latest attempt replaces the row');
  const jobId = retried.status === 202 ? retried.body.job.id : '';
  for (let i = 0; i < 400 && second.list()[0]!.state !== 'downloading' && second.list()[0]!.state !== 'connecting'; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(second.cancel(jobId).state, 'cancelling');
  assert.equal(second.cancel(jobId).state, 'cancelling', 'a second cancel is not an error');
  await settle(second, 'adjudicator-dynaguard', 'cancelled');
  assert.equal(second.cancel(jobId).state, 'cancelled');
  const cancelledPaths = artifactPaths(libraryBuiltin('adjudicator-dynaguard')!.spec, models);
  assert.equal(existsSync(cancelledPaths.partial), false); assert.equal(existsSync(cancelledPaths.resume), false); assert.equal(existsSync(cancelledPaths.destination), false);
  assert.equal(second.transfer().active, null);
  assert.throws(() => second.cancel('00000000-0000-4000-8000-000000000000'), (e: { status?: number }) => e.status === 404);

  // Completion: installed, recorded, idempotent, and not something a cancel can undo.
  open = true;
  const done = second.start('adjudicator');
  assert.equal(done.status, 202);
  const finished = await settle(second, 'adjudicator', 'complete');
  assert.equal(finished.received, 128); assert.equal(finished.total, 128); assert.equal(finished.canCancel, false);
  const row = second.builtins().find((b) => b.id === 'adjudicator')!;
  assert.equal(row.onDisk, true); assert.equal(row.verifiedDownload, true); assert.equal(row.bytes, 128); assert.equal(row.latestJobId, finished.id);
  assert.equal(second.start('adjudicator').status, 200, 'an installed file starts nothing');
  assert.throws(() => second.cancel(finished.id), (e: { code?: string }) => e.code === 'transfer_finished');
  assert.deepEqual(readFileSync(join(models, 'DynaGuard-4B.Q6_K.gguf')), fixture);
  assert.equal(existsSync(process.env['WARDEN_SETTINGS_PATH']), false, 'a download saves no selection');
  assert.equal(new BuiltinDownloads(() => models).list().find((j) => j.builtinId === 'adjudicator')?.state, 'complete', 'terminal states survive a restart');

  // A file that is there and is not a model blocks its row; nothing overwrites it.
  writeFileSync(join(models, 'Qwen3-8B-Q4_K_M.gguf'), 'an old partial at the final name');
  assert.throws(() => second.start('adjudicator-large'), (e: { code?: string; status?: number }) => e.code === 'existing_file_invalid' && e.status === 409);
  assert.ok(second.builtins().find((b) => b.id === 'adjudicator-large')!.downloadBlockedReason);
  assert.equal(readFileSync(join(models, 'Qwen3-8B-Q4_K_M.gguf'), 'utf8'), 'an old partial at the final name');

  // A journal nobody can read disables management; it deletes nothing.
  writeFileSync(join(models, '.downloads', 'jobs.json'), '{broken');
  const unreadable = service();
  assert.equal(unreadable.transfer().available, false); assert.match(unreadable.transfer().reason ?? '', /unreadable/);
  assert.throws(() => unreadable.start('compiler'), (e: { code?: string }) => e.code === 'model_management_unavailable');
  assert.equal(readFileSync(join(models, '.downloads', 'jobs.json'), 'utf8'), '{broken');
  assert.equal(unreadable.builtins().find((b) => b.id === 'adjudicator')!.onDisk, true, 'installed weights stay installed');
  process.env['WARDEN_ADAPTER'] = 'llamacpp';
  assert.match(second.transfer().reason ?? '', /llamacpp/);
  assert.throws(() => second.start('compiler'), (e: { code?: string }) => e.code === 'model_management_unavailable');
  process.env['WARDEN_ADAPTER'] = 'mock';

  // The resolver. An installation that never chose keeps the path setup
  // recorded; one that pressed Use on the default gets the file that was tested.
  const stale = join(home, 'stale-analyzer.gguf');
  writeFileSync(stale, fixture);
  writeFileSync(join(home, 'warden.local.json'), JSON.stringify({ modelsDir: models, adapter: 'real', models: { adjudicator: stale } }));
  const { sourceFor } = await import('../src/qvac/client.js');
  const { saveAdjudicatorSettings, savedAdjudicatorChoice } = await import('../src/settings.js');
  assert.equal(savedAdjudicatorChoice(), null);
  assert.equal(sourceFor('adjudicator'), stale, 'no explicit choice: the setup path is preserved');
  saveAdjudicatorSettings({ model: 'default' });
  assert.equal(savedAdjudicatorChoice(), 'default');
  assert.equal(sourceFor('adjudicator'), join(models, 'DynaGuard-4B.Q6_K.gguf'), 'an explicit default outranks a stale setup path');
  saveAdjudicatorSettings({ model: 'dynaguard' });
  assert.equal(sourceFor('adjudicator'), stale, 'a chosen seat with no file keeps judging with what is there');
  saveAdjudicatorSettings({ model: 'large' });
  assert.throws(() => sourceFor('adjudicator'), /incomplete or damaged/, 'a damaged managed file is an error, not a reason to load something else');
  process.env['WARDEN_MODEL_ADJUDICATOR'] = stale;
  assert.equal(sourceFor('adjudicator'), stale, 'the environment still outranks the console');
  delete process.env['WARDEN_MODEL_ADJUDICATOR'];
  writeFileSync(process.env['WARDEN_SETTINGS_PATH'], '{broken');
  assert.equal(savedAdjudicatorChoice(), null, 'unreadable settings are not an explicit selection');

  console.log('Built-in downloads: publication, continuation safety, retry, cancellation, recovery, leases, jobs, legacy files and resolver precedence passed.');
} finally { clearInterval(alive); rmSync(root, { recursive: true, force: true }); }
