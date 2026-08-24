/**
 * The company directory: who works here, what role they hold, and which key
 * identifies them.
 *
 * Kept separate from the policy store because the two change for different
 * reasons and at different rates. People join and leave constantly; the rules
 * they are judged against are a deliberate, ratified act. Mixing them would
 * mean every hire re-hashes the policy version and every audit entry claims a
 * policy change that never happened.
 *
 * Like the policy, this is plain JSON a human can open and read. It is seeded
 * once from `data/seed/company.json` and then owned by the admin console —
 * the seed file stays pristine so a fresh clone always demonstrates the same
 * company, and so `git status` stays quiet while someone plays with the app.
 *
 * The seed names people and roles; it carries no keys. Those are issued on the
 * first run — see `loadDirectory()` for why a committed key is a published
 * credential rather than a convenience.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

const COMPANY_PATH = process.env['WARDEN_COMPANY_PATH'] ?? 'data/company.json';
const SEED_PATH = process.env['WARDEN_COMPANY_SEED'] ?? 'data/seed/company.json';

export const employeeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  /** Identifies the caller on the proxy. Never leaves the gateway machine. */
  apiKey: z.string().min(1)
});
export type Employee = z.infer<typeof employeeSchema>;

export const directorySchema = z.object({
  name: z.string().default(''),
  description: z.string().default(''),
  roles: z.array(z.string().min(1)).min(1),
  employees: z.array(employeeSchema)
});
export type Directory = z.infer<typeof directorySchema>;

const EMPTY: Directory = {
  name: '',
  description: '',
  roles: ['admin', 'employee'],
  employees: []
};

let cached: Directory | null = null;

/** The directory as it stands, seeding from the demo company on first use. */
export function loadDirectory(): Directory {
  if (cached) return cached;

  const fromDisk = readIfPresent(COMPANY_PATH);
  if (fromDisk) {
    cached = fromDisk;
    return cached;
  }

  const seeded = readIfPresent(SEED_PATH);
  if (!seeded) {
    cached = EMPTY;
    return cached;
  }

  /**
   * Every key is issued here, on first run, and never shipped.
   *
   * The seed is a committed file in a public repository, so a key written into
   * it is a published credential: the same string would authenticate on every
   * install that had not rotated it. That is sharpest for the seeded admin,
   * whose role sits in `exemptRoles` and is therefore measured against no rules
   * at all — a working bypass, printed in the repo, for a product whose whole
   * claim is that prompts are judged.
   *
   * So the seed carries placeholders and this issues the real ones, which also
   * means no two installs share a key and the demo company can stay committed.
   */
  const issued: Directory = {
    ...seeded,
    employees: seeded.employees.map((e) => ({ ...e, apiKey: newApiKey(e.id) }))
  };

  try {
    return save(issued);
  } catch {
    // A read-only checkout still gets a working directory for this process;
    // the keys simply do not survive a restart.
    cached = issued;
    return cached;
  }
}

function readIfPresent(path: string): Directory | null {
  if (!existsSync(path)) return null;
  const parsed = directorySchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) {
    throw new Error(`company directory at ${path} is malformed: ${parsed.error.message}`);
  }
  return parsed.data;
}

function save(next: Directory): Directory {
  const validated = directorySchema.parse(next);
  mkdirSync(dirname(COMPANY_PATH), { recursive: true });
  writeFileSync(COMPANY_PATH, JSON.stringify(validated, null, 2) + '\n');
  cached = validated;
  return validated;
}

/** Reset the in-memory copy. Tests and out-of-band edits need this. */
export function invalidate(): void {
  cached = null;
}

// ── employees ──────────────────────────────────────────────────────────────────

export function findEmployee(id: string): Employee | null {
  return loadDirectory().employees.find((e) => e.id === id) ?? null;
}

export function findByApiKey(key: string): Employee | null {
  return loadDirectory().employees.find((e) => keyMatches(e.apiKey, key)) ?? null;
}

/**
 * Constant-time key comparison, over digests so length differences leak
 * nothing either. `===` short-circuits on the first differing byte, which is
 * measurable — and this string is the only credential on the proxy path.
 */
function keyMatches(stored: string, presented: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(stored).digest(),
    createHash('sha256').update(presented).digest()
  );
}

/**
 * Who is calling, from an `Authorization: Bearer …` header.
 *
 * The key is the whole identity. An employee does not send a name and does not
 * send a role — they do not need to know either, and anything they can type is
 * something they can change. The admin decides what a key means, and can change
 * the role behind it without the employee touching their machine.
 *
 * Returns null for a missing, malformed, or unrecognised key, and callers must
 * refuse rather than fall back to a default identity. A caller nobody can
 * identify is not a caller to guess about: an unknown actor allowed through
 * under some assumed role is exactly the hole this replaced.
 */
export function actorForCredential(authorization: string | undefined): Employee | null {
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization ?? '')?.[1]?.trim();
  if (!bearer) return null;
  try {
    return findByApiKey(bearer);
  } catch {
    // No directory on disk yet. Nobody is known, so nobody is admitted — the
    // safe direction, and it surfaces as a clear refusal rather than as a
    // gateway quietly admitting everyone.
    return null;
  }
}

