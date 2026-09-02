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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

const COMPANY_PATH = process.env['WARDEN_COMPANY_PATH'] ?? 'data/company.json';

/**
 * Fallback location of the shipped sample, and only a fallback.
 *
 * It is relative to the working directory, which is right for a checkout and
 * wrong for the desktop app: there the working directory is the user's data
 * folder and the seed is in the bundle, so this resolves to a file that does
 * not exist and "Load the sample company" answered "no sample company is
 * bundled with this build" on a build that bundles one. Callers that know where
 * the bundle is — the server, which has `ASSETS` — pass the path instead.
 */
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
  employees: z.array(employeeSchema),
  /**
   * True while this is still the shipped demo — a freight company nobody
   * installing Warden works at, and seven people who do not exist.
   *
   * The seed exists because an empty console teaches nobody what the product
   * does, and it is genuinely useful for that. What was wrong is that it
   * *asserted* the company: every install opened claiming to be Northwind
   * Logistics SA, and the console had no way to say otherwise. A default that
   * states a fact about the user which is false for every user is worse than
   * no default.
   *
   * So the seed now announces itself, and the console asks instead of
   * pretending. The flag clears the moment anyone names their company or
   * starts fresh, and it is absent from directories that were never seeded.
   */
  demo: z.boolean().optional(),
  /**
   * When somebody pressed the button that installs the sample, in epoch millis.
   *
   * It exists to tell two identical-looking files apart. Builds up to v0.1.5
   * seeded the sample directory on first read, so an install that was never
   * asked for anything still ended up on disk as Northwind Logistics SA — and
   * upgrading does not touch the data folder, so a person who installed an old
   * build and then updated kept being shown a freight company they had never
   * heard of. Deleting `demo: true` directories on sight would also delete the
   * sample somebody deliberately loaded a minute earlier, which is why the
   * distinction is a stamp rather than a guess: written only by
   * `loadSampleCompany()`, absent from every file an old build wrote by itself.
   *
   * `boot-migrations.ts` reads it, and only there.
   */
  sampleInstalledAt: z.number().optional()
});
export type Directory = z.infer<typeof directorySchema>;

const EMPTY: Directory = {
  name: '',
  description: '',
  roles: ['admin', 'employee'],
  employees: []
};

let cached: Directory | null = null;

/**
 * The directory as it stands. **A fresh install has none, and that is correct.**
 *
 * This used to seed itself from `data/seed/company.json` on first read, so
 * every install opened as Northwind Logistics SA with seven people who do not
 * exist. An earlier pass tried to soften that with a `demo: true` flag so the
 * console could "announce itself and ask instead of pretending" — and it still
 * put a freight company's name in the header of somebody else's product on the
 * very first screen they ever saw. A default that states a fact about the user
 * which is false for every user is worse than no default, which the comment on
 * that flag already said; the flag was the wrong conclusion to draw from it.
 *
 * So there is no seeding here any more. An install starts empty, the console's
 * empty states are the first thing an administrator sees, and the sample
 * company is a button they can press — `loadSampleCompany()` below. Nobody
 * gets handed a fictional payroll they then have to work out how to delete.
 */
export function loadDirectory(): Directory {
  if (cached) return cached;
  cached = readIfPresent(COMPANY_PATH) ?? EMPTY;
  return cached;
}

/**
 * Install the shipped sample company, on purpose, because somebody asked.
 *
 * This is what `loadDirectory` used to do silently on first read. It is worth
 * keeping — an empty console teaches nobody what the product does, and being
 * able to click through a populated one is genuinely how people evaluate this.
 * It is only ever reached by an explicit request.
 *
 * Every key is issued here and never shipped. The seed is a committed file in
 * a public repository, so a key written into it would be a published
 * credential: the same string would authenticate on every install that had not
 * rotated it. That is sharpest for the seeded admin, whose role sits in
 * `exemptRoles` and is therefore measured against no rules at all — a working
 * bypass, printed in the repo, for a product whose whole claim is that prompts
 * are judged. So the seed carries placeholders and this issues the real ones,
 * which also means no two installs share a key.
 */
