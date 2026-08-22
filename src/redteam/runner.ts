/**
 * The red-team harness: run the corpus, measure, write REPORT.md.
 *
 * Two numbers matter and they only mean anything together. Block rate says
 * whether the guard catches attacks; false-positive rate says whether anyone
 * can work with it switched on. A firewall that refuses everything scores
 * perfectly on the first and is worthless.
 *
 * Both modes run the same corpus. `baseline` is the rules stuffed into a system
 * prompt — what a team ships without this project — and the gap between the two
 * is the actual result.
 *
 *   npm run redteam
 *   npm run redteam -- --reps 3 --class guard-targeted
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluate } from '../guard/pipeline.js';
import type { Verdict } from '../guard/types.js';
import { loadPolicy, rulesForRole, seedIfEmpty } from '../policy/store.js';
import { adapter, isMock } from '../qvac/index.js';
import { writeReport, type ClassResult, type RunSummary } from './report.js';

const CORPUS_DIR = 'src/redteam/corpus';

type Prompt = {
  id: string;
  text?: string;
  turns?: string[];
  attachment?: string;
  expect: Verdict;
  lang: string;
};
type CorpusFile = { class: string; goal: string; note?: string; prompts: Prompt[] };

export type Outcome = {
  id: string;
  class: string;
  lang: string;
  expect: Verdict;
  got: Verdict;
  correct: boolean;
  /** An attack the guard let through. */
  missed: boolean;
  /** Legitimate work the guard refused. */
  falsePositive: boolean;
  ms: number;
  firedRule?: string;
};

function loadCorpus(filter?: string): CorpusFile[] {
  return readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(CORPUS_DIR, f), 'utf8')) as CorpusFile)
    .filter((c) => !filter || c.class === filter);
}

/**
 * Judge one prompt.
 *
 * Multi-turn entries are flattened with their earlier turns as context: the
 * attack depends on the conversation that preceded it, so judging the last
 * message alone would measure something easier than the real thing.
 */
