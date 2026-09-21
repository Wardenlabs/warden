/** Real child processes exercise the single-file employee install contract. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'warden-hook-documents-'));
const hook = resolve('integrations/warden-hook.mjs');
const text = 'Quarterly report: the team completed the migration.';
const data = Buffer.from(text).toString('base64');
const sha256 = createHash('sha256').update(text).digest('hex');
const file = join(root, 'report.txt');
const timerProbe = join(root, 'observe-request-timers.mjs');
writeFileSync(timerProbe, `const original = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => {
  process.stderr.write('WARDEN_TEST_TIMER:' + delay + '\\n');
  return original(callback, delay, ...args);
};
`);
writeFileSync(file, text);
writeFileSync(join(root, 'oversized.txt'), Buffer.alloc(8 * 1024 * 1024 + 1));
const seen: Record<string, any>[] = [];
let status = 200;
let response: Record<string, unknown> | null = null;
let healthDeadlines: Record<string, unknown> | undefined;
const server = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/health') return res.end(JSON.stringify({ ok: true, failClosed: false, deadlines: healthDeadlines }));
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  seen.push(body);
  res.statusCode = status;
  res.end(JSON.stringify(response ?? {
    verdict: 'ALLOW', auditId: 'test-document', firedRules: [],
    documents: (body.attachments ?? []).map((d: { data: string; name: string }) => ({
      name: d.name, sha256: createHash('sha256').update(Buffer.from(d.data, 'base64')).digest('hex'),
      status: 'read', redactions: 0
    }))
  }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address === 'object');
const gatewayUrl = `http://127.0.0.1:${address.port}`;

async function run(payload: unknown, plugin = false, observeTimers = false, hookPath = hook) {
  const args = plugin ? ['--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    const { WardenPlugin } = await import(${JSON.stringify(pathToFileURL(resolve('integrations/opencode/warden.js')).href)});
    const event = JSON.parse(readFileSync(0, 'utf8'));
    try { await (await WardenPlugin())['chat.message']({}, { parts: event.parts }); }
    catch (err) { console.error(err.message); process.exitCode = 2; }
  `] : [hook];
  if (observeTimers) args.unshift('--import', timerProbe);
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env, HOME: root, USERPROFILE: root,
      WARDEN_HOOK_PATH: hookPath, WARDEN_URL: gatewayUrl,
      WARDEN_API_KEY: 'test-key', WARDEN_HEALTH_TIMEOUT_MS: '2000', WARDEN_TIMEOUT_MS: '5000',
      WARDEN_HOOK_STATE_PATH: join(root, 'state.json'), WARDEN_NO_DIALOG: '1'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (v) => { stdout += v; });
  child.stderr.on('data', (v) => { stderr += v; });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(payload));
  const [code] = await once(child, 'close');
  return { code, stdout, stderr };
}

try {
  const absent = await run({ parts: [{ type: 'text', text }] }, true, false, join(root, 'missing-hook.mjs'));
  assert.equal(absent.code, 2);
  assert.match(absent.stderr, /could not inspect/);
  console.log('✓ OpenCode refuses when its installed hook is missing');
  for (const [deadlines, expected] of [
    [undefined, 240_000],
    [{ decisionMs: 90_000, documentMs: 270_000 }, 270_000],
    [{ decisionMs: 90_000, documentMs: 1_000 }, 240_000],
    [{ decisionMs: 90_000, documentMs: '270000' }, 240_000],
    [{ decisionMs: 310_000, documentMs: 240_000 }, 310_000]
  ] as [Record<string, unknown> | undefined, number][]) {
    healthDeadlines = deadlines;
    const timed = await run({ attachments: [{ name: 'report.txt', data }] }, false, true);
    assert.equal(timed.code, 0, timed.stderr);
    const timers = [...timed.stderr.matchAll(/WARDEN_TEST_TIMER:(\d+)/g)].map((match) => Number(match[1]));
    assert(timers.includes(expected), `attachment request did not use ${expected} ms: ${timed.stderr}`);
  }
  healthDeadlines = { decisionMs: 90_000, documentMs: 270_000 };
  const ordinary = await run({ prompt: 'A text-only request.' }, false, true);
  assert.equal(ordinary.code, 0, ordinary.stderr);
  assert.match(ordinary.stderr, /WARDEN_TEST_TIMER:90000\n/);
  assert.doesNotMatch(ordinary.stderr, /WARDEN_TEST_TIMER:(240000|270000)\n/);
  healthDeadlines = undefined;
  console.log('✓ attachment transport covers 240 seconds, learns longer budgets, and preserves the text deadline');

  let result = await run({ prompt: '', cwd: root, attachments: [{ path: 'report.txt' }] });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(seen.at(-1)?.attachments, [{ name: 'report.txt', data }]);
  assert(!JSON.stringify(seen.at(-1)).includes(root), 'employee file paths must not reach the gateway');
  console.log('✓ file-only requests read explicit local references and send bytes');

  result = await run({ messages: [
    { role: 'user', content: [{ type: 'text', text: 'earlier request' }, { type: 'file', file: { filename: 'report.txt', file_data: data } }] },
    { role: 'user', content: 'continue' }
  ] });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(seen.at(-1)?.prompt, 'earlier request\n\ncontinue');
  assert.equal(seen.at(-1)?.attachments[0].data, data);
  console.log('✓ structured messages and files in earlier turns are inspected');

  for (const payload of [
    { attachments: [{ path: join(root, 'missing.txt') }] },
    { attachments: [{ path: root }] },
    { attachments: [{ path: join(root, 'oversized.txt') }] },
    { attachments: [{ name: 'invalid.txt', data: '====' }] },
    { attachments: Array.from({ length: 6 }, () => ({ name: 'file.txt', data })) },
    { parts: [{ type: 'image_url', image_url: { url: 'https://example.com/private.png' } }] },
    { parts: [{ type: 'input_audio', input_audio: { data } }] }
  ]) {
    const before = seen.length;
    result = await run(payload);
    assert.equal(result.code, 2, JSON.stringify({ payload, result }));
    assert.equal(JSON.parse(result.stdout).decision, 'block');
    assert.equal(seen.length, before, 'unreadable local input must not call the gateway');
  }
  console.log('✓ missing, nonregular, oversized, malformed and unsupported content is refused');

  for (const code of [400, 413, 415, 422]) {
    status = code;
    response = { error: 'invalid_attachment' };
    result = await run({ prompt: 'inspect', attachments: [{ name: 'report.txt', data }] });
    assert.equal(result.code, 2, `HTTP ${code}: ${JSON.stringify(result)}`);
    assert(!result.stderr.includes('allowed unchecked'));
  }
  status = 200;
  console.log('✓ input rejections are not mistaken for an unreachable gateway');

  for (const documents of [undefined, [], [{ sha256: 'wrong', status: 'read', redactions: 0 }], [{ sha256, status: 'unreadable', redactions: 0 }], [{ sha256, status: 'read', redactions: 1 }]]) {
    response = { verdict: 'ALLOW', auditId: 'bad-report', firedRules: [], ...(documents ? { documents } : {}) };
    result = await run({ attachments: [{ name: 'report.txt', data }] });
    assert.equal(result.code, 2, JSON.stringify(result));
  }
  console.log('✓ older gateways, mismatched extractions and original secret-bearing files cannot pass');

  response = null;
  result = await run({ parts: [{ type: 'file', url: pathToFileURL(file).href, mime: 'text/plain', filename: 'report.txt' }] }, true);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(seen.at(-1)?.source, 'opencode');
  assert.equal(seen.at(-1)?.attachments[0].data, data);
  response = { verdict: 'BLOCK', auditId: 'blocked-file', firedRules: [{ ruleText: 'Do not send payroll.' }] };
  result = await run({ parts: [{ type: 'text', text: 'inspect the report' }] }, true);
  assert.equal(result.code, 2, JSON.stringify(result));
  console.log('✓ OpenCode uses output.parts, transmits files and propagates a hook refusal');
} finally {
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
  rmSync(root, { recursive: true, force: true });
}
