/**
 * The audit trail: append-only JSONL, hash-chained, with a length beside it.
 *
 * Each entry carries the hash of the one before it, so editing a past decision
 * breaks every hash after it. That covers alteration and not removal: a chain
 * with its last entries deleted is shorter and still perfect, and those are the
 * entries worth deleting. The witness file holds the count, which is what turns
 * "records we can prove were not edited" into "records we can prove are all
 * here" — see the note on WITNESS_PATH for what that does and does not defend
 * against.
 *
 * Prompts are stored as hashes, not text. The log is a governance record, not a
 * second copy of everything employees typed; the decision, the rules that fired
 * and the timing are what an auditor needs, and keeping the raw text would make
 * the log itself the largest data-exposure risk in the system.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Decision } from '../guard/types.js';
import type { AdminAuditEntry, AuditedDecision, AuditEntry } from '../guard/types-audit.js';

const AUDIT_PATH = process.env['WARDEN_AUDIT_PATH'] ?? 'data/audit.jsonl';

/**
 * Where the length of the chain is remembered, next to the chain itself.
 *
 * The hashes prove that what is *present* was not edited, and say nothing about
 * what is absent: deleting the last few lines leaves a shorter, perfectly valid
 * chain, and those are exactly the lines someone would remove. Verification
 * needs a count from outside the file to notice.
 *
 * This is a witness, not a vault. Anyone who can truncate the log can also
 * rewrite this file, so it raises truncation from "invisible" to "you must
 * tamper consistently in two places" — which catches an accident, a partial
 * copy, and a naive edit, and does not stop an attacker with write access. The
 * honest fix for that is a witness Warden does not own; this is the version
 * that fits on one machine.
 */
const WITNESS_PATH = `${AUDIT_PATH.replace(/\.jsonl$/, '')}.witness.json`;

type Witness = { entries: number; head: string };

const GENESIS = '0'.repeat(64);
let lastHash: string | null = null;
let entryCount: number | null = null;

function readWitness(): Witness | null {
  if (!existsSync(WITNESS_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(WITNESS_PATH, 'utf8')) as Witness;
    return typeof parsed.entries === 'number' && typeof parsed.head === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** How many entries the log currently holds, counted once and then tracked. */
function currentCount(): number {
  if (entryCount !== null) return entryCount;
  if (!existsSync(AUDIT_PATH)) return (entryCount = 0);
  entryCount = readFileSync(AUDIT_PATH, 'utf8').trimEnd().split('\n').filter(Boolean).length;
  return entryCount;
}

function tailHash(): string {
  if (lastHash) return lastHash;
  if (!existsSync(AUDIT_PATH)) return (lastHash = GENESIS);

  const lines = readFileSync(AUDIT_PATH, 'utf8').trimEnd().split('\n').filter(Boolean);
  const last = lines.at(-1);
  if (!last) return (lastHash = GENESIS);
  try {
    lastHash = (JSON.parse(last) as AuditEntry).entryHash;
  } catch {
    // Restarting from GENESIS here would quietly fork a second chain on top of
    // a corrupt one — the writer would be papering over exactly the state the
    // verifier exists to catch. Refuse to append instead.
    throw new Error(
      `audit log at ${AUDIT_PATH} has an unparseable final entry — run \`pnpm run verify-audit\` and repair it before recording new decisions`
    );
  }
  return lastHash ?? GENESIS;
}

/** Record a decision. Returns the audit id quoted back to the employee. */
export function recordDecision(
  actor: { id: string; role: string },
  prompt: string,
  decision: Omit<Decision, 'auditId'>
): AuditEntry {
  const prevHash = tailHash();
  const auditId = randomUUID().slice(0, 8);

  // The prompt is persisted as a hash and nothing else. The live decision the
  // caller holds keeps `maskedPrompt` — the console's live trace and the proxy
  // forward both need it — but writing it here would make the log a transcript
  // of everything employees typed, which its own header promises it is not.
  const { maskedPrompt: _neverPersisted, ...audited } = { ...decision, auditId };

  const body = {
    auditId,
    ts: new Date().toISOString(),
    actor,
    promptHash: createHash('sha256').update(prompt).digest('hex'),
    decision: audited as AuditedDecision,
    prevHash
  };

  const entry: AuditEntry = {
    ...body,
    entryHash: createHash('sha256').update(prevHash + JSON.stringify(body)).digest('hex')
  };

  // Counted before the append, or the new line gets counted twice: the read
  // inside `currentCount()` would already see it.
  const nextCount = currentCount() + 1;

  mkdirSync(dirname(AUDIT_PATH), { recursive: true });
  appendFileSync(AUDIT_PATH, JSON.stringify(entry) + '\n');
  lastHash = entry.entryHash;
  entryCount = nextCount;
  // Written after the entry, never before: a witness claiming an entry that was
  // not appended would report tampering on a log that is merely mid-write.
  writeFileSync(WITNESS_PATH, JSON.stringify({ entries: nextCount, head: entry.entryHash }) + '\n');
  return entry;
}

/**
 * Record an administrative change in the same chain as the decisions.
 *
 * Deliberately the same append and the same hashing as `recordDecision`, so
 * `verifyChain` covers both without knowing there are two kinds — it rebuilds
 * each entry's hash from whatever fields the entry has.
 */
export function recordAdminAction(
  actor: { id: string; role: string },
  action: string,
  status: number
): AdminAuditEntry {
  const prevHash = tailHash();
  const body = {
    auditId: randomUUID().slice(0, 8),
    ts: new Date().toISOString(),
    actor,
    kind: 'admin' as const,
    action,
    status,
    prevHash
  };
  const entry: AdminAuditEntry = {
    ...body,
    entryHash: createHash('sha256').update(prevHash + JSON.stringify(body)).digest('hex')
  };
  const nextCount = currentCount() + 1;
  mkdirSync(dirname(AUDIT_PATH), { recursive: true });
  appendFileSync(AUDIT_PATH, JSON.stringify(entry) + '\n');
  lastHash = entry.entryHash;
  entryCount = nextCount;
  writeFileSync(WITNESS_PATH, JSON.stringify({ entries: nextCount, head: entry.entryHash }) + '\n');
  return entry;
}

/**
 * Every line in the file, newest first, whichever kind it is.
 *
 * Both readers below filter this rather than slicing the tail first: the two
 * kinds are interleaved, so "the last 50 lines" is not "the last 50 decisions"
 * and a busy afternoon of policy edits would push real decisions out of the
 * console's list without anybody noticing they had gone.
 */
function chain(): Array<AuditEntry | AdminAuditEntry> {
  if (!existsSync(AUDIT_PATH)) return [];
  return readFileSync(AUDIT_PATH, 'utf8')
    .trimEnd().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as AuditEntry | AdminAuditEntry)
    .reverse();
}

const isAdmin = (e: AuditEntry | AdminAuditEntry): e is AdminAuditEntry =>
  'kind' in e && e.kind === 'admin';

/** Administrative changes, newest first. */
export async function readAdminActions(limit = 50): Promise<AdminAuditEntry[]> {
  return chain().filter(isAdmin).slice(0, limit);
}

/** Most recent entries, newest first. */
export async function readAudit(limit = 50): Promise<AuditEntry[]> {
  return chain().filter((e): e is AuditEntry => !isAdmin(e)).slice(0, limit);
}

/**
 * One entry by its audit id, or null.
 *
 * The id is the only handle an employee is given — it is printed on every
 * refusal — so anything that answers a question about a past decision (an
 * appeal, a rewrite request) has to start by finding it. Scans the file rather
 * than reading a tail: a decision from last week is exactly the one somebody is
 * still arguing about, and a silent "only the last N" window would refuse it
 * while looking like the id was invalid.
 */
export function findDecision(auditId: string): AuditEntry | null {
  if (!auditId || !existsSync(AUDIT_PATH)) return null;
  const lines = readFileSync(AUDIT_PATH, 'utf8').trimEnd().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]!) as AuditEntry | AdminAuditEntry;
      // Administrative entries carry ids from the same generator, and every
      // caller here is answering a question about a decision — an appeal, a
      // rewrite. Handing one an admin entry would give it an object with no
      // verdict and no rules, which fails somewhere further away than here.
      if (entry.auditId === auditId && !isAdmin(entry)) return entry;
    } catch {
      // A damaged line is a verification finding, not a reason to stop looking.
    }
  }
  return null;
}