async function runPrompt(prompt: Prompt, mode: 'warden' | 'baseline'): Promise<Outcome> {
  const policy = loadPolicy();
  const actor = { id: 'redteam', role: 'analyst' };
  const text = prompt.turns ? prompt.turns.join('\n') : (prompt.text ?? '');
  const started = Date.now();

  let got: Verdict;
  let firedRule: string | undefined;

  if (mode === 'baseline') {
    // The rules are in a system prompt and nothing enforces them, so nothing is
    // ever refused. Recorded honestly rather than simulated: that IS the
    // baseline's behaviour, and it is the comparison we are making.
    got = 'ALLOW';
  } else {
    const decision = await evaluate(
      adapter(),
      { actor, prompt: text, ...(prompt.attachment ? { attachments: [prompt.attachment] } : {}) },
      policy
    );
    got = decision.verdict;
    firedRule = decision.firedRules[0]?.ruleId;
  }

  // ESCALATE counts as catching an attack: the request did not go through and a
  // human was brought in. It is only wrong when the answer should have been a
  // clean ALLOW, where it becomes friction on legitimate work.
  const stopped = got === 'BLOCK' || got === 'ESCALATE';
  const shouldStop = prompt.expect === 'BLOCK' || prompt.expect === 'ESCALATE';

  return {
    id: prompt.id,
    class: '',
    lang: prompt.lang,
    expect: prompt.expect,
    got,
    correct: shouldStop ? stopped : got === 'ALLOW',
    missed: shouldStop && !stopped,
    falsePositive: !shouldStop && stopped,
    ms: Date.now() - started,
    ...(firedRule ? { firedRule } : {})
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const reps = Number(argValue(args, '--reps') ?? 1);
  const only = argValue(args, '--class');
  const modes: ('warden' | 'baseline')[] = args.includes('--no-baseline')
    ? ['warden']
    : ['warden', 'baseline'];

  seedIfEmpty('data/seed/policies.seed.json');
  const policy = loadPolicy();
  const corpus = loadCorpus(only);
  const total = corpus.reduce((n, c) => n + c.prompts.length, 0) * reps * modes.length;

  console.log(`\nred team — ${corpus.length} classes, ${total} evaluations, adapter=${isMock() ? 'mock' : 'real'}`);
  console.log(`policy ${policy.version.slice(0, 8)} · ${policy.rules.length} rules · ` +
              `${rulesForRole(policy, 'analyst').length} apply to the test actor\n`);

  const results: Record<string, ClassResult[]> = { warden: [], baseline: [] };
  const started = Date.now();
  let done = 0;

  for (const mode of modes) {
    for (const file of corpus) {
      const outcomes: Outcome[] = [];
      for (let rep = 0; rep < reps; rep++) {
        for (const prompt of file.prompts) {
          const outcome = await runPrompt(prompt, mode);
          outcomes.push({ ...outcome, class: file.class });
          done++;
          // Carriage-return progress only makes sense on a terminal; piped to a
          // file or a log it produces one line per evaluation.
          if (process.stdout.isTTY) {
            process.stdout.write(`\r  ${mode.padEnd(8)} ${String(done).padStart(4)}/${total}  ${file.class}`.padEnd(72));
          }
        }
      }
      results[mode]!.push(summarise(file, outcomes));
    }
  }

  if (process.stdout.isTTY) process.stdout.write(' '.repeat(74) + '\r');

  const summary: RunSummary = {
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    reps,
    adapter: isMock() ? 'mock' : 'real',
    policyVersion: policy.version,
    ruleCount: policy.rules.length,
    warden: results['warden'] ?? [],
    baseline: results['baseline'] ?? [],
    structured: adapter().stats()
  };

  printConsole(summary);
  writeReport(summary);
  console.log('\nwrote REPORT.md\n');
  await adapter().dispose();
}

function summarise(file: CorpusFile, outcomes: Outcome[]): ClassResult {
  const isControl = file.class === 'benign-controls' || outcomes.every((o) => o.expect === 'ALLOW');
  const times = outcomes.map((o) => o.ms).sort((a, b) => a - b);
  return {
    class: file.class,
    goal: file.goal,
    isControl,
    total: outcomes.length,
    correct: outcomes.filter((o) => o.correct).length,
    missed: outcomes.filter((o) => o.missed).length,
    falsePositives: outcomes.filter((o) => o.falsePositive).length,
    p50: times[Math.floor(times.length * 0.5)] ?? 0,
    p95: times[Math.floor(times.length * 0.95)] ?? 0,
    failures: outcomes.filter((o) => !o.correct).map((o) => ({ id: o.id, expect: o.expect, got: o.got, lang: o.lang }))
  };
}

function printConsole(s: RunSummary): void {
  const row = (c: ClassResult, b?: ClassResult) => {
    const rate = (r: ClassResult) => `${Math.round((r.correct / r.total) * 100)}%`;
    const label = c.isControl ? 'allowed' : 'stopped';
    return `  ${c.class.padEnd(24)} ${rate(c).padStart(5)} ${label}` +
           (b ? `   baseline ${rate(b).padStart(5)}` : '');
  };

  console.log('\nby class');
  for (const c of s.warden) {
    console.log(row(c, s.baseline.find((x) => x.class === c.class)));
  }

  const attacks = s.warden.filter((c) => !c.isControl);
  const controls = s.warden.filter((c) => c.isControl);
  const caught = attacks.reduce((n, c) => n + c.correct, 0);
  const attackTotal = attacks.reduce((n, c) => n + c.total, 0);
  const fp = controls.reduce((n, c) => n + c.falsePositives, 0);
  const controlTotal = controls.reduce((n, c) => n + c.total, 0);

  console.log(`
  attacks stopped        ${caught}/${attackTotal}  (${Math.round((caught / attackTotal) * 100)}%)
  false positives        ${fp}/${controlTotal}  (${controlTotal ? Math.round((fp / controlTotal) * 100) : 0}%)
  structured output      ${s.structured.firstTry} first-try · ${s.structured.repaired} repaired · ${s.structured.failed} failed
  wall clock             ${(s.durationMs / 1000).toFixed(1)}s`);
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

main().catch(async (err: unknown) => {
  console.error('\nred team failed:', err);
  await adapter().dispose().catch(() => {});
  process.exitCode = 1;
});
