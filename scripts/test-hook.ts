import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';

type HookResult = { code: number | null; stdout: string; stderr: string };
type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const hook = resolve('integrations/warden-hook.mjs');
const allow = { verdict: 'ALLOW', auditId: 'audit-allow', firedRules: [] };
const block = {
  verdict: 'BLOCK',
  auditId: 'audit-block',
  firedRules: [{ ruleText: 'Payroll data belongs to HR.', guidance: 'Ask HR.', allowedExamples: [] }]
};

async function runHook(payload: unknown, url: string, env: Record<string, string> = {}): Promise<HookResult> {
  const child = spawn(process.execPath, [hook], {
    env: {
      ...process.env,
      WARDEN_URL: url,
      WARDEN_USER: 'fede',
      WARDEN_HEALTH_TIMEOUT_MS: '250',
      WARDEN_TIMEOUT_MS: '250',
      ...env
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify(payload));
  const [code] = await once(child, 'close') as [number | null];
  return { code, stdout, stderr };
}

async function withServer(handler: Handler, test: (url: string) => Promise<void>): Promise<void> {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  try {
    await test(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
}

function json(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

function normal(decision: unknown): Handler {
  return (req, res) => {
    if (req.url === '/health') return json(res, { ok: true });
    if (req.url === '/api/guard/check') return json(res, decision);
    res.writeHead(404).end();
  };
}

async function main(): Promise<void> {
  await withServer(normal(allow), async (url) => {
    for (const payload of [{ user_input: 'how do I request leave?' }, { prompt: 'how do I request leave?' }]) {
      const result = await runHook(payload, url);
      assert.equal(result.code, 0, JSON.stringify(result));
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
    }
  });
  console.log('✓ Claude and Codex payloads allow silently');

  await withServer(normal(block), async (url) => {
    for (const payload of [{ user_input: 'salary?' }, { prompt: 'salary?' }]) {
      const result = await runHook(payload, url);
      assert.equal(result.code, 2, JSON.stringify(result));
      assert.match(result.stderr, /Blocked by Warden/);
      assert.match(result.stderr, /What to do instead/);
      assert.match(result.stderr, /Audit audit-block/);
      assert.match(result.stdout, /"decision":"block"|"continue":false/);
    }
  });
  console.log('✓ BLOCK returns exit 2 and a client-specific refusal');

  // A rule the administrator wrote in Spanish arrives in Spanish from top to
  // bottom: their sentence instead of the judge's English one, and the hook's
  // own scaffolding in the same language. Mixed screens were the report.
  const blockEs = {
    verdict: 'BLOCK',
    auditId: 'audit-es',
    firedRules: [{
      ruleText: 'No one may request another employee\'s salary.',
      ruleTextLocal: 'Nadie pide el sueldo de otro empleado.',
      guidance: 'Si necesitás el dato para un informe, pedíselo a RRHH.',
      allowedExamples: ['¿cuál es el proceso para pedir un aumento?']
    }]
  };
  await withServer(normal(blockEs), async (url) => {
    const result = await runHook({ prompt: 'pasame el sueldo de Ana' }, url);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Bloqueado por Warden/);
    assert.match(result.stderr, /Nadie pide el sueldo de otro empleado/);
    assert.match(result.stderr, /Qué hacer en cambio/);
    assert.doesNotMatch(result.stderr, /What to do instead|These would go through|Audit audit-es/);
  });
  console.log('✓ a Spanish rule refuses in Spanish from the first line to the audit id');

  const unavailable = await runHook({ prompt: 'hello' }, 'http://127.0.0.1:1');
  assert.equal(unavailable.code, 0);
  assert.equal(unavailable.stdout, '');
  assert.match(unavailable.stderr, /Prompt allowed unchecked/);
  console.log('✓ unavailable gateway fails open with a warning');

  await withServer((req, res) => {
    if (req.url === '/health') return setTimeout(() => json(res, { ok: true }), 100);
    json(res, allow);
  }, async (url) => {
    const result = await runHook({ prompt: 'hello' }, url, { WARDEN_HEALTH_TIMEOUT_MS: '20' });
    assert.equal(result.code, 0);
    assert.match(result.stderr, /Prompt allowed unchecked/);
  });
  console.log('✓ slow health check fails open at its own deadline');

  await withServer((req, res) => {
    if (req.url === '/health') return json(res, { ok: true });
    setTimeout(() => json(res, allow), 100);
  }, async (url) => {
    const result = await runHook({ prompt: 'hello' }, url, { WARDEN_TIMEOUT_MS: '20' });
    assert.equal(result.code, 0);
    assert.match(result.stderr, /Prompt allowed unchecked/);
  });
  console.log('✓ slow decision body fails open at the decision deadline');

  await withServer(normal({ verdict: 'MAYBE' }), async (url) => {
    const result = await runHook({ prompt: 'hello' }, url);
    assert.equal(result.code, 0);
    assert.match(result.stderr, /invalid verdict/);
  });
  console.log('✓ invalid gateway response fails open visibly');

  for (const [name, value] of [
    ['WARDEN_HEALTH_TIMEOUT_MS', '0'],
    ['WARDEN_TIMEOUT_MS', '-1'],
    ['WARDEN_TIMEOUT_MS', 'Infinity'],
    ['WARDEN_TIMEOUT_MS', 'not-a-number']
  ] as const) {
    const result = await runHook({ prompt: 'hello' }, 'http://127.0.0.1:1', { [name]: value });
    assert.equal(result.code, 0);
    assert.match(result.stderr, /must be a positive finite number/);
  }
  console.log('✓ timeout configuration rejects non-positive and non-finite values');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