export function loadSampleCompany(seedPath = SEED_PATH): Directory {
  const seeded = readIfPresent(seedPath);
  if (!seeded) throw new Error('no sample company is bundled with this build');

  const issued: Directory = {
    ...seeded,
    demo: true,
    // The stamp is what makes this survive an upgrade: see `sampleInstalledAt`
    // on the schema. A sample somebody asked for is theirs to keep; one an old
    // build installed on its own is not.
    sampleInstalledAt: Date.now(),
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

// ── employees ────────────────────────────────────────────────────────────────

export function findEmployee(id: string): Employee | null {
  return loadDirectory().employees.find((e) => e.id === id) ?? null;
}

export function findByApiKey(key: string): Employee | null {
  return loadDirectory().employees.find((e) => keyMatches(e.apiKey, key)) ?? null;
}

/**
 * The unguessable half of an onboarding link.
 *
 * The install route hands an employee their API key inside a shell script, so
 * the URL is a credential. Addressed by employee id it was a credential anyone
 * could guess: ids are people's first names, and `/install/ana` returned Ana's
 * key to whoever asked. That route cannot simply be closed — the employee runs
 * it from their own machine, before they have a key, which is the entire point
 * of it — so the address itself has to become the secret.
 *
 * Derived from the key rather than stored, which buys three things at once. It
 * survives a gateway restart, so a link sent on Friday still works on Monday.
 * It needs no store to expire, leak or fall out of sync. And rotating the key
 * invalidates every link ever issued for that person, which is exactly what
 * rotation is supposed to mean.
 *
 * Domain-separated so this digest can never be confused with the one
 * {@link keyMatches} compares, and truncated to 128 bits, which is far past
 * guessing and short enough to paste.
 */
export function installToken(employee: Employee): string {
  return createHash('sha256').update(`warden-install:${employee.apiKey}`).digest('hex').slice(0, 32);
}

/** The employee an install token belongs to, or null. */
export function findByInstallToken(token: string): Employee | null {
  if (!/^[0-9a-f]{32}$/.test(token)) return null;
  return (
    loadDirectory().employees.find((e) =>
      timingSafeEqual(Buffer.from(installToken(e), 'hex'), Buffer.from(token, 'hex'))
    ) ?? null
  );
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

/**
 * Rename the company.
 *
 * The seeded directory is a demo — "Northwind Logistics SA" with seven invented
 * people — and until this existed there was no way out of it from the console.
 * Someone who installed the app was looking at another company's name in their
 * own title bar with nothing to click, which reads like the product is stuck in
 * a demo because it was.
 */
export function renameCompany(name: string): Directory {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('the company needs a name');
  if (trimmed.length > 120) throw new Error('that name is too long');
  // Naming it is what makes it theirs, so the demo flag goes with the rename.
  const { demo: _was, ...rest } = loadDirectory();
  return save({ ...rest, name: trimmed });
}

/**
 * Clear the demo and keep the door open.
 *
 * Removes every seeded person and every role that came with them, leaving the
 * roles an empty policy still needs. It deliberately does not touch the policy
 * — rules and people are separate decisions, and someone starting fresh on
 * staff usually wants to keep the rules they have been reading.
 *
 * Keeps at least one administrator, because a directory with no exempt role is
 * a console nobody can get back into once `WARDEN_ADMIN_REQUIRE_KEY` is set.
 * The kept admin gets a fresh key: the point of starting over is that the
 * demo's credentials stop working.
 */
export function clearDemoDirectory(companyName?: string): Directory {
  const current = loadDirectory();
  const admin = current.employees.find((e) => e.role === 'admin');
  const kept = admin
    ? [{ ...admin, name: admin.name, apiKey: newApiKey(admin.id) }]
    : [];
  const { demo: _was, ...rest } = current;
  return save({
    ...rest,
    name: (companyName ?? current.name).trim() || current.name,
    roles: current.roles,
    employees: kept
  });
}

/**
 * Did somebody press the button that installs the sample?
 *
 * The stamp is written only by `loadSampleCompany()`, so this is the one thing
 * that distinguishes a sample a person asked for — theirs, never touched — from
 * one an old build wrote by itself on first read.
 */
export function sampleWasRequested(): boolean {
  return loadDirectory().sampleInstalledAt !== undefined;
}

/**
 * Remove the people who came out of the shipped sample, keeping everyone else.
 *
 * Per person rather than per roster, and that distinction cost a round: the
 * roster version removed the seven invented people only when the roster was
 * *identical* to ours, so an administrator who added one real teammate kept all
 * seven ghosts — one real person protecting seven fictional ones. The same
 * coupling that had already gone wrong one level up, in the policy.
 *
 * A person is removed when their id, name and role all match a person in the
 * seed. Keys are not compared: they are reissued on install, so no directory
 * would ever match on them. Anybody who does not match is untouched, which is
 * the whole point.
 *
 * If nothing is left, the file goes with them. If somebody is left, the company
 * name and the `demo` flag go instead — what remains is theirs, and it should
 * not still be sitting under a freight company's name they never typed.
 */
export function discardSeededPeople(seedPath = SEED_PATH, force = false): number {
  const current = loadDirectory();
  // The `demo` gate is evidence, and evidence is only needed when nobody asked.
  // An administrator pressing the button in the console has asked, and by then
  // the flag has usually been cleared anyway: naming your company clears it, so
  // the person most likely to want the ghosts gone is the person the gate would
  // refuse. `force` is that press, and nothing else sets it.
  if (!force && current.demo !== true) return 0;

  const seeded = readIfPresent(seedPath);
  if (!seeded) return 0;

  const key = (e: Employee): string => `${e.id}\u0000${e.name}\u0000${e.role}`;
  const shipped = new Set(seeded.employees.map(key));
  const kept = current.employees.filter((e) => !shipped.has(key(e)));
  const removed = current.employees.length - kept.length;
  if (removed === 0) return 0;

  if (kept.length === 0) {
    discardDirectory();
    return removed;
  }

  const { demo: _was, ...rest } = current;
  save({ ...rest, name: '', employees: kept });
  return removed;
}

/**
 * Remove the directory entirely, leaving the install with no company at all.
 *
 * Distinct from `clearDemoDirectory`, which keeps an admin so the console still
 * has somebody to be. This is for the boot migration, where the correct end
 * state is the one a fresh install has: nothing.
 */
export function discardDirectory(): void {
  cached = null;
  try {
    if (existsSync(COMPANY_PATH)) rmSync(COMPANY_PATH);
  } catch {
    /* a read-only data folder keeps the file; the cache reset still empties this process */
  }
}

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
