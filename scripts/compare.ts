/**
 * Compare two runs by looking only at what changed.
 *
 * This is the whole reason `eval.ts` stores per-prompt verdicts. Comparing two
 * aggregate rates cannot tell a real improvement from sampling noise: this
 * project has measured 44% and 31% on identical runs of the same set, and at
 * n=79 one prompt is worth 1.3 points while the standard error is 5.6.
 *
 * A paired comparison sidesteps most of that. Prompts that behaved the same in
 * both runs carry no information about the change and only add variance, so
 * they are dropped. What is left — fixed, broken, and still-wrong — is small
 * enough to read individually, which is the point: you should be able to look
 * at the prompts a change broke, not just at a number that got worse.
 *
 *   pnpm run compare data/measurements/<before>.json data/measurements/<after>.json
 */
import { readFileSync } from 'node:fs';

type PromptResult = {
  id: string; set: string; lang: string; expect: string; probes: string | null;
  got: string[]; firedRules: string[][]; rulesJudged: number[]; ms: number[]; correct: boolean[];
};
type Run = {
  startedAt: string; commit: string; dirty?: boolean; adapter: string; reps: number;
  policyVersion: string;
  machine?: { cpu?: string; cores?: number };
  config?: Record<string, string>;
  totals: { latencyMs?: { p50: number; p95: number } };
  perPrompt: PromptResult[];
};

/** Wrong in any repetition counts as wrong — see the note in eval.ts. */
const ok = (r: PromptResult) => r.correct.every(Boolean);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

function load(path: string): Run {
  return JSON.parse(readFileSync(path, 'utf8')) as Run;
}

function describe(label: string, run: Run): void {
  const cfg = Object.entries(run.config ?? {}).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(
    `${label}  ${run.commit}${run.dirty ? '+dirty' : ''} · ${run.adapter} · ${run.reps} rep(s) · ` +
    `${run.perPrompt.length} prompts · ${run.startedAt.slice(0, 16).replace('T', ' ')}`
  );
  if (cfg) console.log(`       ${cfg}`);
  if (run.machine?.cpu) console.log(`       ${run.machine.cpu} (${run.machine.cores} cores)`);
}

function main(): void {
  const [beforePath, afterPath] = process.argv.slice(2);
  if (!beforePath || !afterPath) {
    console.error('usage: pnpm run compare <before.json> <after.json>');
    process.exit(2);
  }

  const before = load(beforePath);
  const after = load(afterPath);

  describe('before', before);
  describe('after ', after);

  if (before.policyVersion !== after.policyVersion) {
    console.log('\n⚠ different policy versions — the rule set changed between these runs,');
    console.log('  so a difference here is not attributable to the code change alone.');
  }
  if (before.adapter !== after.adapter) {
    console.log('\n⚠ different adapters — these runs are not comparable.');
  }
  if (before.machine?.cpu !== after.machine?.cpu) {
    console.log('\n⚠ different machines — verdicts are comparable, latency is not.');
  }

  const beforeById = new Map(before.perPrompt.map((p) => [p.id, p]));
  const fixed: PromptResult[] = [];
  const broken: PromptResult[] = [];
  const stillWrong: PromptResult[] = [];
  const added: PromptResult[] = [];
  let unchanged = 0;

  for (const a of after.perPrompt) {
    const b = beforeById.get(a.id);
    if (!b) { added.push(a); continue; }
    beforeById.delete(a.id);
    const wasOk = ok(b), isOk = ok(a);
    if (wasOk && isOk) unchanged++;
    else if (!wasOk && isOk) fixed.push(a);
    else if (wasOk && !isOk) broken.push(a);
    else { stillWrong.push(a); unchanged += 0; }
  }
  const removed = [...beforeById.values()];

  const show = (title: string, rows: PromptResult[], mark: string) => {
    if (rows.length === 0) return;
    console.log(`\n${mark} ${title} (${rows.length})`);
    for (const r of rows) {
      const rules = [...new Set(r.firedRules.flat())].join(',') || '—';
      console.log(`   ${r.id.padEnd(9)} ${r.expect.padEnd(8)} → ${[...new Set(r.got)].join('/').padEnd(16)} ${rules}`);
      const text = (after.perPrompt.find((p) => p.id === r.id) ?? r) as PromptResult & { text?: string };
      if (text.text) console.log(`             «${text.text}»`);
      if (r.probes) console.log(`             probes: ${r.probes}`);
    }
  };

  console.log('\n' + '─'.repeat(66));
  show('FIXED — wrong before, right now', fixed, '✓');
  show('BROKEN — right before, wrong now', broken, '✗');
  show('STILL WRONG', stillWrong, '·');
  if (added.length) console.log(`\n+ ${added.length} prompt(s) only in the newer run`);
  if (removed.length) console.log(`− ${removed.length} prompt(s) only in the older run`);

  const net = fixed.length - broken.length;
  console.log('\n' + '─'.repeat(66));
  console.log(`unchanged and correct : ${unchanged}`);
  console.log(`fixed                 : ${fixed.length}`);
  console.log(`broken                : ${broken.length}`);
  console.log(`still wrong           : ${stillWrong.length}`);
  console.log(`net                   : ${net >= 0 ? '+' : ''}${net}`);

  // Discordant pairs are the only ones that carry information about the change.
  // Under the null hypothesis they split evenly, so a lopsided split is the
  // evidence — and a thin one is not, however good the net looks.
  const discordant = fixed.length + broken.length;
  if (discordant === 0) {
    console.log('\nNo prompt changed verdict. This change is invisible to this set.');
  } else if (discordant < 6) {
    console.log(
      `\n⚠ only ${discordant} prompt(s) moved. That is too few to call: a run-to-run\n` +
      `  swing of this size has already been observed on identical configurations.\n` +
      `  Re-run with --reps 3, or grow the set.`
    );
  } else {
    console.log(`\n${discordant} prompts moved, ${fixed.length} toward correct.`);
  }

  const bl = before.totals.latencyMs, al = after.totals.latencyMs;
  if (bl && al && before.machine?.cpu === after.machine?.cpu) {
    const d = al.p50 - bl.p50;
    console.log(`latency p50           : ${bl.p50}ms → ${al.p50}ms (${d >= 0 ? '+' : ''}${d}ms)`);
  }
  const bj = median(before.perPrompt.flatMap((p) => p.rulesJudged));
  const aj = median(after.perPrompt.flatMap((p) => p.rulesJudged));
  if (bj !== aj) console.log(`rules judged (median) : ${bj} → ${aj}`);
}

main();
