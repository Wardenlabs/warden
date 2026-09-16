/**
 * Two promises about a gateway that knows which one it is.
 *
 * **The data directory does not leave this machine.** `/health` answers before
 * any credential and stays reachable through a tunnel, so the one field on it
 * that is a path inside somebody's home has to drop the moment the request came
 * from anywhere else. Asserted through the real route rather than against the
 * helper, because the way this breaks is somebody wiring the route to a
 * constant instead of to the caller.
 *
 * **A second gateway on a taken port says whose it is and stops.** That is the
 * whole of `docs/prd/wiring-and-unwiring.md` §0: the desktop app and a checkout
 * both default to 8080, the second printed Node's bind error, and whoever
 * started it pointed a hook at a gateway that had never issued their key.
 *
 *   pnpm run test:installation
 *
 * No models and no network. The child gets its own temporary state, so this
 * never touches an installation.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

type Health = { installation?: { label?: string; version?: string; dataDir?: string } };

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  if (ok) console.log(`  ok   ${what}`);
  else {
    failures++;
    console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ''}`);
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'warden-installation-'));

/** The same isolation `test-all.mjs` gives every suite, for the child we spawn. */
function isolated(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, WARDEN_ADAPTER: 'mock', ...extra };
  for (const field of ['AUDIT', 'POLICY', 'COMPANY', 'SETTINGS', 'PROMPT', 'PROMPT_TEMPLATES', 'APPEALS', 'ESCALATIONS', 'RATE_STATE', 'MODEL_CATALOG']) {
    env[`WARDEN_${field}_PATH`] = join(scratch, `${field.toLowerCase()}.json`);
  }
  env['WARDEN_MODELS_DIR'] = join(scratch, 'models');
  return env;
}

async function healthSaysWhereItIs(): Promise<void> {
  console.log('\n/health names the installation, and keeps its path at home\n');

  process.env['WARDEN_ADAPTER'] = 'mock';
  for (const field of ['AUDIT', 'POLICY', 'COMPANY', 'SETTINGS', 'PROMPT', 'PROMPT_TEMPLATES', 'APPEALS', 'ESCALATIONS', 'RATE_STATE', 'MODEL_CATALOG']) {
    process.env[`WARDEN_${field}_PATH`] ??= join(scratch, `${field.toLowerCase()}.json`);
  }
  const { createApp } = await import('../src/server/app.js');
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  const port = (server.address() as AddressInfo).port;

  try {
    const near = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as Health;
    check(typeof near.installation?.label === 'string' && near.installation.label.length > 0, 'a local caller is told which installation answered', JSON.stringify(near.installation));
    check(typeof near.installation?.version === 'string', 'and which version it is running');
    check(typeof near.installation?.dataDir === 'string', 'and where its data lives, because it is on this machine');

    // What a request relayed by a tunnel looks like: `isLoopback` refuses
    // anything carrying a proxy header, whatever the socket says.
    const far = (await (
      await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'x-forwarded-for': '203.0.113.7' } })
    ).json()) as Health;
    check(far.installation?.dataDir === undefined, 'a relayed caller is not told the path', JSON.stringify(far.installation));
    check(far.installation?.label === near.installation?.label, 'but is still told which installation it reached');

    await unknownKeySaysWhichGateway(port, String(near.installation?.label));
  } finally {
    await new Promise((done) => server.close(done));
  }
}

/**
 * The sentence the incident turned on. "Your key is not recognised" sent
 * somebody looking for a bad key; what they had was a good key belonging to the
 * other Warden, and no amount of re-issuing it was ever going to help.
 */
async function unknownKeySaysWhichGateway(port: number, label: string): Promise<void> {
  console.log('\na refused key is told which gateway refused it\n');

  const refuse = async (headers: Record<string, string>) => {
    const answer = await fetch(`http://127.0.0.1:${port}/api/guard/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wk-nobody-0000000000000000', ...headers },
      body: JSON.stringify({ prompt: 'hello' })
    });
    return { status: answer.status, body: (await answer.json()) as { error?: string; explanation?: string } };
  };

  const near = await refuse({});
  check(near.status === 401, 'an unknown key is still refused', `status ${near.status}`);
  check(near.body.error === 'unknown_api_key', 'and still refused as a credential problem, not a verdict');
  check(near.body.explanation?.includes(label) === true, 'the refusal names the gateway that issued it', near.body.explanation);
  check(near.body.explanation?.includes('Team → People') === true, 'and from this machine, says where to claim one');

  const far = await refuse({ 'x-forwarded-for': '203.0.113.7' });
  check(far.body.explanation?.includes(label) === true, 'a remote caller is told which gateway too');
  check(far.body.explanation?.includes('administrator') === true, 'but is sent to their administrator, not to a console they cannot open');
  check(far.body.explanation?.includes('localhost') === false, 'and never to a localhost URL that is not theirs', far.body.explanation);
}

async function secondGatewayRefusesTheTakenPort(): Promise<void> {
  console.log('\na gateway will not start on a port another Warden holds\n');

  // A stand-in for the other installation: it only has to answer `/health` the
  // way a Warden does, which is exactly what the starting gateway asks it.
  const holder = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, installation: { label: 'the-other-warden', version: '9.9.9', dataDir: '/somewhere/else/data' } }));
  });
  holder.listen(0, '127.0.0.1');
  await new Promise((done) => holder.once('listening', done));
  const port = (holder.address() as AddressInfo).port;

  try {
    // Spawned asynchronously, not with `spawnSync`: the stand-in above lives in
    // this process, and a synchronous wait would block the event loop that has
    // to answer the child's `/health` — leaving it to report that something
    // which is not Warden holds the port, which is the case this is not testing.
    const started = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
      env: isolated({ WARDEN_PORT: String(port), WARDEN_HOST: '127.0.0.1' })
    });
    let said = '';
    started.stdout.on('data', (chunk) => { said += chunk; });
    started.stderr.on('data', (chunk) => { said += chunk; });
    const timer = setTimeout(() => started.kill('SIGKILL'), 120_000);
    const status = await new Promise<number | null>((done) => started.once('close', (code) => { clearTimeout(timer); done(code); }));

    check(status !== 0, 'it exits non-zero instead of coming up half-started', `exit ${status}`);
    check(!said.includes('open the local or network URL'), 'and never prints the banner that says it came up');
    check(said.includes('the-other-warden'), 'it names the installation holding the port', said.slice(-400));
    check(said.includes('/somewhere/else/data'), 'and says where that one keeps its keys');
    check(said.includes('WARDEN_PORT'), 'and says how to start this one anyway');
  } finally {
    await new Promise((done) => holder.close(done));
  }
}

async function main(): Promise<void> {
  try {
    await healthSaysWhereItIs();
    await secondGatewayRefusesTheTakenPort();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} failed.\n` : '\nAll good.\n');
  process.exit(failures ? 1 : 0);
}

void main();
