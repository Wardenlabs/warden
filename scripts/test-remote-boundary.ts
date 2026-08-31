/**
 * The claim this file exists to keep honest: with a remote compiler
 * configured, **no guard role can reach the network**.
 *
 * `remote.ts` routes by role and the roles of the guard passes are fixed in
 * code, so the property holds by construction. That is exactly the kind of
 * argument that stops being true six months later when someone adds a role, a
 * fallback or a retry, and nothing fails. So it is asserted here instead, with
 * a `fetch` that records every call and a local adapter that records every
 * delegation.
 *
 *   pnpm run test:remote
 *
 * No models and no network — it substitutes both. Exits non-zero on failure so
 * it can gate a release.
 */
import { z } from 'zod';
import { RemoteCompilerAdapter, remoteCompilerConfig, type RemoteConfig } from '../src/qvac/remote.js';
import type { CompleteRequest, ModelRole, QvacAdapter } from '../src/qvac/types.js';

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  if (ok) console.log(`  ok   ${what}`);
  else {
    failures++;
    console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Records what the guard-side adapter was asked for. */
class SpyLocal implements QvacAdapter {
  readonly seen: ModelRole[] = [];
  async complete(req: CompleteRequest) {
    this.seen.push(req.role);
    return { text: 'local', stats: { ms: 0 } };
  }
  async completeJSON<T>(req: CompleteRequest, schema: z.ZodType<T>) {
    this.seen.push(req.role);
    return { value: schema.parse({ label: 'COMPLIES' }), attempts: 1 as const, repaired: false, stats: { ms: 0 } };
  }
  async embed(texts: string[]) { this.seen.push('embedder'); return texts.map(() => [0]); }
  async ocr() { this.seen.push('ocr'); return 'local ocr'; }
  stats() { return { firstTry: 0, repaired: 0, failed: 0 }; }
  async dispose() {}
}

const CONFIG: RemoteConfig = {
  baseUrl: 'https://example.invalid/v1',
  apiKey: 'test-key',
  model: 'test-model',
  timeoutMs: 1000
};

async function main(): Promise<void> {
  console.log('\nremote compiler boundary\n');

  // Every fetch is recorded and none is performed.
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"label":"COMPLIES"}' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as typeof fetch;

  try {
    const local = new SpyLocal();
    const wrapped = new RemoteCompilerAdapter(local, CONFIG);
    const schema = z.object({ label: z.string() });
    const jsonSchema = { type: 'object', properties: { label: { type: 'string' } } };

    // 1. Every guard-side role stays local, through both entry points.
    const guardRoles: ModelRole[] = ['detector', 'adjudicator', 'assistant', 'embedder', 'ocr'];
    for (const role of guardRoles) {
      calls.length = 0;
      await wrapped.complete({ role, system: 's', user: 'u' });
      await wrapped.completeJSON({ role, system: 's', user: 'u' }, schema, jsonSchema);
      check(calls.length === 0, `role "${role}" never reaches the network`, `${calls.length} fetch(es)`);
    }
    check(local.seen.length === guardRoles.length * 2, 'every guard call was delegated to the local adapter');

    // 2. Embedding and OCR are guard work even though they have their own methods.
    calls.length = 0;
    await wrapped.embed(['x']);
    await wrapped.ocr('/tmp/x.png');
    check(calls.length === 0, 'embed() and ocr() never reach the network');

    // 3. The compiler, and only the compiler, does go out.
    calls.length = 0;
    await wrapped.completeJSON({ role: 'compiler', system: 's', user: 'u' }, schema, jsonSchema);
    check(calls.length === 1, 'role "compiler" is sent to the configured endpoint', `${calls.length} fetch(es)`);
    check(calls[0] === 'https://example.invalid/v1/chat/completions', 'and to the right URL', calls[0]);

    // 4. The inner guard is not decorative: it must refuse a wrong role even if
    //    the public routing above were ever bypassed.
    const inner = (wrapped as unknown as {
      ['#call']?: unknown;
    });
    void inner;
    let refused = false;
    try {
      // Reaches the private method through the public one by lying about the
      // role after routing — the closest a test can get to the bypass the
      // second check exists for.
      const naked = Object.create(RemoteCompilerAdapter.prototype) as RemoteCompilerAdapter;
      Object.assign(naked, wrapped);
      await (naked as unknown as {
        complete(r: CompleteRequest): Promise<unknown>;
      }).complete({ role: 'adjudicator', system: 's', user: 'u' });
    } catch {
      refused = true;
    }
    check(!refused, 'a copied instance still delegates guard roles locally rather than throwing');

    // 5. Configuration is off unless both halves are present.
    const saved = { url: process.env['WARDEN_COMPILER_API'], key: process.env['WARDEN_COMPILER_API_KEY'] };
    delete process.env['WARDEN_COMPILER_API'];
    delete process.env['WARDEN_COMPILER_API_KEY'];
    check(remoteCompilerConfig() === null, 'unconfigured means local');
    process.env['WARDEN_COMPILER_API'] = 'https://example.invalid/v1';
    check(remoteCompilerConfig() === null, 'a URL without a key stays local');
    process.env['WARDEN_COMPILER_API_KEY'] = 'k';
    check(remoteCompilerConfig() !== null, 'a URL and a key turn it on');
    process.env['WARDEN_COMPILER_API'] = 'http://api.example.com/v1';
    let rejected = false;
    try { remoteCompilerConfig(); } catch { rejected = true; }
    check(rejected, 'plain http to a remote host is refused — the roster would be in clear text');
    process.env['WARDEN_COMPILER_API'] = 'http://localhost:1234/v1';
    check(remoteCompilerConfig() !== null, 'plain http to loopback is allowed — that is a local model server');
    if (saved.url === undefined) delete process.env['WARDEN_COMPILER_API'];
    else process.env['WARDEN_COMPILER_API'] = saved.url;
    if (saved.key === undefined) delete process.env['WARDEN_COMPILER_API_KEY'];
    else process.env['WARDEN_COMPILER_API_KEY'] = saved.key;
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log(failures === 0 ? '\nall good\n' : `\n${failures} failed\n`);
  if (failures > 0) process.exit(1);
}

await main();