/**
 * Recompute the chain and report the first entry that does not match, then
 * check the log is as long as it should be.
 *
 * The second half is the part the hashes cannot do. Walking the chain proves
 * every entry still present follows from the one before it; removing the last
 * few entries leaves a shorter chain that is internally perfect, and those are
 * precisely the entries someone would remove. Measured before this existed:
 * deleting the final two lines of a five-entry log reported "intact — 3
 * entries". The witness file is what makes the missing two visible.
 *
 * Exposed because a tamper-evident log is only evidence if someone can check
 * it; `pnpm run verify-audit` runs this.
 */
export function verifyChain(): {
  ok: boolean;
  entries: number;
  brokenAt?: number;
  /** Entries the witness recorded but the log no longer holds. */
  missing?: number;
  /** No witness to compare against, so completeness is unproven either way. */
  unwitnessed?: boolean;
} {
  const witness = readWitness();

  if (!existsSync(AUDIT_PATH)) {
    // A missing log with a witness that counted entries is a deleted log, not
    // an empty one. Reporting "intact — 0 entries" for that was the loudest
    // version of the same blind spot.
    if (witness && witness.entries > 0) {
      return { ok: false, entries: 0, missing: witness.entries };
    }
    return { ok: true, entries: 0, ...(witness ? {} : { unwitnessed: true }) };
  }

  const lines = readFileSync(AUDIT_PATH, 'utf8').trimEnd().split('\n').filter(Boolean);
  let prev = GENESIS;

  for (let i = 0; i < lines.length; i++) {
    // A line that no longer parses is the most ordinary way to tamper with a
    // JSONL file, so it is a verification finding, not a crash.
    let entry: AuditEntry;
    try {
      entry = JSON.parse(lines[i]!) as AuditEntry;
    } catch {
      return { ok: false, entries: lines.length, brokenAt: i };
    }
    const { entryHash, ...body } = entry;
    const expected = createHash('sha256').update(prev + JSON.stringify(body)).digest('hex');
    if (entry.prevHash !== prev || entryHash !== expected) {
      return { ok: false, entries: lines.length, brokenAt: i };
    }
    prev = entryHash;
  }

  // The chain is internally sound. Is all of it still here?
  if (!witness) return { ok: true, entries: lines.length, unwitnessed: true };
  if (lines.length < witness.entries || prev !== witness.head) {
    return {
      ok: false,
      entries: lines.length,
      missing: Math.max(witness.entries - lines.length, 0)
    };
  }

  return { ok: true, entries: lines.length };
}

/** Drop the cached tail hash and count. Tests write the file directly. */
export function invalidateAudit(): void {
  lastHash = null;
  entryCount = null;
}
