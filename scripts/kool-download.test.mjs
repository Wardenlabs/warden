import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { createDownloadHandler, DOWNLOAD_EVENT, INSTALLERS } from '../integrations/kool/download-handler.mjs';

const EVENT_ID = '4af8e16e-35fd-4a2c-8f74-30ab15fca0e3';
const ATTRIBUTION = 'opaque_kool_click_fixture';
const INGEST = 'https://app.joinkool.co/api/integrations/events/ingest';
const FIELDS = { platform: 'macos', eventId: EVENT_ID };
const FORM = new URLSearchParams(FIELDS).toString();
const HEADERS = {
  host: 'warden.example', origin: 'https://warden.example',
  'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin',
};
const assetResponse = (extra = {}) => ({
  ok: true, status: 200, headers: new Headers({ 'content-type': 'application/octet-stream', 'content-length': '128' }),
  ...extra,
});
const deliveryResponse = (status = 200, extra = {}) => ({
  ok: status >= 200 && status < 300, status, headers: new Headers(),
  json: async () => ({ delivery: { id: 'opaque-delivery-id', status: 'TEST', duplicate: false }, ...extra }),
});

function harness(options = {}) {
  const { fields = FIELDS, body = new URLSearchParams(fields).toString(), parsedBody,
    method = 'POST', headers = {}, env = { KOOL_INGEST_TOKEN: 'fixture-ingest-token' }, ...handlerOptions } = options;
  const calls = [];
  const diagnostics = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init });
    if (init.method === 'HEAD') return assetResponse();
    return deliveryResponse();
  };
  const handler = createDownloadHandler({
    fetchImpl, env, diagnose: (...args) => diagnostics.push(args), ...handlerOptions,
  });
  const req = Readable.from([body]);
  Object.assign(req, { method, headers: { ...HEADERS, ...headers } });
  if (Object.hasOwn(options, 'parsedBody')) req.body = parsedBody;
  const res = {
    headers: {}, ended: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value) { this.body = value; this.ended = true; },
  };
  return { req, res, calls, diagnostics, run: () => handler(req, res) };
}

function assertRedirect(res, platform = 'macos') {
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers.location, INSTALLERS[platform]);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(res.ended, true);
}

