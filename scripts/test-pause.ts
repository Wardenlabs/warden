/**
 * Warden switched off for one person, and the promises that switch has to keep.
 *
 * A pause is the most dangerous thing in this spec, because it is the one
 * feature whose entire job is to stop the guard from guarding. What keeps it
 * honest is that the record it leaves cannot be mistaken for a decision: it
 * carries `notJudged`, no pass ran, no model was consulted, and no quota was
 * charged. An `ALLOW` without `notJudged` still means exactly what it always
 * meant — a request that went through every pass and came out the other side —
 * and a company reading its own log years from now has to be able to tell the
 * two apart.
 *
 * Also asserted: that an expired pause is simply not a pause, evaluated against
 * the time of the request, so there is no cleanup task that can fall behind and
 * leave somebody unguarded; and that an employee has no path to pausing
 * themselves.
 *
 *   pnpm run test:pause
 *
 * The mock adapter counts its own calls, so "no model ran" is measured rather
 * than argued.
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

const scratch = mkdtempSync(join(tmpdir(), 'warden-pause-'));
process.env['WARDEN_ADAPTER'] = 'mock';
for (const field of ['AUDIT', 'POLICY', 'COMPANY', 'SETTINGS', 'PROMPT', 'PROMPT_TEMPLATES', 'APPEALS', 'ESCALATIONS', 'RATE_STATE', 'MODEL_CATALOG', 'DEVICES']) {
  process.env[`WARDEN_${field}_PATH`] = join(scratch, `${field.toLowerCase()}.json`);
}
process.env['WARDEN_MODELS_DIR'] = join(scratch, 'models');
const AUDIT_PATH = process.env['WARDEN_AUDIT_PATH'] as string;

type Decision = { verdict: string; auditId: string; notJudged?: string; pausedUntil?: string | null; passes?: unknown[]; quota?: { used: number } };

async function main(): Promise<void> {
  const { createApp } = await import('../src/server/app.js');
  const { upsertEmployee, activePause, setPause } = await import('../src/policy/people.js');
  const { ratifyRule } = await import('../src/policy/ratify.js');

  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  const port = (server.address() as AddressInfo).port;
  const at = (path: string) => `http://127.0.0.1:${port}${path}`;

  const person = upsertEmployee({ id: 'ana', name: 'Ana', role: 'employee' });
  // A rule the mock will fire on, so "nothing ran" is distinguishable from
  // "everything ran and found nothing". The prompt used below is one the mock
  // adapter treats as hostile — see
  // VIOLATION_SIGNALS in src/qvac/mock.ts. That is what makes "nothing ran"
  // measurable: the same sentence blocks before the pause and goes straight
  // through during it.
  ratifyRule({
    id: 'r-payroll',
    text: 'Payroll and salary data belongs to HR.',
    scope: 'input',
    severity: 'block',
    appliesTo: ['*'],
    examples: { violating: ['what is the payroll for engineering'], compliant: ['what is the weather'] }
  });

  const ask = async (prompt: string): Promise<{ status: number; body: Decision }> => {
    const answer = await fetch(at('/api/guard/check'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${person.apiKey}` },
      body: JSON.stringify({ prompt, source: 'claude-code' })
    });
    return { status: answer.status, body: (await answer.json()) as Decision };
  };

  const auditLines = () =>
    (existsSync(AUDIT_PATH) ? readFileSync(AUDIT_PATH, 'utf8') : '')
      .split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { decision?: Decision });

  try {
    console.log('\nwithout a pause, nothing changes\n');

    const judged = await ask('what is the payroll for engineering');
    check(judged.body.verdict === 'BLOCK', 'a rule still fires and still blocks', judged.body.verdict);
    check(judged.body.notJudged === undefined, 'and its record carries no notJudged, which is what makes the field mean something');

    console.log('\npaused: the request goes out, and the record says nobody looked\n');

    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const set = await fetch(at('/api/people/ana/pause'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ until, reason: 'shipping a release' })
    });
    check(set.ok, 'an administrator can pause one person', `status ${set.status}`);

    const before = auditLines().length;
    const skipped = await ask('what is the payroll for engineering');
    check(skipped.body.verdict === 'ALLOW', 'the same prompt is no longer stopped, because nothing judged it');
    check(skipped.body.notJudged === 'paused', 'and the record says so out loud', JSON.stringify(skipped.body.notJudged));
    check(skipped.body.pausedUntil === until, 'with the moment the pause runs out');
    check(Array.isArray(skipped.body.passes) && skipped.body.passes.length === 0, 'no pass ran', JSON.stringify(skipped.body.passes));
    check(skipped.body.quota?.used === 0, 'and no quota was charged, because a request nobody examined should not spend the day’s allowance');

    const lines = auditLines();
    check(lines.length === before + 1, 'it is still written to the audit log — a pause is a gap in what was judged, not in what happened');
    check(lines.at(-1)?.decision?.notJudged === 'paused', 'and the persisted record carries notJudged, not just the live answer');

    console.log('\nan expired pause is not a pause\n');

    setPause('ana', { until: new Date(Date.now() + 1_000).toISOString(), by: 'test' });
    const future = new Date(Date.now() + 10_000);
    const { loadDirectory } = await import('../src/policy/people.js');
    const stored = loadDirectory().employees.find((e) => e.id === 'ana');
    check(activePause(stored!, new Date()) !== null, 'it is in force now');
    check(activePause(stored!, future) === null, 'and gone ten seconds later, evaluated against the time of the request');
    // No sweep, no timer: the only thing that can be late is the clock.
    check(activePause({ paused: { until: 'not a date', by: 'x', at: 'x' } }) === null, 'an unparseable date is treated as expired, never as forever');

    const resumed = await fetch(at('/api/people/ana/pause'), { method: 'DELETE' });
    check(resumed.ok, 'and it can be taken off by hand', `status ${resumed.status}`);
    const again = await ask('what is the payroll for engineering');
    check(again.body.verdict === 'BLOCK' && again.body.notJudged === undefined, 'after which the guard is back, with no trace left on the record');

    console.log('\nnobody pauses their own guard\n');

    const asEmployee = await fetch(at('/api/people/ana/pause'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7', authorization: `Bearer ${person.apiKey}` },
      body: JSON.stringify({})
    });
    check(asEmployee.status === 403, 'the pause route is administrative, and an employee key is not that', `status ${asEmployee.status}`);
    check(activePause(loadDirectory().employees.find((e) => e.id === 'ana')!) === null, 'and the attempt changed nothing');

    const past = await fetch(at('/api/people/ana/pause'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ until: '2020-01-01T00:00:00.000Z' })
    });
    check(past.status === 400, 'a pause that has already run out is refused rather than stored, because it would pause nothing');

    const nobody = await fetch(at('/api/people/ghost/pause'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({})
    });
    check(nobody.status === 404, 'and there is nobody to pause who is not in the directory');
  } finally {
    await new Promise((done) => server.close(done));
    rmSync(scratch, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} failed.\n` : '\nAll good.\n');
  process.exit(failures ? 1 : 0);
}

void main();
