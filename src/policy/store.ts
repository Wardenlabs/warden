/**
 * The policy of record: what the admin has ratified, on disk, versioned.
 *
 * Kept as plain JSON rather than a database on purpose — a governance policy is
 * something a human should be able to open, read, diff in git, and audit
 * without tooling. The whole file is a few kilobytes.
 *
 * Every ratified state is content-hashed. The hash is the version, it is
 * stamped into every audit entry, and because it is a hash rather than a
 * counter, tampering with the file after the fact is detectable: the recorded
 * version won't match a rehash of the contents.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bindsActor, EVERYONE } from './audience.js';
import { policySpecSchema, quotaSchema, ruleSchema, type PolicySpec, type Rule, type Quota } from './types.js';

const POLICY_PATH = process.env['WARDEN_POLICY_PATH'] ?? 'data/policies.json';

/** Used when a policy file predates `exemptRoles`, and by `hashPolicy` callers. */
const DEFAULT_EXEMPT_ROLES = ['admin'];

/**
 * Hash the meaningful content of a policy — rules and quotas — independent of
 * ordering and of the version/timestamp fields themselves. Two policies with
 * the same rules in a different order are the same policy and hash alike.
 */
export function hashPolicy(
  rules: Rule[],
  quotas: Quota[],
  exemptRoles: string[] = DEFAULT_EXEMPT_ROLES
): string {
  const canonical = JSON.stringify({
    rules: [...rules]
      .map((r) => ({ ...r, embedding: undefined }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    quotas: [...quotas].sort((a, b) => a.role.localeCompare(b.role)),
    exemptRoles: [...exemptRoles].sort()
  });
  return createHash('sha256').update(canonical).digest('hex');
}

let cached: PolicySpec | null = null;

/** The active policy, loaded once and kept in memory. Empty if none saved yet. */
export function loadPolicy(): PolicySpec {
  if (cached) return cached;

  if (!existsSync(POLICY_PATH)) {
    cached = {
      version: hashPolicy([], [], DEFAULT_EXEMPT_ROLES),
      updatedAt: nowIso(),
      rules: [],
      quotas: [],
      exemptRoles: DEFAULT_EXEMPT_ROLES
    };
    return cached;
  }

  const parsed = policySpecSchema.safeParse(JSON.parse(readFileSync(POLICY_PATH, 'utf8')));
  if (!parsed.success) {
    throw new Error(`policy file at ${POLICY_PATH} is malformed: ${parsed.error.message}`);
  }
  cached = parsed.data;
  return cached;
}

/**
 * Persist a new ratified policy, re-hashing to a fresh version.
 *
 * This is the only path that changes what employees are judged against. It
 * returns the stored spec so a caller can surface the new version immediately.
 */
export function savePolicy(
  rules: Rule[],
  quotas: Quota[],
  exemptRoles: string[] = loadPolicy().exemptRoles ?? DEFAULT_EXEMPT_ROLES
): PolicySpec {
  const spec: PolicySpec = {
    version: hashPolicy(rules, quotas, exemptRoles),
    updatedAt: nowIso(),
    rules,
    quotas,
    exemptRoles
  };
  mkdirSync(dirname(POLICY_PATH), { recursive: true });
  writeFileSync(POLICY_PATH, JSON.stringify(spec, null, 2) + '\n');
  cached = spec;
  return spec;
}

/** Seed the store from a file the team authored, if no policy exists yet. */
export function seedIfEmpty(seedPath: string): PolicySpec {
  const current = loadPolicy();
  if (current.rules.length > 0) return current;
  if (!existsSync(seedPath)) return current;

  const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as { rules: Rule[]; quotas: Quota[] };
  return savePolicy(seed.rules ?? [], seed.quotas ?? []);
}

/**
 * Is the stored policy exactly the one we ship, untouched?
 *
 * Compared by the policy's own version hash rather than by rule ids, so a rule
 * whose text or severity was edited no longer matches even though its id did
 * not change. That is the property the boot migration needs: it may only
 * remove a policy that demonstrably contains nothing a human wrote, and an
 * identical hash is the strongest available statement of that.
 *
 * `exemptRoles` is taken from the stored spec, not from the default, because
 * it is inside the hash — an admin who changed who is exempt has changed the
 * policy, and this has to say so.
 */
export function isShippedSeed(seedPath: string): boolean {
  if (!existsSync(seedPath)) return false;
  const current = loadPolicy();
  if (current.rules.length === 0) return false;
  try {
    const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as { rules: Rule[]; quotas: Quota[] };
    const exempt = current.exemptRoles ?? DEFAULT_EXEMPT_ROLES;
    return current.version === hashPolicy(seed.rules ?? [], seed.quotas ?? [], exempt);
  } catch {
    return false;
  }
}

/**
 * Remove the rules and quotas that came out of the shipped seed, keeping
 * everything else.
 *
 * The all-or-nothing version of this was wrong in the one case that actually
 * happened. Somebody on an old build wrote a single rule of their own on top of
 * the eight that had been seeded without asking; the policy therefore did not
 * hash identically to the seed; and the migration declined to remove anything —
 * the eight invented rules, the seven invented people, all of it stayed,
 * because of one rule that had nothing to do with any of them. "I just
 * downloaded the latest version and I still see test data" is the correct
 * report of that.
 *
 * So the unit is a rule, not the file. A rule is removed only when it is
 * byte-identical to one we ship, which is a fact about that rule and not about
 * its neighbours: edit a seeded rule by one word and it stays, because it is
 * now yours. Quotas are handled the same way and for the same reason.
 *
 * Returns how many of each went, so the boot can say it out loud.
 */
/**
 * Every version of a sample rule this repo has shipped.
 *
 * `discardSeededRules` recognises a seeded rule by comparing it to the file we
 * ship, which quietly stops working the moment anybody improves the sample
 * policy's prose: an install already holding last version's wording becomes
 * unrecognisable, and the sweep written to remove it removes nothing. That is
 * not hypothetical. The `text` of all eight was rewritten in one pass and the
 * `guidance` of two more in another, and the second one is the reason this
 * stores whole rules rather than just their text: matching on text alone left
 * `r-instruction-override` and `r-credentials` behind, because a semicolon had
 * replaced a dash in a field nobody thought of.
 *
 * A rule the administrator edited matches no version in here and survives.
 */
function retiredRules(seedDir: string): unknown[] {
  const path = join(seedDir, 'retired-rules.json');
  if (!existsSync(path)) return [];
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as { rules?: unknown[] };
    return doc.rules ?? [];
  } catch {
    // A malformed history means we recognise less, never more.
    return [];
  }
}

export function discardSeededRules(seedPath: string): { rules: number; quotas: number } {
  const none = { rules: 0, quotas: 0 };
  if (!existsSync(seedPath)) return none;

  let seed: { rules?: Rule[]; quotas?: Quota[] };
  try {
    seed = JSON.parse(readFileSync(seedPath, 'utf8')) as { rules?: Rule[]; quotas?: Quota[] };
  } catch {
    return none;
  }

  // Both sides go through the schema before being compared, and that is the
  // whole trick. The seed file is hand-written JSON that leaves optional fields
  // out; what is on disk came back through `policySpecSchema`, which fills the
  // defaults in and fixes the key order. Comparing the raw file against the
  // parsed store found nothing in common — eight identical rules, zero matches,
  // and a migration that reported success while removing none of them. Parsing
  // the seed the same way is what makes "identical" mean identical.
  const canon = (r: unknown): string | null => {
    const parsed = ruleSchema.safeParse(r);
    return parsed.success ? JSON.stringify({ ...parsed.data, embedding: undefined }) : null;
  };
  const canonQuota = (q: unknown): string | null => {
    const parsed = quotaSchema.safeParse(q);
    return parsed.success ? JSON.stringify(parsed.data) : null;
  };
  // What we ship now, plus every version of it we have ever shipped.
  const shippedRules = new Set<string>();
  for (const raw of [...(seed.rules ?? []), ...retiredRules(dirname(seedPath))]) {
    const key = canon(raw);
    if (key !== null) shippedRules.add(key);
  }
  const shippedQuotas = new Set(
    (seed.quotas ?? []).map(canonQuota).filter((x): x is string => x !== null)
  );

  const current = loadPolicy();
  const rules = current.rules.filter((r) => {
    const key = canon(r);
    return key === null || !shippedRules.has(key);
  });
  const quotas = current.quotas.filter((q) => {
    const key = canonQuota(q);
    return key === null || !shippedQuotas.has(key);
  });

  const removed = {
    rules: current.rules.length - rules.length,
    quotas: current.quotas.length - quotas.length
  };
  if (removed.rules === 0 && removed.quotas === 0) return none;

  if (rules.length === 0 && quotas.length === 0) discardPolicy();
  else savePolicy(rules, quotas);
  return removed;
}

/** Remove the policy file, leaving the install governing nothing. */
export function discardPolicy(): void {
  cached = null;
  try {
    if (existsSync(POLICY_PATH)) rmSync(POLICY_PATH);
  } catch {
    /* a read-only data folder keeps the file; the cache reset still empties this process */
  }
}

/**
 * Which half of the exchange is being judged.
 *
 * `'any'` skips the filter and is for describing a policy rather than enforcing
 * it — the console listing what binds a person, the baseline system prompt,
 * which governs a whole conversation and not one direction of it.
 */
export type JudgedSide = 'input' | 'output' | 'any';

/**
 * Does this rule govern the side being judged?
 *
 * `Rule.scope` existed from the first commit and, until this was written,
 * **nothing read it**. Every rule was adjudicated against every prompt whatever
 * it said, which is not a half-built feature but a wrong one: `r-legal-commitment`
 * is scoped `output` because it exists to catch the assistant committing the
 * company to something in its *answer*, and it was being asked whether an
 * employee's question violated it. A rule written to judge outputs, judging
 * inputs, is a false positive by construction — and the shipped policy has one
 * of eight like that, with two more among the presets.
 */
function governsSide(rule: Rule, side: JudgedSide): boolean {
  return side === 'any' || rule.scope === 'both' || rule.scope === side;
}

/**
 * Rules that bind this actor: the company-wide ones, the ones for their role,
 * and the ones written for them personally.
 *
 * This is the only place the guard decides which rules a prompt is measured
 * against, so the three audience kinds are resolved together rather than
 * layered on by callers — a caller that forgot one would produce a decision
 * that looks complete and is missing a rule. Scope joins them here for the same
 * reason: a caller filtering it by hand is a caller that will forget.
 *
 * `side` defaults to `'input'` because that is what almost every caller means
 * and because defaulting the other way would keep the bug.
 */
export function rulesForActor(
  spec: PolicySpec,
  actor: { id: string; role: string },
  side: JudgedSide = 'input'
): Rule[] {
  // Exemption is per-rule, not per-actor: it only ever excuses someone from a
  // rule that did not name them. A rule written for everyone (`appliesTo`
  // includes `*`) — including the pinned injection rule — does not quietly
  // re-capture an exempt role; that half of the old behaviour is unchanged.
  // But a rule that names an exempt role or a specific `@id` on purpose does
  // bind them, because writing that rule was itself an act only an
  // administrator can perform — the same permission that already lets them
  // ratify any rule at all. Nobody gains the power to widen or narrow who a
  // rule binds by anything other than the permission they already had; this
  // just stops the wildcard case from being the only case `isExempt` can see.
  //
  // This is only ever as strong as the identity behind `actor.role`, which is
  // why it is safe now and was not when it was written: the role no longer
  // arrives on a header a caller can set. It is read from the directory entry
  // behind an API key the gateway issued, so exemption is something an admin
  // grants rather than something a caller claims. If a header path is ever
  // reintroduced, this line becomes a bypass again.
  const exempt = isExempt(spec, actor.role);
  return spec.rules.filter((r) => {
    if (exempt && r.appliesTo.includes(EVERYONE)) return false;
    return bindsActor(r.appliesTo, actor) && governsSide(r, side);
  });
}

/** Whether the policy declines to govern this role at all. */
export function isExempt(spec: PolicySpec, role: string): boolean {
  return (spec.exemptRoles ?? DEFAULT_EXEMPT_ROLES).includes(role);
}

/*
 * `claimableRole()` lived here: it demoted a claimed exempt role so a stranger
 * could not opt out of the policy with a header. It is gone because the header
 * path is gone — a caller supplies a key and nothing else, so there is no
 * claimed role left to demote. Kept as a note rather than dead code, because
 * the hazard it existed for is one line away from returning.
 */

/**
 * Rules for a role, with no particular person in mind.
 *
 * Used where there is genuinely no identity to resolve — the red-team harness,
 * the baseline system prompt for an unknown caller. It cannot see rules
 * written for a named employee, which is correct: those rules bind a person,
 * not the role they happen to hold.
 */
export function rulesForRole(spec: PolicySpec, role: string, side: JudgedSide = 'input'): Rule[] {
  return rulesForActor(spec, { id: '', role }, side);
}

/**
 * Reset the in-memory cache. Tests and the dev server call this after writing
 * the file out of band; production never needs it.
 */
export function invalidate(): void {
  cached = null;
}

/**
 * Timestamp helper. `Date` is unavailable in some sandboxed contexts, so this
 * is isolated to one place that can be stubbed.
 */
function nowIso(): string {
  return new Date().toISOString();
}
