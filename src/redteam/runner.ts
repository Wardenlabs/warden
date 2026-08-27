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
 *   pnpm run redteam
 *   pnpm run redteam -- --reps 3 --class guard-targeted
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate } from '../guard/pipeline.js';
import { resetQuotas } from '../guard/quota.js';
import type { Verdict } from '../guard/types.js';
import { hashPolicy, rulesForRole } from '../policy/store.js';
import type { PolicySpec, Quota, Rule } from '../policy/types.js';
import { provenanceLabel } from '../provenance.js';
import { adapter, isMock } from '../qvac/index.js';
import { writeReport, type ClassResult, type RunSummary } from './report.js';

// Next to this module in both layouts — src/redteam/corpus in a checkout,
// dist/redteam/corpus in a compiled build (the build step copies it there) —
// so the runner works whatever the process's working directory is.
const CORPUS_DIR = fileURLToPath(new URL('./corpus/', import.meta.url));

/**
 * Corpus attachments are repo-relative paths (data/seed/…). The desktop app
 * runs this process with its working directory in the user's data folder, so
 * they resolve against the bundled assets root rather than trusting the cwd.
 */
const ASSETS_DIR = process.env['WARDEN_ASSETS_DIR'] ?? process.cwd();
const resolveAttachment = (p: string): string => (isAbsolute(p) ? p : join(ASSETS_DIR, p));

type Prompt = {
  id: string;
  text?: string;
  turns?: string[];
  attachment?: string;
  expect: Verdict;
  lang: string;
};
type CorpusFile = { class: string; goal: string; note?: string; prompts: Prompt[] };

/**
 * Attachments the guard could not read, counted across the whole run.
 *
 * Asked of the run rather than of the filesystem, because the filesystem cannot
 * answer it. A first attempt checked whether the OCR model sat in `models/` and
 * would have reported "missing" on this machine while the model was, at that
 * moment, arriving over the P2P registry into QVAC's own cache — halfway
 * through the document-borne class, so some of its prompts were read and some
 * were not. Guessing at a cache layout to describe what happened is how a
 * report ends up confidently wrong.
 *
 * The pipeline already records the count per decision. This just adds it up.
 */
let unreadableAttachments = 0;

function countUnreadable(passes: { pass: string; detail?: unknown }[]): void {
  const ocrPass = passes.find((p) => p.pass === 'ocr');
  const detail = ocrPass?.detail as { unreadable?: number } | undefined;
  unreadableAttachments += Number(detail?.unreadable ?? 0);
}

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
 * The policy the benchmark measures against.
 *
 * Read from the committed seed and materialised in memory — never from
 * `data/policies.json`, which is the live store an admin edits through the
 * console. That file used to be the source here, guarded by `seedIfEmpty`, so
 * the numbers silently measured whatever rules happened to exist: anyone who
 * wrote a rule while trying the console changed what the corpus meant, and
 * REPORT.md still claimed the run was reproducible.
 *
 * Nothing is written to disk. A benchmark that mutates the machine it runs on
 * is a benchmark you can only trust the first time.
 *
 * It is a file of its own rather than the shipped seed because the two answer
 * different questions. The seed is what a fresh install starts with, and that
 * set is deliberately small — the admin writes the policy, so shipping a
 * company's worth of invented rules would be shipping our guesses as their
 * policy. The corpus, meanwhile, needs enough rules to be worth attacking, and
 * its 98 prompts were written against these eight. Tying them together would
 * mean every product decision about defaults silently rewrites the benchmark.
 */
function benchmarkPolicy(): PolicySpec {
  const path = process.env['WARDEN_BENCHMARK_POLICY'] ?? join(ASSETS_DIR, 'data', 'seed', 'benchmark-policy.json');
  const seed = JSON.parse(readFileSync(path, 'utf8')) as {
    rules?: Rule[];
    quotas?: Quota[];
    exemptRoles?: string[];
  };
  const rules = seed.rules ?? [];
  const quotas = seed.quotas ?? [];
  const exemptRoles = seed.exemptRoles ?? ['admin'];
  return {
    version: hashPolicy(rules, quotas, exemptRoles),
    updatedAt: new Date(0).toISOString(),
    rules,
    quotas,
    exemptRoles
  };
}

/**
 * Judge one prompt.
 *
 * Multi-turn entries are flattened with their earlier turns as context: the
 * attack depends on the conversation that preceded it, so judging the last
 * message alone would measure something easier than the real thing.
 */
async function runPrompt(
  prompt: Prompt,
  mode: 'warden' | 'baseline',
  policy: PolicySpec
): Promise<Outcome> {
  const actor = { id: 'redteam', role: 'analyst' };
  const text = prompt.turns ? prompt.turns.join('\n') : (prompt.text ?? '');
  const started = Date.now();

  // The harness measures the guard's judging, not the daily counter. Left
  // running, the test actor's quota (`analyst`, 100/day in the benchmark
  // policy) exhausts mid-run — the 98-prompt corpus at `--reps 3` is 294 warden
  // evaluations — and every prompt after that is scored on a quota BLOCK that
  // involved no model at all: attacks "stopped" and controls "refused" by an
  // empty counter.
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
      { actor, prompt: text, ...(prompt.attachment ? { attachments: [resolveAttachment(prompt.attachment)] } : {}) },
      policy
    );
    got = decision.verdict;
    countUnreadable(decision.passes);
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

  const policy = benchmarkPolicy();
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
          const outcome = await runPrompt(prompt, mode, policy);
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
    structured: adapter().stats(),
    unreadableAttachments,
    codeCommit: provenanceLabel()
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
