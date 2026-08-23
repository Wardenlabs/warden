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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { bindsActor } from './audience.js';
import { policySpecSchema, type PolicySpec, type Rule, type Quota } from './types.js';

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
 * Rules that bind this actor: the company-wide ones, the ones for their role,
 * and the ones written for them personally.
 *
 * This is the only place the guard decides which rules a prompt is measured
 * against, so the three audience kinds are resolved together rather than
 * layered on by callers — a caller that forgot one would produce a decision
 * that looks complete and is missing a rule.
 */
export function rulesForActor(spec: PolicySpec, actor: { id: string; role: string }): Rule[] {
  // An exempt role is measured against nothing: the person who ratifies the
  // policy is not governed by it. Checked before `appliesTo` so that a rule
  // written for everyone — including the pinned injection rule — does not
  // quietly re-capture them.
  //
  // This is only ever as strong as the identity behind `actor.role`, which is
  // why it is safe now and was not when it was written: the role no longer
  // arrives on a header a caller can set. It is read from the directory entry
  // behind an API key the gateway issued, so exemption is something an admin
  // grants rather than something a caller claims. If a header path is ever
  // reintroduced, this line becomes a bypass again.
  if (isExempt(spec, actor.role)) return [];
  return spec.rules.filter((r) => bindsActor(r.appliesTo, actor));
}

/** Whether the policy declines to govern this role at all. */
export function isExempt(spec: PolicySpec, role: string): boolean {
  return (spec.exemptRoles ?? DEFAULT_EXEMPT_ROLES).includes(role);
}

/**
 * Rules for a role, with no particular person in mind.
 *
 * Used where there is genuinely no identity to resolve — the red-team harness,
 * the baseline system prompt for an unknown caller. It cannot see rules
 * written for a named employee, which is correct: those rules bind a person,
 * not the role they happen to hold.
 */
export function rulesForRole(spec: PolicySpec, role: string): Rule[] {
  return rulesForActor(spec, { id: '', role });
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