/**
 * Add someone, or update them if the id already exists.
 *
 * The role is checked against the known list rather than accepted as typed. A
 * role that does not exist carries no quota and matches no role-scoped rule,
 * so a typo here would hand someone an unmetered, unguarded account — the
 * failure would look like nothing at all.
 */
export function upsertEmployee(input: {
  id?: string;
  name: string;
  role: string;
}): Employee {
  const dir = loadDirectory();
  // Control and format characters are stripped, not stored: the name is
  // interpolated into onboarding scripts and shell profiles, and a newline in
  // it would be executable there. Nothing legitimate is lost by removing them.
  const name = input.name.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  if (!name) throw new Error('name is required');

  const role = input.role.trim();
  if (!dir.roles.includes(role)) {
    throw new Error(`unknown role "${role}" — add the role first`);
  }

  const existing = input.id ? dir.employees.find((e) => e.id === input.id) : undefined;
  if (existing) {
    const updated: Employee = { ...existing, name, role };
    save({ ...dir, employees: dir.employees.map((e) => (e.id === existing.id ? updated : e)) });
    return updated;
  }

  const id = uniqueId(name, dir.employees.map((e) => e.id));
  const created: Employee = { id, name, role, apiKey: newApiKey(id) };
  save({ ...dir, employees: [...dir.employees, created] });
  return created;
}

/**
 * Remove someone, and report the rules that were written specifically for them.
 *
 * Those rules are not deleted here. Deleting policy as a side effect of a
 * personnel change is the kind of quiet action an audit log cannot explain
 * later, and the admin may well want to retarget the rule at their
 * replacement. They are returned so the console can say what is now dangling.
 */
export function removeEmployee(
  id: string,
  rules: { id: string; text: string; appliesTo: string[] }[] = []
): { removed: Employee | null; orphanedRules: { id: string; text: string }[] } {
  const dir = loadDirectory();
  const removed = dir.employees.find((e) => e.id === id) ?? null;
  if (!removed) return { removed: null, orphanedRules: [] };

  save({ ...dir, employees: dir.employees.filter((e) => e.id !== id) });

  const token = `@${id}`;
  const orphanedRules = rules
    .filter((r) => r.appliesTo.length === 1 && r.appliesTo[0] === token)
    .map((r) => ({ id: r.id, text: r.text }));
  return { removed, orphanedRules };
}

/** Issue a new key for someone, invalidating the old one. */
export function rotateApiKey(id: string): Employee | null {
  const dir = loadDirectory();
  const existing = dir.employees.find((e) => e.id === id);
  if (!existing) return null;
  const updated: Employee = { ...existing, apiKey: newApiKey(id) };
  save({ ...dir, employees: dir.employees.map((e) => (e.id === id ? updated : e)) });
  return updated;
}

// ── roles ──────────────────────────────────────────────────────────────────────

export function roles(): string[] {
  return loadDirectory().roles;
}

/**
 * Role names are lowercased and hyphenated on the way in, because they are
 * compared by string equality in three places — the quota lookup, the rule
 * audience, and the employee record. "Sales" and "sales" being different roles
 * would be a bug nobody could see in the console.
 */
export function normaliseRole(role: string): string {
  return role.trim().toLowerCase().replace(/\s+/g, '-');
}

/** Add a role, returning the directory and the normalised name it was given. */
export function addRole(role: string): { directory: Directory; role: string } {
  const dir = loadDirectory();
  const clean = normaliseRole(role);
  if (!clean) throw new Error('role name is required');
  if (dir.roles.includes(clean)) return { directory: dir, role: clean };
  return { directory: save({ ...dir, roles: [...dir.roles, clean] }), role: clean };
}

/**
 * Remove a role.
 *
 * Refused while anyone still holds it. Reassigning those people automatically
 * would be a guess about which role they belong in now, and getting that guess
 * wrong changes both the rules they are judged against and their daily quota.
 */
export function removeRole(role: string): Directory {
  const dir = loadDirectory();
  const holders = dir.employees.filter((e) => e.role === role);
  if (holders.length > 0) {
    throw new Error(
      `${holders.length} employee(s) still hold "${role}": ${holders.map((h) => h.name).join(', ')}`
    );
  }
  if (dir.roles.length <= 1) throw new Error('a company needs at least one role');
  return save({ ...dir, roles: dir.roles.filter((r) => r !== role) });
}

// ── helpers ────────────────────────────────────────────────────────────────────

/**
 * A readable id derived from the name, because it shows up in audit entries,
 * in `@token` rule audiences, and in the env var the employee sets on their own
 * machine. `emp_01H8...` would be correct and unusable.
 */
function uniqueId(name: string, taken: string[]): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .split(/\s+/)[0]
      ?.replace(/[^a-z0-9]/g, '') || 'user';

  if (!taken.includes(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base}-${randomBytes(3).toString('hex')}`;
}

/**
 * The key is the whole identity on the proxy path, so it carries real entropy:
 * 128 bits, not a short suffix someone could sweep. The id stays in the prefix
 * because an admin reading a config file needs to tell whose key they are
 * looking at without a lookup table.
 */
function newApiKey(id: string): string {
  return `wk-${id}-${randomBytes(16).toString('hex')}`;
}
