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
import { policySpecSchema, type PolicySpec, type Rule, type Quota } from './types.js';

const POLICY_PATH = process.env['WARDEN_POLICY_PATH'] ?? 'data/policies.json';

/**
 * Hash the meaningful content of a policy — rules and quotas — independent of
 * ordering and of the version/timestamp fields themselves. Two policies with
 * the same rules in a different order are the same policy and hash alike.
 */
export function hashPolicy(rules: Rule[], quotas: Quota[]): string {
  const canonical = JSON.stringify({
    rules: [...rules]
      .map((r) => ({ ...r, embedding: undefined }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    quotas: [...quotas].sort((a, b) => a.role.localeCompare(b.role))
  });
  return createHash('sha256').update(canonical).digest('hex');
}

let cached: PolicySpec | null = null;

/** The active policy, loaded once and kept in memory. Empty if none saved yet. */
export function loadPolicy(): PolicySpec {
  if (cached) return cached;

  if (!existsSync(POLICY_PATH)) {
    cached = { version: hashPolicy([], []), updatedAt: nowIso(), rules: [], quotas: [] };
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
export function savePolicy(rules: Rule[], quotas: Quota[]): PolicySpec {
  const spec: PolicySpec = {
    version: hashPolicy(rules, quotas),
    updatedAt: nowIso(),
    rules,
    quotas
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

/** Rules that apply to a given actor role — always includes the wildcard set. */
export function rulesForRole(spec: PolicySpec, role: string): Rule[] {
  return spec.rules.filter((r) => r.appliesTo.includes('*') || r.appliesTo.includes(role));
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
