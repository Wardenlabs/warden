/** Browser requests cannot borrow loopback administration from an unrelated page. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import express from 'express';
import { securityHeaders } from '../src/server/middleware.js';
import { safeExternalUrl } from '../desktop/navigation.js';
import { requireAdmin } from '../src/server/admin-auth.js';

const app = express();
app.use(securityHeaders, requireAdmin);
app.all('/api/probe', (_req, res) => res.json({ ok: true }));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
try {
  const probe = (headers: Record<string, string>, method = 'POST'): Promise<number> => new Promise((resolve, reject) => {
    const req = request(`${origin}/api/probe`, { method, headers }, (res) => { res.resume(); resolve(res.statusCode!); });
    req.on('error', reject); req.end();
  });
  assert.equal(await probe({}), 200, 'local CLI remains usable');
  assert.equal(await probe({ Origin: origin }), 200, 'same-origin console remains usable');
  assert.equal(await probe({ Origin: 'https://unrelated.example', 'Content-Type': 'text/plain' }), 403, 'simple cross-origin POST must not mutate');
  assert.equal(await probe({ Origin: 'null' }), 403, 'sandboxed origins have no loopback trust');
  assert.equal(await probe({ 'Sec-Fetch-Site': 'cross-site' }, 'GET'), 403, 'cross-site subresources have no loopback trust');
  assert.equal(await probe({ Host: 'rebound.example', Origin: 'http://rebound.example' }), 403, 'DNS rebinding cannot gain local administration');
  assert.equal(await probe({ Host: 'localhost.evil.example' }), 403, 'localhost suffix confusion is refused');
  assert.equal(await probe({ Host: 'localhost', Origin: 'http://localhost:9999' }), 403, 'ports are part of the origin');
  const response = await fetch(`${origin}/api/probe`);
  assert.match(response.headers.get('content-security-policy')!, /script-src 'self';/);
  for (const link of ['file:///etc/passwd', 'javascript:alert(1)', 'custom:open', 'https://user:password@example.com', 'bad url']) assert.equal(safeExternalUrl(link), false);
  assert.equal(safeExternalUrl('https://example.com/docs'), true);
  console.log('Browser administration and desktop navigation boundaries passed.');
} finally { server.close(); }
