/**
 * The two facts about a machine, and the line between them.
 *
 * **Traffic** the gateway sees for itself: a check that arrived is proof, and
 * nothing can fake its absence. **Wiring** only the machine knows, because the
 * gateway cannot read an employee's home directory, so it is reported and never
 * inferred. A console that collapsed the two would have to guess which it was
 * looking at, and "not wired" is somebody's afternoon spent fixing what was
 * never broken — so this asserts that a check never writes wiring, and that a
 * machine which has not reported leaves it absent rather than false.
 *
 * It also holds the two promises that cost something if they rot: that a key
 * rotation marks every one of that person's machines and that only a check with
 * the new key clears the mark, and that the hostname — which is personal data,
 * because it usually carries somebody's name — never reaches the audit log.
 *
 *   pnpm run test:devices
 *
 * No models and no network: the adapter is the mock and every store is a
 * temporary file, so this never touches an installation.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  if (ok) console.log(`  ok   ${what}`);
  else {
    failures++;
    console.log(`  FAIL ${what}${detail ? ` — ${detail}` : ''}`);
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'warden-devices-'));
process.env['WARDEN_ADAPTER'] = 'mock';
for (const field of ['AUDIT', 'POLICY', 'COMPANY', 'SETTINGS', 'PROMPT', 'PROMPT_TEMPLATES', 'APPEALS', 'ESCALATIONS', 'RATE_STATE', 'MODEL_CATALOG', 'DEVICES']) {
  process.env[`WARDEN_${field}_PATH`] = join(scratch, `${field.toLowerCase()}.json`);
}
process.env['WARDEN_MODELS_DIR'] = join(scratch, 'models');
const AUDIT_PATH = process.env['WARDEN_AUDIT_PATH'] as string;

/** A machine id has to look like the salted hash the hook makes: 16 hex. */
const LAPTOP = 'a1b2c3d4e5f60718';
const DESKTOP = '00112233445566ff';
/** A hostname with somebody's name in it, which is the whole reason it is guarded. */
const LAPTOP_NAME = 'ana-macbook-pro';

type Device = { machineId: string; name: string; firstSeen: string; lastSeen: string; tools?: unknown[]; pendingSince?: string };

