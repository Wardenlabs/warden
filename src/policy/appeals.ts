/**
 * "This block was wrong" — the employee's side of the loop.
 *
 * Every refusal already ends with `Audit a7f3c2 · quote this if you think it is
 * wrong`, and until now there was nowhere to quote it: the promise was in the
 * UI with nothing behind it. This is the nothing, filled in.
 *
 * It matters more than a complaints box. The measured false-positive rate on
 * legitimate traffic is high enough that a real share of blocks are wrong, and
 * the admin cannot find them from the audit log alone — a correct block and an
 * incorrect one are the same record. The person who was stopped is the only one
 * who knows which they got, and the rule that fired is exactly the object the
 * admin has to go and fix. So an appeal carries the audit id, and the console
 * joins it back to the rule.
 *
 * **Not written into the audit log.** That file is a hash chain of decisions,
 * and appending something that is not a decision would break the shape
 * `verifyChain()` walks. Appeals live beside it, in their own file, and the
 * audit chain stays exactly as verifiable as it was.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const APPEALS_PATH = process.env['WARDEN_APPEALS_PATH'] ?? 'data/appeals.jsonl';

/**
 * Longest note kept.
 *
 * Long enough for "this was for the quarterly report, I wasn't asking about a
 * person", which is the whole genre. Anything past it is truncated rather than
 * refused — an employee who was already stopped once should not be stopped
 * twice for over-explaining.
 */
const MAX_NOTE_CHARS = 500;

export type Appeal = {
  /** The decision being appealed. The join key to the audit log. */
  auditId: string;
  employeeId: string;
  at: string;
  /**
   * What the employee says about it, in their own words.
   *
   * This is the only place in Warden where text an employee typed is persisted
   * — the audit log deliberately keeps a hash of the prompt and not the prompt.
   * They are choosing to say this, about their own request, so that it can be
   * read by an admin; nothing is copied here on their behalf. It is stored
   * verbatim, never enters a model prompt, and is escaped where it is rendered.
   */
  note?: string;
};

/**
 * File an appeal. Returns the stored record, or null when this decision has
 * already been appealed by this person.
 *
 * One per person per decision, so a button pressed twice does not read as two
 * people disagreeing — the count is what an admin scans, and it has to mean
 * something.
 */
export function recordAppeal(appeal: {
  auditId: string;
  employeeId: string;
  note?: string;
}): Appeal | null {
  const existing = readAppeals();
  if (existing.some((a) => a.auditId === appeal.auditId && a.employeeId === appeal.employeeId)) {
    return null;
  }

  const note = appeal.note?.trim().slice(0, MAX_NOTE_CHARS);
  const entry: Appeal = {
    auditId: appeal.auditId,
    employeeId: appeal.employeeId,
    at: new Date().toISOString(),
    ...(note ? { note } : {})
  };

  mkdirSync(dirname(APPEALS_PATH), { recursive: true });
  appendFileSync(APPEALS_PATH, JSON.stringify(entry) + '\n');
  return entry;
}

/** Appeals, newest first. */
export function readAppeals(limit = 100): Appeal[] {
  if (!existsSync(APPEALS_PATH)) return [];
  return readFileSync(APPEALS_PATH, 'utf8')
    .trimEnd()
    .split('\n')
    .filter(Boolean)
    // One unparseable line is a damaged record, not a reason to hide the rest.
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Appeal];
      } catch {
        return [];
      }
    })
    .slice(-limit)
    .reverse();
}
