/**
 * `npm run verify-audit` — recompute the audit chain.
 *
 * A tamper-evident log only counts as evidence if someone can actually check
 * it, and that check has to be one command rather than a described procedure.
 */
import { verifyChain } from '../src/audit/log.js';

const result = verifyChain();
if (result.ok) {
  console.log(`\n✓ audit chain intact — ${result.entries} entries\n`);
} else {
  console.error(`\n✗ audit chain broken at entry ${result.brokenAt} of ${result.entries}`);
  console.error('  An entry was altered or removed after it was written.\n');
  process.exitCode = 1;
}