async function main(): Promise<void> {
  const { createApp } = await import('../src/server/app.js');
  const { upsertEmployee, rotateApiKey } = await import('../src/policy/people.js');
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  const port = (server.address() as AddressInfo).port;
  const at = (path: string) => `http://127.0.0.1:${port}${path}`;

  let person = upsertEmployee({ id: 'ana', name: 'Ana', role: 'employee' });

  const send = (path: string, key: string, body: unknown) =>
    fetch(at(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body)
    });

  const devices = async (): Promise<Device[]> => {
    const listed = (await (await fetch(at('/api/people'))).json()) as { employees: { id: string; devices: Device[] }[] };
    return listed.employees.find((e) => e.id === 'ana')?.devices ?? [];
  };

  try {
    console.log('\na check is traffic, and traffic is not wiring\n');

    await send('/api/guard/check', person.apiKey, { prompt: 'hello', source: 'claude-code', machine: { id: LAPTOP, name: LAPTOP_NAME } });
    let seen = await devices();
    check(seen.length === 1 && seen[0]?.machineId === LAPTOP, 'a check from a machine puts it on the inventory', JSON.stringify(seen));
    check(seen[0]?.name === LAPTOP_NAME, 'under the name the machine gave, so an administrator knows which one it is');
    check(seen[0]?.tools === undefined, 'and says nothing about what is wired, because a request is not evidence about the other three tools');
    const firstSeen = seen[0]?.firstSeen;

    await send('/api/guard/check', person.apiKey, { prompt: 'again', source: 'claude-code', machine: { id: LAPTOP, name: LAPTOP_NAME } });
    seen = await devices();
    check(seen[0]?.firstSeen === firstSeen, 'a second check keeps the date this machine first appeared');
    check((seen[0]?.lastSeen ?? '') >= (firstSeen ?? ''), 'and moves the date it was last heard from');

    // The id is a map key an administrator reads grouped under a person's name.
    // A machine that could choose an arbitrary one could make that unreadable.
    await send('/api/guard/check', person.apiKey, { prompt: 'x', source: 'claude-code', machine: { id: '../../etc/passwd', name: 'x' } });
    check((await devices()).length === 1, 'a machine id that is not 16 hex characters is dropped, not stored');

    console.log('\nwiring is reported, and only about the reporter\n');

    // The console's stream, held open across the reports below. Only decisions
    // used to travel on it, so a report reached the disk and nobody watching.
    const heard: Record<string, unknown>[] = [];
    const stream = new AbortController();
    const listening = fetch(at('/api/events'), { signal: stream.signal }).then(async (res) => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const data = frame.split('\n').find((line) => line.startsWith('data: '));
          if (!data || frame.startsWith('event: hello')) continue;
          heard.push(JSON.parse(data.slice(6)) as Record<string, unknown>);
        }
      }
    }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 150));

    const reported = await send('/api/devices/report', person.apiKey, {
      machine: { id: LAPTOP, name: LAPTOP_NAME },
      tools: [{ id: 'claude-code', wired: true }, { id: 'codex', wired: false, how: 'add [[hooks.UserPromptSubmit]]' }],
      hookVersion: 'abc123def456'
    });
    check(reported.ok, 'a report from an employee key is accepted', `status ${reported.status}`);
    seen = await devices();
    check(Array.isArray(seen[0]?.tools) && seen[0]?.tools?.length === 2, 'and lands on that machine', JSON.stringify(seen[0]?.tools));

    const bad = await send('/api/devices/report', person.apiKey, { machine: { id: LAPTOP, name: 'x' }, tools: 'everything' });
    check(bad.status === 400, 'a report whose tools are not a list is refused', `status ${bad.status}`);

    const stranger = await send('/api/devices/report', 'wk-nobody-0000000000000000', { machine: { id: DESKTOP, name: 'theirs' }, tools: [] });
    check(stranger.status === 401, 'a key this gateway never issued cannot report at all', `status ${stranger.status}`);
    check(!(await devices()).some((d) => d.machineId === DESKTOP), 'and nothing of theirs appears under somebody else');

    await new Promise((r) => setTimeout(r, 150));
    stream.abort();
    await listening;
    const rings = heard.filter((e) => e['type'] === 'device');
    check(rings.length === 1, 'the accepted report rings the console once, and the two refused ones not at all', JSON.stringify(heard));
    check(rings[0]?.['employeeId'] === 'ana', 'saying whose machine it was');
    check(Object.keys(rings[0] ?? {}).sort().join() === 'employeeId,type', 'and nothing about the machine: no name, no tools, no hook version', JSON.stringify(rings[0]));

    console.log('\na rotated key marks every machine until it reconnects\n');

    await send('/api/guard/check', person.apiKey, { prompt: 'hi', source: 'codex', machine: { id: DESKTOP, name: 'ana-desktop' } });
    check((await devices()).length === 2, 'Ana now has two machines');

    const rotated = rotateApiKey('ana');
    if (!rotated) throw new Error('rotation returned nothing');
    seen = await devices();
    check(seen.every((d) => typeof d.pendingSince === 'string'), 'rotating the key marks both of them as waiting to reconnect', JSON.stringify(seen.map((d) => d.pendingSince)));
    const markedAt = seen.find((d) => d.machineId === LAPTOP)?.pendingSince;

    const stale = await send('/api/guard/check', person.apiKey, { prompt: 'still here', source: 'claude-code', machine: { id: LAPTOP, name: LAPTOP_NAME } });
    check(stale.status === 401, 'the old key stops working immediately — there is no grace period');
    check(typeof (await devices()).find((d) => d.machineId === LAPTOP)?.pendingSince === 'string', 'so it does not clear the mark either');

    await send('/api/guard/check', rotated.apiKey, { prompt: 'picked it up', source: 'claude-code', machine: { id: LAPTOP, name: LAPTOP_NAME } });
    seen = await devices();
    check(seen.find((d) => d.machineId === LAPTOP)?.pendingSince === undefined, 'one check with the new key clears that machine');
    check(typeof seen.find((d) => d.machineId === DESKTOP)?.pendingSince === 'string', 'and only that machine — the other is still waiting');

    person = rotated;
    const rotatedAgain = rotateApiKey('ana');
    check(
      (await devices()).find((d) => d.machineId === DESKTOP)?.pendingSince === markedAt,
      'a second rotation keeps the date a machine has been pending since, because "since Tuesday" is the useful sentence'
    );
    if (rotatedAgain) person = rotatedAgain;

    console.log('\nthe hostname is inventory, never the record\n');

    await send('/api/guard/check', person.apiKey, { prompt: 'one more', source: 'claude-code', machine: { id: LAPTOP, name: LAPTOP_NAME } });
    const audit = existsSync(AUDIT_PATH) ? readFileSync(AUDIT_PATH, 'utf8') : '';
    check(audit.length > 0, 'there are decisions in the audit log to sweep', `${audit.length} bytes`);
    // The log keeps prompt hashes and not prompts so that the governance record
    // is not the largest exposure in the system. A hostname column walks that
    // back — `ana-macbook-pro` is a name.
    check(!audit.includes(LAPTOP_NAME), 'and not one of them carries the machine name');
    check(!audit.includes('ana-desktop'), 'nor the other machine name');
    check(!audit.includes(LAPTOP), 'nor, today, the machine id — nothing needs it there yet');

    const stored = JSON.parse(readFileSync(process.env['WARDEN_DEVICES_PATH'] as string, 'utf8')) as Record<string, unknown>;
    check(Object.keys(stored).length === 1 && 'ana' in stored, 'the inventory is keyed by person', JSON.stringify(Object.keys(stored)));
  } finally {
    await new Promise((done) => server.close(done));
    rmSync(scratch, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} failed.\n` : '\nAll good.\n');
  process.exit(failures ? 1 : 0);
}

void main();
