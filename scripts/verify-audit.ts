/**
 * `npm run verify-audit` — recompute the audit chain.
 *
 * A tamper-evident log only counts as evidence if someone can actually check
 * it, and that check has to be one command rather than a described procedure.
 */
import { verifyChain } from '../src/audit/log.js';

const result = verifyChain();

if (result.ok) {
  console.log(`\n✓ audit chain intact — ${result.entries} entries`);
  // Say so rather than implying the count was checked. A log with no witness
  // beside it can still have had its tail removed without leaving a trace.
  if (result.unwitnessed) {
    console.log('  No witness file, so completeness is unproven — only that every');
    console.log('  entry still present follows from the one before it.');
  }
  console.log('');
} else if (result.missing !== undefined && result.brokenAt === undefined) {
  console.error(`\n✗ audit entries are missing — ${result.entries} present, ${result.missing} gone`);
  console.error('  The entries still here are internally consistent, so this is not an');
  console.error('  edit: the end of the log was removed after it was written.\n');
  process.exitCode = 1;
} else {
  console.error(`\n✗ audit chain broken at entry ${result.brokenAt} of ${result.entries}`);
  console.error('  An entry was altered or removed after it was written.\n');
  process.exitCode = 1;
}
