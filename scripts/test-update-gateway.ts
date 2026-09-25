/**
 * What the gateway promises the desktop updater: to say when it is busy, to
 * finish what it started before a restart, and to put the gap on the record
 * afterwards.
 *
 * The drain is tested on real sockets, because what it has to get right is what
 * a hook sees. A request it refuses must fail at the transport, which the hook
 * reads as "Warden unreachable", and never come back as a JSON error, which
 * the hook would read as an answer. That includes a request arriving on a
 * keep-alive socket opened before the drain began, the way the tunnel's
 * `cloudflared` holds one.
 *
 *   pnpm run test:update-gateway
 *
 * See docs/specs/desktop-auto-update.md §5.2, §5.3, §6.4, §6.7.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { Agent, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

const scratch = mkdtempSync(join(tmpdir(), 'warden-update-gateway-'));
process.env['WARDEN_ADAPTER'] = 'mock';
for (const field of ['AUDIT', 'POLICY', 'COMPANY', 'SETTINGS', 'PROMPT', 'PROMPT_TEMPLATES', 'APPEALS', 'ESCALATIONS', 'RATE_STATE', 'MODEL_CATALOG', 'DEVICES', 'VERIFIED']) {
  process.env[`WARDEN_${field}_PATH`] = join(scratch, `${field.toLowerCase()}.json`);
}
process.env['WARDEN_MODELS_DIR'] = join(scratch, 'models');

const listen = async (server: Server): Promise<number> => {
  if (!server.listening) await new Promise((done) => server.once('listening', done));
  return (server.address() as AddressInfo).port;
};

type Outcome = { status: number; body: string } | { error: string };
function get(port: number, path: string, agent?: Agent): Promise<Outcome> {
  return new Promise((resolveGet) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, agent: agent ?? false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolveGet({ status: res.statusCode ?? 0, body }));
      res.on('error', (err) => resolveGet({ error: err.message }));
    });
    req.on('error', (err: NodeJS.ErrnoException) => resolveGet({ error: err.code ?? err.message }));
    req.end();
  });
}
const failedAtTransport = (outcome: Outcome): boolean => 'error' in outcome;

async function main(): Promise<void> {
  const drainModule = await import('../src/server/drain.js');
  const { drain, drainGate, inFlightRequests, isDraining, resetDrainForTests } = drainModule;

  // ── the drain, on a small app that holds one request open ──────────────────
  {
    let release: () => void = () => undefined;
    const held = new Promise<void>((done) => { release = done; });
    const app = express();
    app.use(drainGate);
    app.get('/slow', async (_req, res) => { await held; res.send('finished'); });
    app.get('/fast', (_req, res) => { res.send('ok'); });
    app.get('/api/events', (_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(':\n\n'); });
    const server = app.listen(0, '127.0.0.1');
    const port = await listen(server);

    assert.deepEqual(await get(port, '/fast'), { status: 200, body: 'ok' });
    assert.equal(inFlightRequests(), 0, 'a finished request is uncounted');

    // An open live stream is not work in flight.
    const stream = httpRequest({ host: '127.0.0.1', port, path: '/api/events', agent: false });
    stream.on('error', () => undefined);
    stream.end();
    await new Promise((done) => stream.once('response', done));
    assert.equal(inFlightRequests(), 0, 'the live-decision stream is never waited for');

    // One socket, kept alive: the second request queues behind the first and
    // is written on the same socket after the drain has begun.
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const first = get(port, '/slow', agent);
    await new Promise((done) => setTimeout(done, 50));
    assert.equal(inFlightRequests(), 1);
    const second = get(port, '/fast', agent);

    const drained = drain(server, 5_000);
    assert.ok(isDraining());
    const fresh = await get(port, '/fast');
    assert.ok(failedAtTransport(fresh), `a new connection during a drain fails at the transport, got ${JSON.stringify(fresh)}`);

    release();
    assert.deepEqual(await first, { status: 200, body: 'finished' }, 'work in flight finishes');
    const late = await second;
    assert.ok(failedAtTransport(late), `a request on an already-open socket is cut, not answered: ${JSON.stringify(late)}`);
    const result = await drained;
    assert.equal(result.cutOff, 0);
    agent.destroy();
    stream.destroy();
    server.closeAllConnections();
    console.log('✓ a drain refuses new work at the transport, including on a kept-alive socket, and lets work in flight finish');
    resetDrainForTests();
  }

  // ── a bound that runs out is counted, not hidden ───────────────────────────
  {
    const app = express();
    app.use(drainGate);
    app.get('/stuck', () => undefined);
    const server = app.listen(0, '127.0.0.1');
    const port = await listen(server);
    const stuck = get(port, '/stuck');
    await new Promise((done) => setTimeout(done, 50));
    const started = Date.now();
    const result = await drain(server, 200);
    assert.equal(result.cutOff, 1, 'the request still running at the bound is reported');
    assert.ok(Date.now() - started < 1_000, 'the bound is honoured');
    server.closeAllConnections();
    await stuck;
    console.log('✓ a drain that reaches its bound reports how many requests it cut off');
    resetDrainForTests();
  }

  // ── the real app mounts the gate before anything else ──────────────────────
  {
    const { createApp } = await import('../src/server/app.js');
    const server = createApp().listen(0, '127.0.0.1');
    const port = await listen(server);
    const health = await get(port, '/health');
    assert.ok('status' in health && health.status === 200);
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    assert.ok('status' in (await get(port, '/health', agent)));
    await drain(server, 1_000);
    for (const path of ['/health', '/api/guard/check', '/v1/chat/completions', '/api/policy']) {
      const outcome = await get(port, path, agent);
      assert.ok(failedAtTransport(outcome), `${path} while draining must not answer: ${JSON.stringify(outcome)}`);
    }
    agent.destroy();
    server.closeAllConnections();
    console.log('✓ the gateway app answers nothing while draining, whichever route is asked');
    resetDrainForTests();
  }

  // ── readiness ──────────────────────────────────────────────────────────────
  {
    const { busyReasons } = await import('../src/server/update-readiness.js');
    const { acquireTransfer } = await import('../src/setup/transfer-lock.js');
    const { withRoleChange } = await import('../src/qvac/coordination.js');
    const { withModelManagement } = await import('../src/models/manager.js');
    const { modelsRoot } = await import('../src/models/store.js');

    assert.deepEqual(busyReasons(), []);
    const lease = acquireTransfer(modelsRoot(), { name: 'Next.gguf', source: 'setup', jobId: null });
    assert.deepEqual(busyReasons(), ['model-download'], 'any writer of the models directory makes the gateway busy');
    lease.release();
    assert.deepEqual(busyReasons(), []);

    await withRoleChange('adjudicator', async () => {
      assert.deepEqual(busyReasons(), ['model-change'], 'a role swap makes the gateway busy');
    });
    await withModelManagement(async () => {
      assert.deepEqual(busyReasons(), ['model-change'], 'a model test or activation makes the gateway busy');
    });
    assert.deepEqual(busyReasons(), [], 'and it is free again once they finish');
    console.log('✓ readiness reports model transfers and model changes, and nothing else');
  }

  // ── shell requests are validated before they are acted on ──────────────────
  {
    const { isShellRequest, MAX_DRAIN_MS } = await import('../src/server/desktop-bridge.js');
    assert.ok(isShellRequest({ type: 'readiness?', id: 'a' }));
    assert.ok(isShellRequest({ type: 'drain', id: 'a', boundMs: 30_000 }));
    for (const bad of [null, 'shutdown', { type: 'readiness?' }, { type: 'readiness?', id: '' }, { type: 'drain', id: 'a' },
      { type: 'drain', id: 'a', boundMs: -1 }, { type: 'drain', id: 'a', boundMs: MAX_DRAIN_MS + 1 }, { type: 'restart', id: 'a' }]) {
      assert.ok(!isShellRequest(bad), `refused: ${JSON.stringify(bad)}`);
    }
    console.log('✓ only well-formed readiness and bounded drain requests are acted on');
  }

  // ── the audit entry the new version writes ─────────────────────────────────
  {
    const { recordUpdateIfAny, updateAction, UPDATE_ACTOR } = await import('../src/server/boot-audit.js');
    const { readAdminActions, verifyChain } = await import('../src/audit/log.js');
    const now = new Date('2026-09-25T12:00:30.000Z');
    const env = { WARDEN_UPDATED_FROM: '0.2.23', WARDEN_UPDATED_STOPPED_AT: '2026-09-25T12:00:00.000Z', WARDEN_UPDATE_CUTOFF: '1' };
    assert.equal(updateAction(env, '0.2.24', now),
      'desktop update 0.2.23 -> 0.2.24; offline 2026-09-25T12:00:00.000Z -> 2026-09-25T12:00:30.000Z; requests cut off 1');
    assert.equal(updateAction({}, '0.2.24', now), null, 'an ordinary launch records nothing');
    for (const broken of [{ ...env, WARDEN_UPDATED_FROM: 'v0.2.23' }, { ...env, WARDEN_UPDATED_STOPPED_AT: 'yesterday' }, { ...env, WARDEN_UPDATE_CUTOFF: '-1' }, { WARDEN_UPDATED_FROM: '0.2.23' }]) {
      assert.equal(updateAction(broken, '0.2.24', now), null, `a partial description records nothing: ${JSON.stringify(broken)}`);
    }

    const before = (await readAdminActions(100)).length;
    recordUpdateIfAny({});
    assert.equal((await readAdminActions(100)).length, before);
    recordUpdateIfAny(env);
    const entries = await readAdminActions(100);
    assert.equal(entries.length, before + 1, 'exactly one entry');
    assert.deepEqual(entries[0]?.actor, UPDATE_ACTOR, 'recorded as the desktop operator, not as an administrator');
    assert.match(entries[0]?.action ?? '', /^desktop update 0\.2\.23 -> \S+; offline 2026-09-25T12:00:00\.000Z -> /);
    assert.equal(verifyChain().ok, true, 'the chain still verifies');
    console.log('✓ the new version records the update once, as the desktop operator, and the audit chain holds');
  }
}

main()
  .then(() => { rmSync(scratch, { recursive: true, force: true }); process.exit(0); })
  .catch((err: unknown) => {
    console.error(err);
    rmSync(scratch, { recursive: true, force: true });
    process.exit(1);
  });
