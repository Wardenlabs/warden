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
 *
 * On disk I/O, because this file used to be where all of it went. Every reader
 * here — the console's list, the escalation queue, an appeal looking up its
 * decision — read and parsed the whole file from the first byte, and the
 * console asks for the head of the log and a chain verification after every
 * single decision. So each decision cost one line appended and the entire log
 * read twice, per open console: the read traffic grew with the square of the
 * log's length, and a gateway that had been running for a few weeks spent more
 * of its disk budget re-reading its own history than judging prompts. The log
 * is now parsed once and kept in memory, the writer keeps that copy current
 * because it is the only writer, and verification re-reads only what was
 * appended since it last looked — see `verifyChain` for the one window that
 * opens and how it is closed.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync
} from 'node:fs';
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
type Entry = AuditEntry | AdminAuditEntry;

const GENESIS = '0'.repeat(64);

/**
 * The log as this process last saw it, keyed to the file's size.
 *
 * `bytes` is the size the cache corresponds to. Every reader compares it to a
 * `stat` before trusting the cache — one inode read rather than the file — so
 * a log that changed underneath the process (a script pointed at the same path,
 * a restore from backup, a test that writes the file directly) is re-read
 * rather than served stale. The writer keeps the number current by adding the
 * length of what it appended, which is the same size the next `stat` returns.
 *
 * `lines` counts what is on disk, damaged lines included, because that is what
 * the witness records and what `verifyChain` will find; `entries` holds only
 * what parsed. `head` is the hash of the final line, or null when that line
 * could not be parsed — the state in which appending must refuse rather than
 * quietly fork a second chain on top of the corruption.
 */
type Cache = { bytes: number; entries: Entry[]; lines: number; head: string | null };

let cache: Cache | null = null;

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function load(): Cache {
  const size = fileSize(AUDIT_PATH);
  if (cache && cache.bytes === size) return cache;

  const raw = size > 0 ? readFileSync(AUDIT_PATH, 'utf8') : '';
  const rows = raw.trimEnd().split('\n').filter(Boolean);
  const entries: Entry[] = [];
  let head: string | null = rows.length ? null : GENESIS;
  for (let i = 0; i < rows.length; i++) {
    try {
      const entry = JSON.parse(rows[i]!) as Entry;
      entries.push(entry);
      // Only the final line decides whether the chain can be extended. A
      // damaged line in the middle is a verification finding and is skipped
      // here the way `findDecision` always skipped it.
      if (i === rows.length - 1) head = entry.entryHash;
    } catch {
      if (i === rows.length - 1) head = null;
    }
  }
  cache = { bytes: size, entries, lines: rows.length, head };
  return cache;
}

function readWitness(): Witness | null {
  if (!existsSync(WITNESS_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(WITNESS_PATH, 'utf8')) as Witness;
    return typeof parsed.entries === 'number' && typeof parsed.head === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function tailHash(): string {
  const head = load().head;
  if (head === null) {
    // Restarting from GENESIS here would quietly fork a second chain on top of
    // a corrupt one — the writer would be papering over exactly the state the
    // verifier exists to catch. Refuse to append instead.
    throw new Error(
      `audit log at ${AUDIT_PATH} has an unparseable final entry — run \`pnpm run verify-audit\` and repair it before recording new decisions`
    );
  }
  return head;
}

/**
 * Append one entry and bring the cache and the witness along with it.
 *
 * The witness is written after the entry, never before: a witness claiming an
 * entry that was not appended would report tampering on a log that is merely
 * mid-write. The cache is updated from what was written rather than re-read,
 * which is the whole point — and if the append only half landed, the size it
 * predicts will not match the next `stat` and the next reader reloads.
 */
function append(entry: Entry): void {
  const current = load();
  const line = JSON.stringify(entry) + '\n';
  mkdirSync(dirname(AUDIT_PATH), { recursive: true });
  appendFileSync(AUDIT_PATH, line);
  current.entries.push(entry);
  current.lines += 1;
  current.head = entry.entryHash;
  current.bytes += Buffer.byteLength(line);
  writeFileSync(WITNESS_PATH, JSON.stringify({ entries: current.lines, head: entry.entryHash }) + '\n');
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

  append(entry);
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
  append(entry);
  return entry;
}

const isAdmin = (e: Entry): e is AdminAuditEntry => 'kind' in e && e.kind === 'admin';

/**
 * The newest entries of one kind, newest first.
 *
 * Filtered while walking back from the tail rather than by slicing the tail
 * first: the two kinds are interleaved, so "the last 50 lines" is not "the last
 * 50 decisions" and a busy afternoon of policy edits would push real decisions
 * out of the console's list without anybody noticing they had gone. Walking
 * back also means the cost is the answer's size, not the log's.
 */
function newest<T extends Entry>(limit: number, keep: (e: Entry) => e is T): T[] {
  const { entries } = load();
  const out: T[] = [];
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
    const entry = entries[i]!;
    if (keep(entry)) out.push(entry);
  }
  return out;
}

/** Administrative changes, newest first. */
export async function readAdminActions(limit = 50): Promise<AdminAuditEntry[]> {
  return newest(limit, isAdmin);
}

/** Most recent entries, newest first. */
export async function readAudit(limit = 50): Promise<AuditEntry[]> {
  return newest(limit, (e): e is AuditEntry => !isAdmin(e));
}

/**
 * One entry by its audit id, or null.
 *
 * The id is the only handle an employee is given — it is printed on every
 * refusal — so anything that answers a question about a past decision (an
 * appeal, a rewrite request) has to start by finding it. Walks the whole log
 * rather than a tail: a decision from last week is exactly the one somebody is
 * still arguing about, and a silent "only the last N" window would refuse it
 * while looking like the id was invalid.
 */
export function findDecision(auditId: string): AuditEntry | null {
  if (!auditId) return null;
  const { entries } = load();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    // Administrative entries carry ids from the same generator, and every
    // caller here is answering a question about a decision — an appeal, a
    // rewrite. Handing one an admin entry would give it an object with no
    // verdict and no rules, which fails somewhere further away than here.
    if (entry.auditId === auditId && !isAdmin(entry)) return entry;
  }
  return null;
}

