/**
 * The queue `ESCALATE` always claimed to have.
 *
 * Half the severity model routes here. `aggregate()` tells the employee "held
 * for an administrator to review — you have not been refused, just queued", the
 * hook says "queued for an administrator", the proxy answers `202` with an
 * `escalationId` — and until this file existed `/api/escalations` returned an
 * empty array and nothing on earth wrote to it. Two of the eight rules in the
 * demo policy are `escalate`. They ended nowhere.
 *
 * **What a review does, and what it does not.** It records the administrator's
 * answer against the decision, and that answer is a governance record and a
 * message back to the person. It does **not** retroactively release the prompt:
 * the hook returned seconds after the employee pressed Enter and their tool has
 * long moved on, so there is nothing left to resume. An approved escalation
 * means "ask it again, it will go through on its merits" — and the second ask
 * is judged like any other, because the alternative is a decision the pipeline
 * is told to honour without judging, which is the early-ALLOW this whole design
 * forbids.
 *
 * Saying that plainly costs nothing and is the difference between a queue and
 * the second empty promise stacked on the first.
 *
 * **There is no reviewer name in the record.** The console has no login — the
 * README calls that the largest gap in the system — so a name here would be a
 * claim nothing checks. When an admin credential exists, this is where it goes.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readAudit } from '../audit/log.js';
import { readAppeals } from './appeals.js';

const REVIEWS_PATH = process.env['WARDEN_ESCALATIONS_PATH'] ?? 'data/escalations.jsonl';

/** How far back the queue looks. Beyond this, an escalation is history. */
const QUEUE_DEPTH = 500;

const MAX_NOTE_CHARS = 500;

export type ReviewOutcome = 'approved' | 'refused';

export type Review = {
  auditId: string;
  at: string;
  outcome: ReviewOutcome;
  /** The administrator's reasoning, for the employee and for whoever audits this. */
  note?: string;
};

/** One held decision, with everything a person needs to answer it. */
export type Escalation = {
  auditId: string;
  at: string;
  employeeId: string;
  role: string;
  ruleId: string | null;
  ruleText: string | null;
  /** What the employee added themselves, if anything. */
  employeeNote?: string;
  review: Review | null;
};

/**
 * Record an administrator's answer. Returns null if this one was already
 * answered — a queue where the same item can be resolved twice is a queue whose
 * count means nothing.
 */
export function recordReview(review: {
  auditId: string;
  outcome: ReviewOutcome;
  note?: string;
}): Review | null {
  if (readReviews().some((r) => r.auditId === review.auditId)) return null;

  const note = review.note?.trim().slice(0, MAX_NOTE_CHARS);
  const entry: Review = {
    auditId: review.auditId,
    at: new Date().toISOString(),
    outcome: review.outcome,
    ...(note ? { note } : {})
  };

  mkdirSync(dirname(REVIEWS_PATH), { recursive: true });
  appendFileSync(REVIEWS_PATH, JSON.stringify(entry) + '\n');
  return entry;
}

export function readReviews(): Review[] {
  if (!existsSync(REVIEWS_PATH)) return [];
  return readFileSync(REVIEWS_PATH, 'utf8')
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Review];
      } catch {
        return [];
      }
    });
}

/**
 * Everything held for review, newest first.
 *
 * Derived from the audit log rather than stored twice. Every escalation is
 * already a decision in the chain, and a second copy is a second thing to keep
 * in sync — one that could disagree with the record it was copied from, which
 * for a governance queue is the worst available bug. What is stored separately
 * is only what the log cannot hold: the administrator's answer, which is not a
 * decision and would not fit the shape `verifyChain()` walks.
 *
 * The prompt is not here and cannot be: the log keeps its hash. An admin sees
 * who, when, and which rule — and whatever the employee chose to write about
 * it, which is the one path by which their own words reach this screen.
 */
export async function escalationQueue(): Promise<Escalation[]> {
  const reviews = new Map(readReviews().map((r) => [r.auditId, r]));
  const notes = new Map(readAppeals(QUEUE_DEPTH).map((a) => [a.auditId, a.note]));

  return (await readAudit(QUEUE_DEPTH))
    .filter((entry) => entry.decision.verdict === 'ESCALATE')
    .map((entry) => {
      const rule = entry.decision.firedRules?.[0];
      const employeeNote = notes.get(entry.auditId);
      return {
        auditId: entry.auditId,
        at: entry.ts,
        employeeId: entry.actor.id,
        role: entry.actor.role,
        ruleId: rule?.ruleId ?? null,
        ruleText: rule?.ruleText ?? null,
        ...(employeeNote ? { employeeNote } : {}),
        review: reviews.get(entry.auditId) ?? null
      };
    });
}

/** How many are still waiting on a person. The number the console badges. */
export async function pendingCount(): Promise<number> {
  return (await escalationQueue()).filter((e) => e.review === null).length;
}
