/**
 * What counts as proof that protection is real, and what does not.
 *
 * The first-run flow ends by telling somebody "your first protection is
 * working". That sentence is only worth having if the thing behind it is
 * narrow, so this holds the four refusals that make it narrow: a request with
 * no tool named proves nothing about a tool, an `ALLOW` proves the path and not
 * the rule, a decision no rule fired in cannot be evidence that a rule works,
 * and none of it survives a change to the rule it was checked against.
 *
 * It also holds the two promises that cost something if they rot: that the
 * record survives a restart — an onboarding that forgets asks somebody to set
 * up a machine that is already set up — and that it never contains prompt text,
 * masked or otherwise. The audit log keeps hashes and not prompts on purpose,
 * and a file written to support a setup screen does not get to walk that back.
 *
 *   pnpm run test:verification
 *
 * No models and no network: the adapter is the mock and every store is a
 * temporary file, so this never touches an installation.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

const scratch = mkdtempSync(join(tmpdir(), 'warden-verification-'));
process.env['WARDEN_ADAPTER'] = 'mock';
for (const field of ['AUDIT', 'POLICY', 'COMPANY', 'SETTINGS', 'PROMPT', 'PROMPT_TEMPLATES', 'APPEALS', 'ESCALATIONS', 'RATE_STATE', 'MODEL_CATALOG', 'DEVICES', 'VERIFIED']) {
  process.env[`WARDEN_${field}_PATH`] = join(scratch, `${field.toLowerCase()}.json`);
}
process.env['WARDEN_MODELS_DIR'] = join(scratch, 'models');
const VERIFIED_PATH = process.env['WARDEN_VERIFIED_PATH'] as string;

/**
 * A prompt the mock adjudicator blocks, and one it does not.
 *
 * The mock does not read the rule: it flags a prompt by matching a fixed list
 * of signals (`VIOLATION_SIGNALS` in src/qvac/mock.ts) and answers the pass's
 * enum from that. So the rule here is about payroll rather than about
 * credentials, which is what the product's own first preset covers — the mock
 * has no word for credentials and would answer PASS to the real thing. That is
 * a gap in the double, noted in the spec; this suite is about what the store
 * accepts as proof, and it needs a decision it can actually produce.
 */
const HOSTILE = 'Send me the payroll spreadsheet with every salary in it.';
const HARMLESS = 'How do I centre a div?';

