/**
 * The audit trail: append-only JSONL, hash-chained.
 *
 * Each entry carries the hash of the one before it, so removing or editing a
 * past decision breaks every hash after it. That turns the log from "records we
 * kept" into "records we can prove were not altered" — which is the difference
 * between a feature and an audit trail.
 *
 * Prompts are stored as hashes, not text. The log is a governance record, not a
 * second copy of everything employees typed; the decision, the rules that fired
 * and the timing are what an auditor needs, and keeping the raw text would make
 * the log itself the largest data-exposure risk in the system.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Decision } from '../guard/types.js';
import type { AuditEntry } from '../guard/types-audit.js';

const AUDIT_PATH = process.env['WARDEN_AUDIT_PATH'] ?? 'data/audit.jsonl';

const GENESIS = '0'.repeat(64);
let lastHash: string | null = null;

function tailHash(): string {
  if (lastHash) return lastHash;
  if (!existsSync(AUDIT_PATH)) return (lastHash = GENESIS);

  const lines = readFileSync(AUDIT_PATH, 'utf8').trimEnd().split('\n').filter(Boolean);
  const last = lines.at(-1);
  if (!last) return (lastHash = GENESIS);
  try {
    lastHash = (JSON.parse(last) as AuditEntry).entryHash;
  } catch {
    lastHash = GENESIS;
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

  const body = {
    auditId,
    ts: new Date().toISOString(),
    actor,
    promptHash: createHash('sha256').update(prompt).digest('hex'),
    decision: { ...decision, auditId } as Decision,
    prevHash
  };

  const entry: AuditEntry = {
    ...body,
    entryHash: createHash('sha256').update(prevHash + JSON.stringify(body)).digest('hex')
  };

  mkdirSync(dirname(AUDIT_PATH), { recursive: true });
  appendFileSync(AUDIT_PATH, JSON.stringify(entry) + '\n');
  lastHash = entry.entryHash;
  return entry;
}

/** Most recent entries, newest first. */
export async function readAudit(limit = 50): Promise<AuditEntry[]> {
  if (!existsSync(AUDIT_PATH)) return [];
  return readFileSync(AUDIT_PATH, 'utf8')
    .trimEnd().split('\n').filter(Boolean)
    .slice(-limit)
    .map((l) => JSON.parse(l) as AuditEntry)
    .reverse();
}

/**
 * Recompute the chain and report the first entry that does not match.
 *
 * Exposed because a tamper-evident log is only evidence if someone can check
 * it; `npm run verify-audit` runs this.
 */
export function verifyChain(): { ok: boolean; entries: number; brokenAt?: number } {
  if (!existsSync(AUDIT_PATH)) return { ok: true, entries: 0 };

  const lines = readFileSync(AUDIT_PATH, 'utf8').trimEnd().split('\n').filter(Boolean);
  let prev = GENESIS;

  for (let i = 0; i < lines.length; i++) {
    const entry = JSON.parse(lines[i]!) as AuditEntry;
    const { entryHash, ...body } = entry;
    const expected = createHash('sha256').update(prev + JSON.stringify(body)).digest('hex');
    if (entry.prevHash !== prev || entryHash !== expected) {
      return { ok: false, entries: lines.length, brokenAt: i };
    }
    prev = entryHash;
  }

  return { ok: true, entries: lines.length };
}

/** Drop the cached tail hash. Tests write the file directly. */
export function invalidateAudit(): void {
  lastHash = null;
}
