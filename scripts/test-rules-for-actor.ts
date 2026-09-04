/**
 * Does `rulesForActor` still treat exemption as per-actor for wildcard rules,
 * and per-rule for anything that names someone on purpose?
 *
 * This is the function `CLAUDE.md` calls out as sitting next to "the most
 * security-relevant sentence in the spec" (`exemptRoles`), so it gets its own
 * gate rather than trusting the red-team corpus alone: the corpus measures
 * whether verdicts moved, this measures the filter's actual boundary, case by
 * case, including the ones the shipped policy has no reason to exercise yet
 * (nobody has written a rule that names an exempt role — this is what proves
 * the filter behaves correctly on the day someone does).
 *
 * Pure function, no adapter, no models, runs in milliseconds.
 *
 *   pnpm run test:rules
 */
import { rulesForActor } from '../src/policy/store.js';
import type { PolicySpec, Rule } from '../src/policy/types.js';

function rule(partial: Partial<Rule> & Pick<Rule, 'id' | 'appliesTo'>): Rule {
  return {
    text: 'placeholder',
    scope: 'both',
    severity: 'block',
    examples: { violating: ['x'], compliant: ['y'] },
    ...partial
  };
}

const spec: PolicySpec = {
  version: 'x'.repeat(64),
  updatedAt: new Date().toISOString(),
  exemptRoles: ['admin'],
  quotas: [],
  rules: [
    rule({ id: 'r-everyone', appliesTo: ['*'] }),
    rule({ id: 'r-sales', appliesTo: ['sales'] }),
    rule({ id: 'r-admin-role', appliesTo: ['admin'] }),
    rule({ id: 'r-admin-person', appliesTo: ['@gaston'] }),
    rule({ id: 'r-mixed', appliesTo: ['sales', 'admin'] })
  ]
};

type Case = { who: { id: string; role: string }; expect: string[]; why: string };

const CASES: Case[] = [
  {
    who: { id: 'gaston', role: 'admin' },
    expect: ['r-admin-role', 'r-admin-person', 'r-mixed'],
    why: 'exempt role: wildcard and role-for-others stay invisible, rules naming them by role or @id do not'
  },
  {
    who: { id: 'someone-else', role: 'admin' },
    expect: ['r-admin-role', 'r-mixed'],
    why: 'exempt role, different person: the @id-scoped rule for gaston specifically does not follow the role'
  },
  {
    who: { id: 'ana', role: 'sales' },
    expect: ['r-everyone', 'r-sales', 'r-mixed'],
    why: 'non-exempt role: unchanged from before this change — wildcard and role rules both apply'
  },
  {
    who: { id: 'nobody', role: 'operator' },
    expect: ['r-everyone'],
    why: 'non-exempt role with no rule of its own: only the wildcard applies, same as always'
  }
];

let failed = 0;
for (const { who, expect, why } of CASES) {
  const got = rulesForActor(spec, who)
    .map((r) => r.id)
    .sort();
  const want = [...expect].sort();
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  const verdict = ok ? '  ok  ' : ' FAIL ';
  console.log(`${verdict} ${who.role.padEnd(10)} ${who.id.padEnd(14)} got [${got.join(', ')}]`);
  if (!ok) console.log(`         expected [${want.join(', ')}] — ${why}`);
}

console.log(
  `\n${CASES.length - failed}/${CASES.length} cases matched` +
    (failed > 0 ? `\n${failed} FAILED — rulesForActor no longer behaves as this test expects` : '')
);
process.exitCode = failed > 0 ? 1 : 0;
