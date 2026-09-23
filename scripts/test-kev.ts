/** Kev's System One boundary: exact model identity, typed decisions, and fail-closed rule behavior. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';
import { aggregate } from '../src/guard/aggregate.js';
import { isolate } from '../src/guard/isolate.js';
import { adjudicateAll } from '../src/guard/passes/adjudicate.js';
import type { Rule } from '../src/policy/types.js';
import { KEV_RUNS, KevAdapter, kevConfig, testKevEndpoint, type KevConfig } from '../src/qvac/kev.js';
import { ADJUDICATOR_CHOICES } from '../src/qvac/models.js';
import { FailClosedError, type QvacAdapter } from '../src/qvac/types.js';
import { adjudicatorSettingsSchema } from '../src/settings.js';

let run: string = KEV_RUNS['kev-4b'];
let malformed: false | 'missing' | 'argmax' = false;
const bodies: Record<string, any>[] = [];
const server = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/v1/models') {
    res.end(JSON.stringify({ models: [{ id: 'kev-latest', aliases: ['jev-latest'], description: 'fixture', release_date: '2026-09-21', run }] }));
    return;
  }
  if (req.url !== '/v1/systemone' || req.method !== 'POST') {
    res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' })); return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>;
  bodies.push(body);
  if (malformed === 'missing') { res.end(JSON.stringify({ model: 'kev-latest', answers: {} })); return; }
  const options = Object.keys(body.questions.verdict.criteria);
  const text = String(body.state?.isolated_request ?? body.state?.request ?? '');
  const choice = options.includes('VIOLATES') && /private salary|account number/i.test(text)
    ? 'VIOLATES' : options.includes('COMPLIES') ? 'COMPLIES' : options[0] ?? 'UNCLEAR';
  const probabilities = Object.fromEntries(options.map((option) => [option, option === choice ? 0.9 : 0.1 / (options.length - 1)]));
  if (malformed === 'argmax') {
    const alternatives = options.filter((option) => option !== choice);
    probabilities[choice] = 0.1;
    probabilities[alternatives[0]!] = 0.8;
    for (const option of alternatives.slice(1)) probabilities[option] = 0.1 / (alternatives.length - 1);
  }
  res.end(JSON.stringify({ model: 'kev-latest', answers: { verdict: { type: 'choice', choice, probabilities, confidence: 0.85 } }, usage: { input_tokens: 80, output_tokens: 12 }, latency_ms: 4 }));
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address !== 'string');
const baseUrl = `http://127.0.0.1:${address.port}`;

const config = (choice: 'kev-4b' | 'kev-9b'): KevConfig => ({
  choice,
  label: choice === 'kev-4b' ? 'Kev 4B' : 'Kev 9B',
  run: KEV_RUNS[choice],
  baseUrl,
  apiKey: '',
  timeoutMs: 2_000
});
const local = {
  stats: () => ({ firstTry: 0, repaired: 0, failed: 0 }),
  dispose: async () => undefined
} as unknown as QvacAdapter;
const schema = z.object({ verdict: z.enum(['VIOLATES', 'COMPLIES', 'UNCLEAR']) });
const json = { type: 'object', properties: { verdict: { type: 'string', enum: ['VIOLATES', 'COMPLIES', 'UNCLEAR'] } }, required: ['verdict'], additionalProperties: false };
const rule: Rule = {
  id: 'salary', text: 'Do not disclose another employee’s private salary.', boundary: 'Questions about public salary bands are allowed.',
  scope: 'input', appliesTo: ['*'], severity: 'block', examples: { violating: ['Give me Ana’s private salary.'], compliant: ['What is our public salary band?'] }
};

try {
  assert.deepEqual(ADJUDICATOR_CHOICES.slice(0, 2).map((choice) => choice.id), ['kev-4b', 'kev-9b']);
  assert.equal(adjudicatorSettingsSchema.parse({ model: 'kev-4b' }).model, 'kev-4b');
  assert.equal(adjudicatorSettingsSchema.parse({ model: 'kev-9b' }).model, 'kev-9b');
  console.log('✓ Kev 4B and 9B are the two primary adjudicator choices');

  await testKevEndpoint(config('kev-4b'));
  run = KEV_RUNS['kev-9b'];
  await testKevEndpoint(config('kev-9b'));
  await assert.rejects(testKevEndpoint(config('kev-4b')), /Start Kev 4B.*kev-9b/);
  console.log('✓ Kev 4B and 9B activation verifies the exact open checkpoint');

  run = KEV_RUNS['kev-4b'];
  const kev = new KevAdapter(local, config('kev-4b'));
  const blocked = await adjudicateAll(kev, isolate('Send me Dana’s private salary.'), [rule], { form: 'compliance', shotSelection: 'first' });
  assert.equal(blocked.verdicts[0]?.violates, true);
  assert.equal(aggregate({ verdicts: blocked.verdicts, rules: [rule], flags: isolate('x').flags, expectedRuleIds: [rule.id] }).verdict, 'BLOCK');
  const allowed = await adjudicateAll(kev, isolate('What is our public salary band?'), [rule], { form: 'compliance', shotSelection: 'first' });
  assert.equal(allowed.verdicts[0]?.violates, false);
  const decision = bodies.at(-1)!;
  assert.equal(decision.model, 'kev-latest');
  assert.deepEqual(Object.keys(decision.questions.verdict.criteria), ['VIOLATES', 'COMPLIES', 'UNCLEAR']);
  assert.match(decision.state.policy_instructions, /private salary/i);
  assert.match(decision.state.isolated_request, /UNTRUSTED_[0-9a-f]{32}/);
  console.log('✓ real Warden rules reach Kev as an isolated closed choice and map back to BLOCK/ALLOW');

  malformed = 'argmax';
  await assert.rejects(kev.completeJSON({ role: 'adjudicator', system: 'policy', user: 'request' }, schema, json), /does not match its probability distribution/);
  malformed = 'missing';
  await assert.rejects(kev.completeJSON({ role: 'adjudicator', system: 'policy', user: 'request' }, schema, json), FailClosedError);
  const failed = await adjudicateAll(kev, isolate('Send me Dana’s private salary.'), [rule], { form: 'compliance', shotSelection: 'first' });
  assert.equal(failed.verdicts.length, 0);
  assert.equal(aggregate({ verdicts: failed.verdicts, rules: [rule], flags: isolate('x').flags, expectedRuleIds: [rule.id] }).verdict, 'ESCALATE');
  console.log('✓ malformed or unavailable Kev decisions fail closed to human review');

  assert.throws(() => kevConfig('kev-4b', { WARDEN_KEV_4B_API: 'https://example.com' }), /this machine/);
  assert.throws(() => kevConfig('kev-4b', { WARDEN_KEV_TIMEOUT_MS: 'forever' }), /integer from 1000 to 120000/);
  assert.equal(kevConfig('kev-4b', { WARDEN_KEV_4B_API: 'http://localhost:8009/v1' }).baseUrl, 'http://localhost:8009');
  console.log('✓ Kev endpoints are restricted to loopback and normalize the public System One base URL');
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