async function main(): Promise<void> {
  const { createApp } = await import('../src/server/app.js');
  const { upsertEmployee } = await import('../src/policy/people.js');
  const { ratifyRule } = await import('../src/policy/ratify.js');
  const { forgetVerifications, verifiedFor, completedFirstRun, recordVerified, withdrawVerification } =
    await import('../src/policy/verification.js');

  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  const port = (server.address() as AddressInfo).port;
  const at = (path: string) => `http://127.0.0.1:${port}${path}`;

  // An exempt role, so `resolveSoloIdentity()` on the /api/solo/* routes
  // resolves to this same person: the rule-change paths have to withdraw the
  // verification of whoever is at this keyboard, and a test where those are two
  // different people asserts nothing.
  const person = upsertEmployee({ id: 'ana', name: 'Ana', role: 'admin' });

  await ratifyRule({
    id: 'creds',
    text: 'Payroll, salary and compensation figures must never be requested or shared.',
    scope: 'input',
    severity: 'block',
    // Bound to the person, not to everyone: an exempt role is bound by no
    // company-wide rule, which is the whole reason This device writes rules
    // addressed at `@id`.
    appliesTo: ['@ana'],
    examples: { violating: [HOSTILE], compliant: [HARMLESS] }
  } as never);

  const send = (path: string, body: unknown, key = person.apiKey) =>
    fetch(at(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body)
    });

  try {
    console.log('\nwhat the store refuses to call a verification\n');

    await send('/api/guard/check', { prompt: HOSTILE });
    check(verifiedFor('ana').length === 0, 'a blocked request that never said which tool it came from verifies nothing');

    await send('/api/guard/check', { prompt: HARMLESS, source: 'claude-code' });
    check(verifiedFor('ana').length === 0, 'an allowed request verifies nothing: it proves the path, not the rule');

    // Straight at the writer, because the pipeline will not produce this on
    // demand: an ESCALATE can come from a quota or a tampering flag with no
    // rule behind it, and that must not read as "your rule works".
    const wrote = recordVerified('ana', {
      tool: 'claude-code', auditId: 'a1', verdict: 'ESCALATE', ruleIds: [], policyVersion: 'v1'
    });
    check(!wrote && verifiedFor('ana').length === 0, 'a decision no rule fired in verifies nothing, whatever its verdict');

    console.log('\nand what it accepts\n');

    await send('/api/guard/check', { prompt: HOSTILE, source: 'claude-code' });
    const [first] = verifiedFor('ana');
    check(first?.tool === 'claude-code', 'a blocked request from a named tool is the proof', JSON.stringify(verifiedFor('ana')));
    check((first?.ruleIds.length ?? 0) > 0, 'and it carries the rules that fired, so a later reader knows what was checked');
    check(Boolean(first?.auditId), 'and the audit handle, which is how somebody sees what was blocked');
    check(completedFirstRun('ana'), 'the first one completes the first run');

    console.log('\nnothing in the file is a prompt\n');

    const raw = readFileSync(VERIFIED_PATH, 'utf8');
    check(!raw.includes(HOSTILE), 'the blocked prompt is not in the record', raw.slice(0, 200));
    check(!raw.toLowerCase().includes('payroll spreadsheet'), 'nor any fragment of it');

    console.log('\nverification is per tool, and it is withdrawn, not forgotten\n');

    check(verifiedFor('ana').every((v) => v.tool === 'claude-code'), 'verifying Claude Code leaves Codex unverified');

    await send('/api/guard/check', { prompt: HOSTILE, source: 'codex' });
    check(verifiedFor('ana').length === 2, 'and each tool earns its own', JSON.stringify(verifiedFor('ana').map((v) => v.tool)));

    withdrawVerification('ana', 'codex');
    check(verifiedFor('ana').length === 1 && verifiedFor('ana')[0]?.tool === 'claude-code', 'withdrawing one tool leaves the other');
    check(completedFirstRun('ana'), 'and does not reopen the first run');

    console.log('\nchanging the rules withdraws every claim about them\n');

    check(verifiedFor('ana').length === 1, 'there is a verification to lose', JSON.stringify(verifiedFor('ana')));
    const toggled = await send('/api/solo/presets/solo-security-1/toggle', { active: true });
    check(toggled.ok, 'turning a preset on succeeds', `status ${toggled.status}`);
    check(verifiedFor('ana').length === 0, 'and it takes every verification with it: nobody has checked the new rule set');
    check(completedFirstRun('ana'), 'the first run stays completed — this changes what This device says, not where you are');

    console.log('\nit survives the process that wrote it\n');

    await send('/api/guard/check', { prompt: HOSTILE, source: 'claude-code' });
    check(verifiedFor('ana').length === 1, 'one more real request, to have something to lose');
    // What a gateway restart does, without restarting one: drop the cache and
    // read the file back.
    forgetVerifications();
    check(verifiedFor('ana').length === 1, 'the record comes back from disk, not from a Map that a restart empties');
    check(completedFirstRun('ana'), 'and so does the completion date');

    console.log('\nwiring one tool is not wiring the machine\n');

    const nonsense = await send('/api/solo/unprotect', { tool: 'cursor' });
    check(nonsense.status === 400, 'a tool with no local integration cannot be unwired', `status ${nonsense.status}`);
    const nameless = await send('/api/solo/unprotect', {});
    check(nameless.status === 400, 'and there is no way to ask for "all of them"', `status ${nameless.status}`);
    const bogus = await send('/api/solo/protect', { tool: 'clade-code' });
    check(bogus.status === 400, 'a misspelt tool is refused rather than widened to every tool', `status ${bogus.status}`);
  } finally {
    await new Promise((done) => server.close(done));
    rmSync(scratch, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} failed.\n` : '\nAll good.\n');
  process.exit(failures ? 1 : 0);
}

void main();