test('a real form POST verifies the installer and sends only the Kool contract before redirecting', async () => {
  const calls = [];
  const handler = createDownloadHandler({
    env: { KOOL_INGEST_TOKEN: 'fixture-ingest-token', VERCEL_ENV: 'preview' },
    diagnose() {},
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init });
      return init.method === 'HEAD' ? assetResponse() : deliveryResponse();
    },
  });
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${origin}/api/download`, {
      method: 'POST', redirect: 'manual', headers: {
        origin, 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      }, body: new URLSearchParams({ ...FIELDS, clickId: ATTRIBUTION }),
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), INSTALLERS.macos);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-warden-kool-status'), 'test');
    assert.equal(response.headers.get('x-warden-kool-mode'), 'test');
    assert.deepEqual(calls.map(call => [call.url, call.method]), [[INSTALLERS.macos, 'HEAD'], [INGEST, 'POST']]);
    assert.equal(calls[0].headers, undefined, 'no Kool credential is sent to GitHub');
    assert.equal(calls[1].redirect, 'error');
    assert.equal(calls[1].headers.Authorization, 'Bearer fixture-ingest-token');
    assert.deepEqual(JSON.parse(calls[1].body), {
      event: DOWNLOAD_EVENT, eventId: EVENT_ID, clickId: ATTRIBUTION, test: true,
    });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('does not emit or finish the redirect while installer availability is still pending', async () => {
  let release;
  let lookups = 0;
  const bodies = [];
  const pending = new Promise(resolve => { release = resolve; });
  const h = harness({ fetchImpl: async (_url, init) => {
    if (init.method === 'HEAD') { lookups++; return pending; }
    bodies.push(init.body); return deliveryResponse();
  } });
  const running = h.run();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lookups, 1);
  assert.equal(bodies.length, 0);
  assert.equal(h.res.ended, false);
  release(assetResponse());
  await running;
  assert.equal(bodies.length, 1);
  assertRedirect(h.res);
});

test('supports Vercel parsed forms and sends no clickId for an unattributed download', async () => {
  const h = harness({ parsedBody: { ...FIELDS, platform: 'windows' } });
  await h.run();
  assertRedirect(h.res, 'windows');
  assert.deepEqual(JSON.parse(h.calls[1].body), { event: DOWNLOAD_EVENT, eventId: EVENT_ID, test: true });
  assert.deepEqual(h.diagnostics, [['delivery_confirmed', {
    event: DOWNLOAD_EVENT, eventId: EVENT_ID, deliveryId: 'opaque-delivery-id',
    status: 'TEST', duplicate: false, test: true, hasAttribution: false,
  }]]);
});

test('only a production deployment sends real events; absent, development and preview are tests', async () => {
  for (const environment of [undefined, 'development', 'preview', 'production']) {
    const h = harness({ env: { KOOL_INGEST_TOKEN: 'fixture-ingest-token', VERCEL_ENV: environment } });
    await h.run();
    assert.equal(JSON.parse(h.calls[1].body).test, environment !== 'production');
  }
});

test('GET, HEAD and other methods never check the installer or emit', async () => {
  for (const method of ['GET', 'HEAD', 'PUT', 'OPTIONS']) {
    const h = harness({ method });
    await h.run();
    assert.equal(h.res.statusCode, 405);
    assert.equal(h.res.headers.allow, 'POST');
    assert.equal(h.calls.length, 0);
  }
});

test('rejects cross-origin, missing, malformed and insecure origins before any network operation', async () => {
  for (const headers of [
    { origin: 'https://elsewhere.example' }, { origin: undefined }, { origin: 'null' },
    { origin: 'http://warden.example' }, { origin: 'https://warden.example/' },
    { origin: 'https://warden.example:444' }, { origin: 'https://name@warden.example' },
    { 'sec-fetch-site': 'cross-site' }, { host: 'other.example', 'x-forwarded-host': 'warden.example' },
  ]) {
    const h = harness({ headers });
    await h.run();
    assert.equal(h.res.statusCode, 403);
    assert.equal(h.calls.length, 0);
  }
});

test('rejects arbitrary fields, browser test mode, repeated keys, invalid IDs and oversized bodies', async () => {
  const cases = [
    { fields: { ...FIELDS, email: 'person@example.invalid' } },
    { fields: { ...FIELDS, test: 'false' } },
    { fields: { ...FIELDS, platform: 'linux' } },
    { fields: { ...FIELDS, platform: '__proto__' } },
    { fields: { ...FIELDS, eventId: 'person@example.invalid' } },
    { fields: { ...FIELDS, eventId: 'opaque-not-a-random-uuid' } },
    { fields: { ...FIELDS, clickId: '' } },
    { fields: { ...FIELDS, clickId: 'person@example.invalid' } },
    { fields: { ...FIELDS, clickId: 'a'.repeat(129) } },
    { body: `${FORM}&eventId=${EVENT_ID}` },
    { parsedBody: { ...FIELDS, clickId: [ATTRIBUTION, 'other'] } },
    { parsedBody: { ...FIELDS, eventId: 42 } },
    { parsedBody: [] },
    { parsedBody: null },
    { body: 'a'.repeat(1025) },
    { headers: { 'content-length': '1025' } },
    { headers: { 'content-type': 'application/json' } },
  ];
  for (const options of cases) {
    const h = harness(options);
    await h.run();
    assert.ok([400, 413, 415].includes(h.res.statusCode), `expected invalid body for ${JSON.stringify(options)}`);
    assert.equal(h.calls.length, 0);
    assert.equal(h.res.headers.location, undefined);
    assert.equal(h.res.body, 'Invalid download request.');
  }
});

test('follows allowlisted HTTPS release redirects with HEAD and rejects unsafe destinations', async () => {
  const tagged = 'https://github.com/Wardenlabs/warden/releases/download/v0.2.3/Warden-arm64.dmg';
  const asset = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/blob?sig=fixture';
  const calls = [];
  const h = harness({ fetchImpl: async (url, init) => {
    calls.push([url, init.method]);
    if (url === INSTALLERS.macos) return assetResponse({ status: 302, headers: new Headers({ location: tagged }) });
    if (url === tagged) return assetResponse({ status: 302, headers: new Headers({ location: asset }) });
    return init.method === 'HEAD' ? assetResponse({ url: asset }) : deliveryResponse();
  } });
  await h.run();
  assert.deepEqual(calls, [[INSTALLERS.macos, 'HEAD'], [tagged, 'HEAD'], [asset, 'HEAD'], [INGEST, 'POST']]);
  assertRedirect(h.res);

  for (const location of [
    'https://example.invalid/installer', 'https://github.com/other/repository/Warden-arm64.dmg',
    'http://release-assets.githubusercontent.com/file', 'https://github.com.attacker.invalid/file',
    'https://user:password@release-assets.githubusercontent.com/file', 'https://127.0.0.1/file',
  ]) {
    let attempts = 0;
    const invalid = harness({ fetchImpl: async () => {
      attempts++;
      return assetResponse({ status: 302, headers: new Headers({ location }) });
    } });
    await invalid.run();
    assert.equal(attempts, 1);
    assertRedirect(invalid.res);
    assert.deepEqual(invalid.diagnostics, [['installer_unavailable', undefined]]);
  }
});

test('unavailable, empty, HTML and failed installer responses redirect without recording a conversion', async () => {
  const responses = [
    assetResponse({ status: 404, ok: false }), assetResponse({ status: 503, ok: false }),
    assetResponse({ status: 204 }),
    assetResponse({ headers: new Headers({ 'content-type': 'text/html', 'content-length': '100' }) }),
    assetResponse({ headers: new Headers({ 'content-type': 'application/octet-stream', 'content-length': '0' }) }),
    assetResponse({ url: 'https://example.invalid/file' }),
    new Error('could include confidential upstream details'),
  ];
  for (const response of responses) {
    const calls = [];
    const h = harness({ fetchImpl: async (_url, init) => {
      calls.push(init.method);
      if (response instanceof Error) throw response;
      return response;
    } });
    await h.run();
    assert.deepEqual(calls, ['HEAD']);
    assertRedirect(h.res);
    assert.deepEqual(h.diagnostics, [['installer_unavailable', undefined]]);
  }
});

test('bounds installer verification so an unresponsive upstream cannot block download', async () => {
  let signal;
  const h = harness({ assetTimeoutMs: 20, fetchImpl: async (_url, init) => {
    signal = init.signal;
    return new Promise(() => {});
  } });
  await h.run();
  assert.equal(signal.aborted, true);
  assertRedirect(h.res);
  assert.deepEqual(h.diagnostics, [['installer_unavailable', undefined]]);
});

test('missing token and Kool errors fail open with redacted diagnostics', async () => {
  const missing = harness({ env: {} });
  await missing.run();
  assert.equal(missing.calls.length, 1);
  assertRedirect(missing.res);
  assert.deepEqual(missing.diagnostics, [['ingest_token_missing', undefined]]);
  assert.equal(missing.res.headers['x-warden-kool-status'], 'unconfigured');

  const broken = harness({ fetchImpl: async (_url, init) => {
    if (init.method === 'HEAD') return assetResponse();
    return deliveryResponse(422, { error: 'private credential fixture-ingest-token' });
  } });
  await broken.run();
  assertRedirect(broken.res);
  assert.deepEqual(broken.diagnostics, [['delivery_unconfirmed', { httpStatus: 422 }]]);
  assert.equal(broken.res.headers['x-warden-kool-status'], 'rejected-422');
  assert.ok(!JSON.stringify(broken.res.headers).includes('fixture-ingest-token'));
});

test('an SDK retry preserves the exact event ID, attribution, mode and serialized body', async () => {
  const source = { ...FIELDS, clickId: ATTRIBUTION };
  const attempts = [];
  const h = harness({ parsedBody: source, fetchImpl: async (_url, init) => {
    if (init.method === 'HEAD') {
      source.clickId = 'later_browser_reference';
      source.eventId = '00000000-0000-4000-8000-000000000000';
      return assetResponse();
    }
    attempts.push(init.body);
    return deliveryResponse(attempts.length === 1 ? 503 : 200);
  } });
  await h.run();
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0], attempts[1]);
  assert.deepEqual(JSON.parse(attempts[0]), { event: DOWNLOAD_EVENT, eventId: EVENT_ID, clickId: ATTRIBUTION, test: true });
  assertRedirect(h.res);
  assert.equal(h.diagnostics[0][1].hasAttribution, true);
  assert.ok(!JSON.stringify(h.diagnostics).includes(ATTRIBUTION));
});

test('bounds Kool delivery and prevents an aborted request from starting a later retry', async () => {
  let attempts = 0;
  let signal;
  const h = harness({ deliveryTimeoutMs: 20, fetchImpl: async (_url, init) => {
    if (init.method === 'HEAD') return assetResponse();
    attempts++;
    signal = init.signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }));
  } });
  await h.run();
  assertRedirect(h.res);
  assert.equal(signal.aborted, true);
  assert.deepEqual(h.diagnostics, [['delivery_unconfirmed', undefined]]);
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(attempts, 1);
});

test('a diagnostics failure cannot interrupt the fixed download redirect', async () => {
  const h = harness({ diagnose() { throw new Error('Logging unavailable'); } });
  await h.run();
  assertRedirect(h.res);
});
