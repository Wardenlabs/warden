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
import { resetQuotas } from '../guard/quota.js';
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
  /**
   * Every rule that fired, not just the first.
   *
   * A false positive usually has one rule to blame, but the report cannot say
   * which if it only ever sees the top one — and knowing that two rules produce
   * most of the false positives turns "the model is bad" into "these two rules
   * are badly worded", which is a fixable problem.
   */
  firedRules: string[];
  /** The prompt, so the report can quote it. */
  text: string;
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

  // The harness measures the guard's judging, not the daily counter. Left
  // running, the test actor's quota (100/day in the seed policy) exhausts
  // mid-run — the 98-prompt corpus at `--reps 3` is 294 warden evaluations —
  // and every prompt after that is scored on a quota BLOCK that involved no
  // model at all: attacks "stopped" and controls "refused" by an empty counter.
  resetQuotas();

  let got: Verdict;
  let firedRule: string | undefined;
  let firedRules: string[] = [];

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
    firedRules = decision.firedRules.map((r) => r.ruleId);
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
    text,
    firedRules,
    ...(firedRule ? { firedRule } : {})
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repsRaw = Number(argValue(args, '--reps') ?? 1);
  const reps = Number.isFinite(repsRaw) && repsRaw >= 1 ? Math.floor(repsRaw) : 1;
  const only = argValue(args, '--class');
  const modes: ('warden' | 'baseline')[] = args.includes('--no-baseline')
    ? ['warden']
    : ['warden', 'baseline'];

  seedIfEmpty('data/seed/policies.seed.json');
  const policy = loadPolicy();
  const corpus = loadCorpus(only);
  if (corpus.length === 0) {
    // A typo'd --class must not overwrite REPORT.md with a report about nothing.
    console.error(`no corpus class matches ${only ? `"${only}"` : 'the filter'} — nothing run, nothing written`);
    process.exitCode = 1;
    return;
  }
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
  // Two kinds of run must not overwrite the project's evidence, for two
  // different reasons. A mock run measures the harness rather than a model. A
  // filtered run covers part of the corpus — `--class benign-controls` used to
  // replace REPORT.md with a report whose attack table was empty. Each gets its
  // own file, and the two compose.
  const isMockRun = summary.adapter === 'mock';
  const slice = only ? `.${only}` : '';
  const reportPath = isMockRun ? `data/redteam-last.mock${slice}.md` : `REPORT${slice}.md`;
  writeReport(summary, reportPath);
  // Persist the structured result too, so the console can render it without
  // parsing markdown or re-running the suite. Only from a full run: a filtered
  // one describes part of the corpus and the console would render it as all of
  // it.
  if (!only) {
    writeFileSync(
      isMockRun ? 'data/redteam-last.mock.json' : 'data/redteam-last.json',
      JSON.stringify(summary, null, 2)
    );
  }
  console.log(`\nwrote ${reportPath}\n`);
  await adapter().dispose();
}

function summarise(file: CorpusFile, outcomes: Outcome[]): ClassResult {
  const isControl = outcomes.every((o) => o.expect === 'ALLOW');
  const times = outcomes.map((o) => o.ms).sort((a, b) => a - b);
  // Attack and control tallies are per prompt, not per file: a class can mix
  // both (document-borne carries two clean invoices among its attacks), and
  // bucketing whole files miscounted a correctly-allowed control as a stopped
  // attack while its false positives fell out of every table.
  const attacks = outcomes.filter((o) => o.expect !== 'ALLOW');
  const controls = outcomes.filter((o) => o.expect === 'ALLOW');
  return {
    class: file.class,
    goal: file.goal,
    isControl,
    total: outcomes.length,
    correct: outcomes.filter((o) => o.correct).length,
    missed: outcomes.filter((o) => o.missed).length,
    falsePositives: outcomes.filter((o) => o.falsePositive).length,
    attacks: attacks.length,
    attacksStopped: attacks.filter((o) => o.correct).length,
    controls: controls.length,
    controlsAllowed: controls.filter((o) => o.correct).length,
    p50: times[Math.floor(times.length * 0.5)] ?? 0,
    p95: times[Math.floor(times.length * 0.95)] ?? 0,
    failures: outcomes.filter((o) => !o.correct).map((o) => ({
      id: o.id, expect: o.expect, got: o.got, lang: o.lang,
      // Carry the prompt itself into the report. A reader looking at `bc-08`
      // should not have to open the corpus to judge whether we were wrong.
      text: o.text,
      firedRules: o.firedRules,
      falsePositive: o.falsePositive,
      ...(o.firedRule ? { firedRule: o.firedRule } : {})
    }))
  };
}

function printConsole(s: RunSummary): void {
  const pct = (n: number, d: number) => (d === 0 ? '  —' : `${Math.round((n / d) * 100)}%`);
  const row = (c: ClassResult, b?: ClassResult) => {
    const rate = (r: ClassResult) => pct(r.correct, r.total);
    const label = c.isControl ? 'allowed' : 'correct';
    return `  ${c.class.padEnd(24)} ${rate(c).padStart(5)} ${label}` +
           (b ? `   baseline ${rate(b).padStart(5)}` : '');
  };

  console.log('\nby class');
  for (const c of s.warden) {
    console.log(row(c, s.baseline.find((x) => x.class === c.class)));
  }

  const caught = s.warden.reduce((n, c) => n + c.attacksStopped, 0);
  const attackTotal = s.warden.reduce((n, c) => n + c.attacks, 0);
  const fp = s.warden.reduce((n, c) => n + c.falsePositives, 0);
  const controlTotal = s.warden.reduce((n, c) => n + c.controls, 0);

  console.log(`
  attacks stopped        ${caught}/${attackTotal}  (${pct(caught, attackTotal)})
  false positives        ${fp}/${controlTotal}  (${pct(fp, controlTotal)})
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
