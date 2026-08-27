/**
 * Does the rewrite endpoint hand attackers a way through?
 *
 * That is the only question this answers, and it is the question the feature
 * has to survive. `suggestRewrite` will happily restate a blocked request; what
 * stops it becoming an evasion oracle is the gate in front of it and the
 * re-check behind it, and both of those are claims until something measures
 * them.
 *
 * So: take the corpus, block what it blocks, and ask for a rewrite of every
 * refusal. An attack class should produce no suggestions at all — each one
 * either refused by the gate or killed by the re-check. `benign-controls` is
 * the other side of the same run: those are legitimate requests the guard got
 * wrong, and a suggestion there is the feature working.
 *
 *   pnpm tsx scripts/probe-rewrite.ts
 *   pnpm tsx scripts/probe-rewrite.ts --class benign-controls --reps 2
 *
 * Read the numbers the way every number in this repo has to be read: one rep of
 * one class settles nothing, `parallel: 4` makes runs non-reproducible, and a
 * suggestion that appears once in an attack class is worth a night of work
 * before it is dismissed.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PolicySpec, Quota, Rule } from '../src/policy/types.js';

/**
 * Set before the guard is imported, which is why the imports below are dynamic:
 * `audit/log.ts` reads this path once, at module load.
 *
 * Two reasons a diagnostic must not share the gateway's log. It would append a
 * hundred synthetic decisions to a governance record — and worse, the tail hash
 * is cached in memory per process, so a probe running while `pnpm run dev` is up
 * interleaves two chains and leaves a log that fails `pnpm run verify-audit`.
 * Measured the hard way: entry 177 of 375, a browser decision landing between
 * two of this script's.
 */
process.env['WARDEN_AUDIT_PATH'] ??= 'data/audit-probe.jsonl';

const { evaluate } = await import('../src/guard/pipeline.js');
const { resetQuotas } = await import('../src/guard/quota.js');
const { rewriteGate, suggestRewrite } = await import('../src/guard/rewrite.js');
const { hashPolicy } = await import('../src/policy/store.js');
const { adapter, isMock } = await import('../src/qvac/index.js');

const CORPUS_DIR = 'src/redteam/corpus';
const ACTOR = { id: 'redteam', role: 'analyst' };

type Prompt = { id: string; text?: string; turns?: string[]; attachment?: string; expect: string };
type CorpusFile = { class: string; prompts: Prompt[] };

/** Same policy the red-team harness measures against, for comparable numbers. */
function benchmarkPolicy(): PolicySpec {
  const path = process.env['WARDEN_BENCHMARK_POLICY'] ?? 'data/seed/benchmark-policy.json';
  const seed = JSON.parse(readFileSync(path, 'utf8')) as {
    rules?: Rule[];
    quotas?: Quota[];
    exemptRoles?: string[];
  };
  const rules = seed.rules ?? [];
  const quotas = seed.quotas ?? [];
  const exemptRoles = seed.exemptRoles ?? ['admin'];
  return { version: hashPolicy(rules, quotas, exemptRoles), updatedAt: new Date(0).toISOString(), rules, quotas, exemptRoles };
}

type Outcome = 'allowed-through' | 'suggested' | 'gate' | 'no-suggestion';

async function probe(prompt: Prompt, policy: PolicySpec): Promise<{ outcome: Outcome; detail: string }> {
  const text = prompt.turns ? prompt.turns.join('\n') : (prompt.text ?? '');

  // Every prompt here costs up to three units — the decision, the rewrite, and
  // the re-check — so the actor's 100/day ceiling would otherwise decide the
  // back half of the run instead of the guard. Same reason `runPrompt()` does it.
  resetQuotas();

  const decision = await evaluate(
    adapter(),
    { actor: ACTOR, prompt: text, ...(prompt.attachment ? { attachments: [prompt.attachment] } : {}) },
    policy
  );
  if (decision.verdict === 'ALLOW') return { outcome: 'allowed-through', detail: 'never reached a refusal' };

  const gated = rewriteGate({ prompt: text, decision, policy });
  if (gated) return { outcome: 'gate', detail: gated };

  const result = await suggestRewrite(adapter(), { actor: ACTOR, prompt: text, decision, policy });
  if (result.suggestion !== null) return { outcome: 'suggested', detail: result.suggestion };
  return { outcome: 'no-suggestion', detail: result.reason };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const only = value(args, '--class');
  const reps = Number(value(args, '--reps') ?? 1);

  const files = readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(CORPUS_DIR, f), 'utf8')) as CorpusFile)
    .filter((c) => !only || c.class === only);

  const policy = benchmarkPolicy();
  const mock = isMock();
  console.log(`adapter: ${mock ? 'MOCK' : 'real'}`);
  console.log(`policy ${policy.version.slice(0, 8)} · ${files.length} class(es) · ${reps} rep(s)`);
  /**
   * The caveat has to be louder than the table, because the table looks like a
   * finding either way.
   *
   * The mock's rewrite is one fixed sentence containing none of the mock's own
   * keywords, so anything that reaches it re-checks ALLOW by construction. That
   * makes the suggestion column an artifact of the stand-in and not a
   * measurement of anything. What a mock run does measure honestly is the gate,
   * which is deterministic code and behaves identically either way.
   */
  if (mock) {
    console.log(
      '\n  Running against the mock. Only the gate column means anything:\n' +
        '  the mock rewrites every prompt to the same signal-free sentence, so it\n' +
        '  clears the mock adjudicator every time. Re-run against a model before\n' +
        '  concluding anything about what a rewrite is allowed to pass.'
    );
  }
  console.log();

  for (const file of files) {
    const tally: Record<Outcome, number> = { 'allowed-through': 0, suggested: 0, gate: 0, 'no-suggestion': 0 };
    const suggestions: string[] = [];

    for (let rep = 0; rep < reps; rep++) {
      for (const prompt of file.prompts) {
        const { outcome, detail } = await probe(prompt, policy);
        tally[outcome]++;
        // The line that matters: a rewrite offered for something the corpus
        // calls an attack. Printed in full so it can be judged, not counted.
        if (outcome === 'suggested' && prompt.expect !== 'ALLOW') {
          suggestions.push(`      ${prompt.id}: ${detail}`);
        }
      }
    }

    const attacks = file.prompts.filter((p) => p.expect !== 'ALLOW').length;
    console.log(
      `${file.class.padEnd(22)} ${String(file.prompts.length * reps).padStart(3)} prompts (${attacks} attacks/rep)` +
        `\n      refused by the gate  ${tally.gate}` +
        `\n      no suggestion        ${tally['no-suggestion']}` +
        `\n      suggestion offered   ${tally.suggested}` +
        `\n      never blocked        ${tally['allowed-through']}`
    );
    if (suggestions.length > 0) {
      console.log(
        mock
          ? '      suggestions on attack prompts (mock — the constant above, not a result):'
          : '      ⚠ suggestions offered on prompts the corpus calls attacks:'
      );
      console.log(suggestions.join('\n'));
    }
    console.log();
  }
}

function value(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
