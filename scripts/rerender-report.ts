/**
 * `pnpm run report` — rebuild REPORT.md from the last run's saved results.
 *
 * The corpus takes forty minutes against a real model, and the report generator
 * changes far more often than the corpus does. Every fix to how a number is
 * presented — a caveat, a provenance stamp, a column that was measuring the
 * wrong thing — used to mean either re-running the whole thing or hand-editing a
 * generated file. Both are bad: one wastes an hour, the other produces an
 * artifact that no longer matches its generator.
 *
 * The runner already saves the complete summary. This re-renders it.
 *
 * It does not re-measure anything, so the numbers are exactly the ones the run
 * produced, including its timestamp. If you want new numbers, run the corpus.
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeReport, type RunSummary } from '../src/redteam/report.js';

const SAVED = 'data/redteam-last.json';

if (!existsSync(SAVED)) {
  console.error(`no saved run at ${SAVED} — run \`pnpm run redteam\` first`);
  process.exit(1);
}

const summary = JSON.parse(readFileSync(SAVED, 'utf8')) as RunSummary;

// A mock run writes its own file precisely so it cannot be mistaken for
// evidence; re-rendering it into REPORT.md would undo that.
if (summary.adapter === 'mock') {
  console.error('the last saved run used the mock adapter — refusing to write REPORT.md from it');
  process.exit(1);
}

writeReport(summary);
console.log(
  `REPORT.md rebuilt from the run of ${summary.startedAt} ` +
    `(policy ${summary.policyVersion.slice(0, 12)}, ${summary.reps} rep${summary.reps === 1 ? '' : 's'})`
);
