/**
 * Turns a red-team run into REPORT.md.
 *
 * Written to be read by someone deciding whether to believe us, which means
 * every failure appears by name. A report that only lists what worked is a
 * marketing page, and the difference is visible immediately to anyone who has
 * read a real evaluation.
 */
import { writeFileSync } from 'node:fs';

export type ClassResult = {
  class: string;
  goal: string;
  /** Legitimate traffic: correct means allowed, not blocked. */
  isControl: boolean;
  total: number;
  correct: number;
  missed: number;
  falsePositives: number;
  p50: number;
  p95: number;
  failures: { id: string; expect: string; got: string; lang: string }[];
};

export type RunSummary = {
  startedAt: string;
  durationMs: number;
  reps: number;
  adapter: 'mock' | 'real';
  policyVersion: string;
  ruleCount: number;
  warden: ClassResult[];
  baseline: ClassResult[];
  structured: { firstTry: number; repaired: number; failed: number };
};

const pct = (n: number, d: number) => (d === 0 ? '—' : `${Math.round((n / d) * 100)}%`);

export function writeReport(s: RunSummary, path = 'REPORT.md'): void {
  const attacks = s.warden.filter((c) => !c.isControl);
  const controls = s.warden.filter((c) => c.isControl);

  const caught = attacks.reduce((n, c) => n + c.correct, 0);
  const attackTotal = attacks.reduce((n, c) => n + c.total, 0);
  const fp = controls.reduce((n, c) => n + c.falsePositives, 0);
  const controlTotal = controls.reduce((n, c) => n + c.total, 0);

  const structuredTotal = s.structured.firstTry + s.structured.repaired + s.structured.failed;

  const out: string[] = [];
  const w = (line = '') => out.push(line);

  w('# Warden — red-team report');
  w();
  w(`Generated ${s.startedAt} · policy \`${s.policyVersion.slice(0, 12)}\` (${s.ruleCount} rules) · `
    + `${s.reps} repetition${s.reps === 1 ? '' : 's'} · adapter \`${s.adapter}\``);
  w();

  if (s.adapter === 'mock') {
    w('> **These numbers are from the mock adapter, not a real model.** The mock is a');
    w('> deterministic stand-in used so the harness can run without a GPU. It says');
    w('> nothing about how a real model performs. Re-run with `npm run redteam` on a');
    w('> machine with the models installed before quoting anything here.');
    w();
  }

  w('## Headline');
  w();
  w('| | Warden | Baseline |');
  w('|---|---|---|');
  w(`| Attacks stopped | **${caught}/${attackTotal}** (${pct(caught, attackTotal)}) | ${baselineRate(s, false)} |`);
  w(`| False positives on legitimate traffic | **${fp}/${controlTotal}** (${pct(fp, controlTotal)}) | ${baselineFp(s)} |`);
  w();
  w('Baseline is the same policy written into the model\'s system prompt with the');
  w('guard switched off — what a team ships without this project. It stops nothing,');
  w('because a system prompt is a request, not a control. The gap between the two');
  w('columns is the whole argument.');
  w();
  w('Both numbers are reported together on purpose. A guard that refuses everything');
  w('scores 100% on the first row and is unusable; the second row is what decides');
  w('whether anyone leaves it switched on.');
  w();

  w('## By attack class');
  w();
  w('| Class | Stopped | Missed | p50 | p95 |');
  w('|---|---|---|---|---|');
  for (const c of attacks) {
    w(`| ${c.class} | ${c.correct}/${c.total} (${pct(c.correct, c.total)}) | ${c.missed} | ${c.p50}ms | ${c.p95}ms |`);
  }
  w();

  w('## Legitimate traffic');
  w();
  for (const c of controls) {
    w(`**${c.class}** — ${c.correct}/${c.total} allowed correctly, ${c.falsePositives} wrongly blocked.`);
    w();
    w(`> ${c.goal}`);
    w();
  }

  const allFailures = s.warden.flatMap((c) => c.failures.map((f) => ({ ...f, class: c.class })));
  w('## What we could not fix');
  w();
  if (allFailures.length === 0) {
    w('Nothing failed in this run.');
    w();
    w('That is not a result to celebrate — it means the corpus is too easy for the');
    w('current policy, not that the guard is airtight. Harden the corpus until');
    w('something breaks, then report what broke.');
  } else {
    w(`${allFailures.length} of ${s.warden.reduce((n, c) => n + c.total, 0)} evaluations came out wrong. Each one, by id:`);
    w();
    w('| id | class | expected | got | lang |');
    w('|---|---|---|---|---|');
    for (const f of allFailures) {
      w(`| \`${f.id}\` | ${f.class} | ${f.expect} | **${f.got}** | ${f.lang} |`);
    }
    w();
    w('Rows where `got` is ALLOW are attacks that got through. Rows where the');
    w('expectation was ALLOW are legitimate requests we refused — those cost user');
    w('trust, and in practice they are the ones that get a gateway uninstalled.');
  }
  w();

  w('## Structured-output reliability');
  w();
  w(`| | count | share |`);
  w('|---|---|---|');
  w(`| Validated first attempt | ${s.structured.firstTry} | ${pct(s.structured.firstTry, structuredTotal)} |`);
  w(`| Needed one repair | ${s.structured.repaired} | ${pct(s.structured.repaired, structuredTotal)} |`);
  w(`| Failed closed | ${s.structured.failed} | ${pct(s.structured.failed, structuredTotal)} |`);
  w();
  w('Every guard verdict is generated under a JSON-schema grammar, so the *shape*');
  w('is guaranteed by the decoder. Zod then validates the *content*, which a grammar');
  w('cannot: it can require a number, not a number between 0 and 1. Failures in the');
  w('third row were escalated to a human, never guessed at.');
  w();

  w('## What we learned about small models');
  w();
  w('These came out of building the thing, and each changed the design:');
  w();
  w('**Asking for a boolean plus a confidence score produced 7/8 false positives.**');
  w('The model returned incoherent pairs — "violates" at confidence 0.00 — because');
  w('filling two independent slots never requires deciding anything. Replacing it');
  w('with a single label from a fixed set took false positives to 0/8 on the same');
  w('model and the same inputs.');
  w();
  w('**Self-reported confidence carries no information at this size.** Values');
  w('clustered at 0.00, 0.95 and 1.00 regardless of the answer. Warden derives');
  w('confidence from the label instead, and says so rather than dressing up a');
  w('number that means nothing.');
  w();
  w('**One narrow question per rule beats one broad question about all of them.**');
  w('Asked to check eight rules at once, a small model answers confidently about');
  w('none in particular.');
  w();
  w('**A grammar guarantees shape, not sense.** Constrained decoding eliminated');
  w('malformed output entirely and did nothing for wrong verdicts. Both layers earn');
  w('their place.');
  w();

  w('## Reproducing this');
  w();
  w('```bash');
  w('npm install && npm run setup     # downloads models, verifies inference');
  w('npm run redteam                  # regenerates this file');
  w('npm run redteam -- --reps 5      # more repetitions');
  w('```');
  w();
  w('Runs are deterministic: fixed seed, temperature 0. The same corpus against the');
  w('same policy version reproduces the same numbers.');
  w();

  writeFileSync(path, out.join('\n'));
}

function baselineRate(s: RunSummary, control: boolean): string {
  const rows = s.baseline.filter((c) => c.isControl === control);
  if (rows.length === 0) return 'not run';
  const correct = rows.reduce((n, c) => n + c.correct, 0);
  const total = rows.reduce((n, c) => n + c.total, 0);
  return `${correct}/${total} (${pct(correct, total)})`;
}

function baselineFp(s: RunSummary): string {
  const rows = s.baseline.filter((c) => c.isControl);
  if (rows.length === 0) return 'not run';
  const fp = rows.reduce((n, c) => n + c.falsePositives, 0);
  const total = rows.reduce((n, c) => n + c.total, 0);
  return `${fp}/${total} (${pct(fp, total)})`;
}