/**
 * How far verification has walked, so the next call can start there.
 *
 * `bytes` always ends on a newline: a trailing partial line is checked for the
 * result but never checkpointed, so the full walk and the incremental one read
 * the same line boundaries and cannot disagree about where an entry starts.
 * `at` is when the last *full* walk happened — an incremental pass does not
 * move it, which is what makes the full walk recur on schedule.
 */
type Verified = { bytes: number; count: number; head: string; at: number };

let verified: Verified | null = null;

/**
 * How long the verifier trusts a prefix it has already walked.
 *
 * Walking the tail only is exact for everything the chain is built to catch —
 * an appended line that does not follow from the last, a line removed from
 * the end — because both change the file's length, and a shorter file always
 * forces a full walk. What it cannot see is an edit inside the already-walked
 * prefix that keeps the byte length identical. That edit is caught by the
 * next full walk, which this bounds to a minute; `pnpm run verify-audit`
 * always walks everything, and that command, not the console badge, is the
 * evidence claim. A minute rather than never because the badge would
 * otherwise be a statement about the past; a minute rather than seconds
 * because a full walk of a long log after every decision is precisely the
 * cost this exists to remove.
 */
const FULL_WALK_MS = 60_000;

function readRange(path: string, start: number, end: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(Math.max(end - start, 0));
    let offset = 0;
    while (offset < buf.length) {
      const n = readSync(fd, buf, offset, buf.length - offset, start + offset);
      if (n === 0) break;
      offset += n;
    }
    return buf.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
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
 * it; `pnpm run verify-audit` runs this with `full`, which walks from the
 * first byte regardless of what was walked before. Without it, a prefix walked
 * inside the last minute is trusted and only the bytes appended since are
 * read — see `FULL_WALK_MS` for what that trades.
 */
export function verifyChain(options: { full?: boolean } = {}): {
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
    verified = null;
    // A missing log with a witness that counted entries is a deleted log, not
    // an empty one. Reporting "intact — 0 entries" for that was the loudest
    // version of the same blind spot.
    if (witness && witness.entries > 0) {
      return { ok: false, entries: 0, missing: witness.entries };
    }
    return { ok: true, entries: 0, ...(witness ? {} : { unwitnessed: true }) };
  }

  const size = fileSize(AUDIT_PATH);
  const resume =
    !options.full &&
    verified !== null &&
    size >= verified.bytes &&
    Date.now() - verified.at < FULL_WALK_MS
      ? verified
      : null;

  let prev = resume?.head ?? GENESIS;
  let count = resume?.count ?? 0;
  const start = resume?.bytes ?? 0;
  const chunk = readRange(AUDIT_PATH, start, size);

  // Checkpoint only whole lines. Whatever follows the last newline is verified
  // below as part of this answer, and read again next time together with
  // whatever gets appended after it.
  const lastNewline = chunk.lastIndexOf(10);
  const whole = chunk.subarray(0, lastNewline + 1).toString('utf8');
  const partial = chunk.subarray(lastNewline + 1).toString('utf8').trim();

  const check = (line: string): boolean => {
    // A line that no longer parses is the most ordinary way to tamper with a
    // JSONL file, so it is a verification finding, not a crash.
    let entry: AuditEntry;
    try {
      entry = JSON.parse(line) as AuditEntry;
    } catch {
      return false;
    }
    const { entryHash, ...body } = entry;
    const expected = createHash('sha256').update(prev + JSON.stringify(body)).digest('hex');
    if (entry.prevHash !== prev || entryHash !== expected) return false;
    prev = entryHash;
    return true;
  };

  const lines = whole.split('\n').filter((l) => l.trim());
  const total = count + lines.length + (partial ? 1 : 0);
  for (const line of lines) {
    if (!check(line)) {
      verified = null;
      return { ok: false, entries: total, brokenAt: count };
    }
    count += 1;
  }
  verified = {
    bytes: start + lastNewline + 1,
    count,
    head: prev,
    at: resume ? resume.at : Date.now()
  };
  if (partial && !check(partial)) {
    return { ok: false, entries: total, brokenAt: count };
  }

  // The chain is internally sound. Is all of it still here?
  if (!witness) return { ok: true, entries: total, unwitnessed: true };
  if (total < witness.entries || prev !== witness.head) {
    return {
      ok: false,
      entries: total,
      missing: Math.max(witness.entries - total, 0)
    };
  }

  return { ok: true, entries: total };
}

/** Drop everything cached about the file. Tests write it directly. */
export function invalidateAudit(): void {
  cache = null;
  verified = null;
}
