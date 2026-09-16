import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

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
      // Healthy child-process requests must survive a loaded CI machine.
      // Deadline-specific cases below override these with a short timeout.
      WARDEN_HEALTH_TIMEOUT_MS: '2000',
      WARDEN_TIMEOUT_MS: '2000',
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
      // The desktop app shows none of stderr, reason or stopReason when it
      // erases a prompt; systemMessage is the one field Claude Code documents
      // as reaching the person on every platform, so the refusal must be there
      // too, whole, down to the audit id they would cite to appeal it.
      const body = JSON.parse(result.stdout);
      assert.equal(body.systemMessage, body.reason);
      assert.match(body.systemMessage, /Blocked by Warden[\s\S]*Audit audit-block/);
    }
  });
  console.log('✓ BLOCK returns exit 2 and a client-specific refusal, with systemMessage for the desktop app');

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

  // The gateway compiling a rule through a CLI must not be judged by its own
  // hook. The marker lets it through without a request; a gateway that would
  // block everything proves nothing was asked.
  await withServer(normal(block), async (url) => {
    const result = await runHook({ prompt: 'A rule states what is PROHIBITED…' }, url, { WARDEN_INTERNAL: '1' });
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });
  console.log('✓ WARDEN_INTERNAL lets the gateway\'s own compile through unjudged');

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

  // Claude Code cancels a UserPromptSubmit hook at 30 s unless the entry says
  // otherwise, and a cancelled hook lets the prompt through. So the entry
  // --fix writes has to carry the timeout, and an entry written before it did
  // has to be repaired rather than left alone as "already wired".
  const home = mkdtempSync(join(tmpdir(), 'warden-fix-'));
  const settings = join(home, '.claude', 'settings.json');
  mkdirSync(join(home, '.claude'), { recursive: true });
  const fix = async () => {
    const child = spawn(process.execPath, [hook, '--fix'], {
      env: { ...process.env, HOME: home, WARDEN_URL: 'http://gw.test:8080', WARDEN_API_KEY: 'wk-test-key' },
      stdio: 'ignore'
    });
    await once(child, 'close');
    return JSON.parse(readFileSync(settings, 'utf8')) as {
      env?: Record<string, string>;
      hooks: { UserPromptSubmit: { hooks: { command: string; timeout?: number }[] }[] };
    };
  };
  writeFileSync(settings, '{}');
  let entries = (await fix()).hooks.UserPromptSubmit.flatMap((e) => e.hooks);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.timeout, 300);
  const referenceSettings = JSON.parse(readFileSync(resolve('integrations/claude-code/settings.json'), 'utf8'));
  assert.equal(referenceSettings.hooks.UserPromptSubmit[0].hooks[0].timeout, entries[0]?.timeout, 'the reference settings and installer must allow the same document budget');
  writeFileSync(settings, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node /old/.warden-hook.mjs' }] }] } }));
  const repaired = await fix();
  entries = repaired.hooks.UserPromptSubmit.flatMap((e) => e.hooks);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.command, 'node /old/.warden-hook.mjs');
  assert.equal(entries[0]?.timeout, 300);
  // A Claude Code opened from the desktop app never reads the shell profile,
  // so the gateway address and key have to be in settings.json's env block
  // for its hook to reach anything. Both writes put them there; a value the
  // person set by hand for some other variable survives.
  assert.equal(repaired.env?.WARDEN_URL, 'http://gw.test:8080');
  assert.equal(repaired.env?.WARDEN_API_KEY, 'wk-test-key');
  writeFileSync(settings, JSON.stringify({ env: { OTHER: 'kept', WARDEN_URL: 'http://stale:1' }, hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node /old/.warden-hook.mjs', timeout: 120 }] }] } }));
  const refreshed = await fix();
  assert.equal(refreshed.hooks.UserPromptSubmit.flatMap((entry) => entry.hooks)[0]?.timeout, 300, 'repair the old 120-second entry for document checks');
  assert.deepEqual(refreshed.env, { OTHER: 'kept', WARDEN_URL: 'http://gw.test:8080', WARDEN_API_KEY: 'wk-test-key' });
  console.log('✓ --fix writes the Claude Code hook timeout, repairs an entry without one, and puts the gateway in env');

  /*
   * --unfix is the counterpart --fix never had, and the only reason it is safe
   * to offer is that it removes Warden's own lines and nothing else. Somebody
   * running it is already having a bad morning; losing the rest of their hooks
   * would be how Warden gets uninstalled rather than turned off.
   */
  const unfixHome = mkdtempSync(join(tmpdir(), 'warden-unfix-'));
  const unfixSettings = join(unfixHome, '.claude', 'settings.json');
  mkdirSync(join(unfixHome, '.claude'), { recursive: true });
  const unfix = async () => {
    const child = spawn(process.execPath, [hook, '--unfix'], {
      env: { ...process.env, HOME: unfixHome, WARDEN_URL: 'http://gw.test:8080', WARDEN_API_KEY: 'wk-test-key' },
      stdio: 'ignore'
    });
    await once(child, 'close');
    return JSON.parse(readFileSync(unfixSettings, 'utf8')) as {
      env?: Record<string, string>;
      hooks?: { UserPromptSubmit?: { hooks: { command: string }[] }[]; SessionStart?: unknown };
    };
  };

  writeFileSync(unfixSettings, JSON.stringify({
    env: { OTHER: 'kept', WARDEN_URL: 'http://gw.test:8080', WARDEN_API_KEY: 'wk-test-key' },
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'node /somebody/else.mjs' }] }],
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: 'node /home/me/.warden-hook.mjs', timeout: 300 }] },
        { hooks: [{ type: 'command', command: 'node /somebody/else/lint.mjs' }, { type: 'command', command: 'node /home/me/.warden-hook.mjs' }] }
      ]
    }
  }));
  const unwired = await unfix();
  assert.equal(unwired.hooks?.UserPromptSubmit?.flatMap((e) => e.hooks).filter((h) => h.command.includes('warden-hook')).length, 0,
    'every Warden hook entry is gone');
  assert.deepEqual(unwired.hooks?.UserPromptSubmit?.flatMap((e) => e.hooks).map((h) => h.command), ['node /somebody/else/lint.mjs'],
    "a stranger's hook sharing an entry with Warden's survives, and its entry is not dropped with ours");
  assert.ok(unwired.hooks?.SessionStart, 'another event is not touched');
  assert.deepEqual(unwired.env, { OTHER: 'kept' }, 'the two variables --fix wrote come out, and nothing else does');
  assert.ok(existsSync(`${unfixSettings}.warden-bak`), 'the file is backed up before it is edited');

  // Running it twice is not an error and does not keep editing the file.
  const again = await unfix();
  assert.deepEqual(again, unwired, 'a second --unfix finds nothing of ours and changes nothing');

  // A file it cannot parse is a file it does not touch. Guessing at broken JSON
  // is how somebody loses a config they spent a year building.
  const brokenHome = mkdtempSync(join(tmpdir(), 'warden-unfix-broken-'));
  mkdirSync(join(brokenHome, '.claude'), { recursive: true });
  const broken = join(brokenHome, '.claude', 'settings.json');
  writeFileSync(broken, '{ "hooks": { "UserPromptSubmit": [ }}} not json');
  const brokenRun = spawn(process.execPath, [hook, '--unfix'], {
    env: { ...process.env, HOME: brokenHome }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let brokenSaid = '';
  brokenRun.stdout.setEncoding('utf8').on('data', (chunk) => { brokenSaid += chunk; });
  await once(brokenRun, 'close');
  assert.equal(readFileSync(broken, 'utf8'), '{ "hooks": { "UserPromptSubmit": [ }}} not json', 'unparseable settings are left byte for byte');
  assert.match(brokenSaid, /not valid JSON/, 'and it says so instead of pretending it unwired something');
  console.log('✓ --unfix removes only what Warden wrote, backs up first, and refuses a file it cannot parse');

  // Codex's config is TOML and there is no parser in a file whose whole
  // argument is that it has no dependencies, so --unfix removes the region
  // --fix marked with a comment and refuses anything it did not write.
  const codexHome = mkdtempSync(join(tmpdir(), 'warden-unfix-codex-'));
  mkdirSync(join(codexHome, '.codex'), { recursive: true });
  const codexConfig = join(codexHome, '.codex', 'config.toml');
  const unfixCodex = async () => {
    const child = spawn(process.execPath, [hook, '--unfix'], { env: { ...process.env, HOME: codexHome }, stdio: ['ignore', 'pipe', 'pipe'] });
    let said = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { said += chunk; });
    await once(child, 'close');
    return { said, body: readFileSync(codexConfig, 'utf8') };
  };

  writeFileSync(codexConfig, [
    'model = "gpt-5"',
    '',
    '[[hooks.SessionStart]]',
    '',
    '[[hooks.SessionStart.hooks]]',
    'type = "command"',
    'command = "node /somebody/else.mjs"',
    '',
    '# Added by warden-hook --fix. Remove this block to stop routing prompts',
    '# through Warden; the file next to this one ending .warden-bak is what it',
    '# looked like before.',
    '[[hooks.UserPromptSubmit]]',
    '',
    '[[hooks.UserPromptSubmit.hooks]]',
    'type = "command"',
    'command = "node /home/me/.warden-hook.mjs"',
    '',
    '[tui]',
    'theme = "dark"',
    ''
  ].join('\n'));
  const codexAfter = await unfixCodex();
  assert.doesNotMatch(codexAfter.body, /warden-hook/, "Warden's block is gone");
  assert.match(codexAfter.body, /model = "gpt-5"/, 'what came before it survives');
  assert.match(codexAfter.body, /\[\[hooks\.SessionStart\]\]/, "somebody else's hook survives");
  assert.match(codexAfter.body, /theme = "dark"/, 'and so does what came after it');

  // Wired by hand, or by a version that did not leave the marker: refuse.
  writeFileSync(codexConfig, '[[hooks.UserPromptSubmit.hooks]]\ncommand = "node ~/warden-hook.mjs"\n');
  const handWired = await unfixCodex();
  assert.equal(handWired.body, '[[hooks.UserPromptSubmit.hooks]]\ncommand = "node ~/warden-hook.mjs"\n', 'a block this did not write is left byte for byte');
  assert.match(handWired.said, /not in a block this wrote/, 'and it says which lines to remove by hand');
  console.log('✓ --unfix cuts its own marked TOML block and refuses one it did not write');

  /*
   * --status answers the three questions the PRD opens with, and its exit code
   * is what a setup script branches on. The gateway naming itself is the whole
   * point: a key refused by the Warden that did not issue it used to be
   * indistinguishable from a key that was simply wrong.
   */
  const statusHome = mkdtempSync(join(tmpdir(), 'warden-status-'));
  mkdirSync(join(statusHome, '.claude'), { recursive: true });
  writeFileSync(join(statusHome, '.claude', 'settings.json'), JSON.stringify({
    env: { WARDEN_API_KEY: 'wk-fede-aaaa' },
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node /home/me/.warden-hook.mjs', timeout: 300 }] }] }
  }));

  const status = async (url: string, key: string) => {
    const child = spawn(process.execPath, [hook, '--status'], {
      env: { ...process.env, HOME: statusHome, WARDEN_URL: url, WARDEN_API_KEY: key, WARDEN_HEALTH_TIMEOUT_MS: '2000' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let said = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { said += chunk; });
    const [code] = await once(child, 'close') as [number | null];
    return { code, said };
  };

  const gateway: Handler = (req, res) => {
    if (req.url === '/health') return json(res, { ok: true, installation: { label: 'the-other-warden', version: '9.9.9', dataDir: '/elsewhere/data' } });
    if (req.url === '/api/identity') {
      const key = /Bearer\s+(.+)/.exec(req.headers.authorization ?? '')?.[1];
      if (key !== 'wk-fede-aaaa') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'unknown_api_key' })); }
      return json(res, { id: 'fede', name: 'Fede', role: 'engineer', paused: false });
    }
    res.writeHead(404); res.end();
  };

  await withServer(gateway, async (url) => {
    const good = await status(url, 'wk-fede-aaaa');
    assert.equal(good.code, 0, 'a gateway, a key it knows and a wired tool exits zero');
    assert.match(good.said, /the-other-warden/, 'it names which installation answered');
    assert.match(good.said, /\/elsewhere\/data/, 'and where that one keeps its state');
    assert.match(good.said, /Fede/, 'and who the gateway thinks this key is');

    const stranger = await status(url, 'wk-someone-else');
    assert.notEqual(stranger.code, 0, 'a key the gateway does not know is not a pass');
    assert.match(stranger.said, /does not recognise it/);
    assert.match(stranger.said, /only valid in the installation that issued it/, 'and says why, which is the sentence the whole PRD is about');
    assert.match(stranger.said, /ending else/, 'a key is shown by its last four characters and never in full');
    assert.doesNotMatch(stranger.said, /wk-someone-else/, 'the key itself never reaches the output somebody pastes into chat');

    // The two copies of the key disagreeing is the quiet failure: the terminal
    // is judged as one person and the app as another, and nothing said so.
    const split = await status(url, 'wk-fede-bbbb');
    assert.notEqual(split.code, 0);
    assert.match(split.said, /different key/);
  });

  const down = await status('http://127.0.0.1:1', 'wk-fede-aaaa');
  assert.notEqual(down.code, 0, 'no gateway is not a pass');
  assert.match(down.said, /UNCHECKED/, 'and the fail-open is said out loud rather than left in SECURITY.md');
  console.log('✓ --status names the gateway, the identity and the wiring, and its exit code says whether all three are good');

  // Under the Claude desktop app the block is also shown as an OS dialog,
  // because the app draws none of reason, stopReason or systemMessage. The
  // dialog must never delay the block: a hook held open past Claude Code's
  // deadline is cancelled, and a cancelled hook lets the prompt through. So
  // a stand-in dialog binary that hangs for 30 s has to leave the hook
  // exiting 2 in well under that, with the refusal handed to it whole. The
  // stand-in is whichever binary this platform would use; Windows resolves
  // powershell.exe through PATHEXT and the same trick does not reach it, so
  // the win32 branch is only checked for its shape.
  const standIn = process.platform === 'darwin' ? 'osascript' : process.platform === 'linux' ? 'zenity' : null;
  if (standIn) {
    const bin = mkdtempSync(join(tmpdir(), 'warden-dialog-'));
    const seen = join(bin, 'seen.txt');
    writeFileSync(join(bin, standIn), `#!/bin/sh\nprintf '%s\\n' "$@" > "${seen}"\nsleep 30\n`, { mode: 0o755 });
    await withServer(normal(block), async (url) => {
      const started = Date.now();
      const result = await runHook({ hook_event_name: 'UserPromptSubmit', prompt: 'salary?' }, url, {
        CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
        PATH: `${bin}:${process.env.PATH ?? ''}`
      });
      assert.equal(result.code, 2, JSON.stringify(result));
      assert.ok(Date.now() - started < 10_000, 'the dialog delayed the block');
      // Detached means the hook can exit before the stand-in has written a
      // byte; give it a moment, which is the point being tested.
      const until = Date.now() + 5_000;
      while (!existsSync(seen) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      assert.match(readFileSync(seen, 'utf8'), /Blocked by Warden[\s\S]*Audit audit-block/);
      assert.match(readFileSync(seen, 'utf8'), /Warden/);
    });
    console.log(`✓ under the desktop app the refusal also opens an OS dialog (${standIn}), without delaying the block`);
  }
  // Without the entrypoint nothing is opened, whatever the platform: the
  // terminal already shows the refusal, and a second copy in a window would
  // be the noise people learn to dismiss without reading.
  if (standIn) {
    const bin = mkdtempSync(join(tmpdir(), 'warden-nodialog-'));
    const seen = join(bin, 'seen.txt');
    writeFileSync(join(bin, standIn), `#!/bin/sh\ntouch "${seen}"\n`, { mode: 0o755 });
    await withServer(normal(block), async (url) => {
      const result = await runHook({ hook_event_name: 'UserPromptSubmit', prompt: 'salary?' }, url, { PATH: `${bin}:${process.env.PATH ?? ''}` });
      assert.equal(result.code, 2);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(existsSync(seen), false, 'a dialog opened outside the desktop app');
    });
    console.log('✓ outside the desktop app no dialog is opened');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
