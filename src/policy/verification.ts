/**
 * The evidence that protection was ever real, kept across restarts.
 *
 * `activity.ts` remembers that a tool sent something; `devices.ts` remembers
 * what a machine said about its own wiring. Neither answers the question the
 * first-run flow has to answer before it says "your first protection is
 * working": did a real request from the tool this person connected reach
 * Warden, and did the rule they turned on decide it. A screen that claims
 * protection from wiring alone is claiming something nobody checked.
 *
 * ## Why this is a file and not another Map
 *
 * It was going to be one. The counters in `activity.ts` live in memory and say
 * so, honestly, because a liveness view that forgets is still a liveness view.
 * An onboarding that forgets is a different thing: restart the gateway and the
 * person is asked to set up a machine that is already set up. That is the bug
 * F5 fixed for Team by putting wiring on disk, and writing it again here would
 * be re-learning it.
 *
 * ## Two facts, and only one of them is erasable
 *
 * `completedAt` is "this installation finished the first run, once". It is
 * written with the first verification and never removed. `tools` is "this
 * tool's protection is verified right now", and it is withdrawn whenever the
 * ground under it moves — the active rule changes, the wiring is rewritten.
 * Collapsing the two would mean unwiring a tool in March sends you back
 * through the onboarding, which the design note (Figma 675:2068) rules out:
 * keep the configuration, withdraw the verification.
 *
 * ## What is not in here
 *
 * No prompt text, not even masked. `auditId` is the handle the audit log
 * already issues, and following it is how somebody sees what was blocked —
 * through `audit/prompts.ts`, which has an expiry, rather than through a file
 * that has none. The audit log stores hashes and not prompts on purpose, and a
 * store written to support a setup screen is not the place to walk that back.
 */
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Verdict } from '../guard/types.js';
import { atomicJSON } from '../models/store.js';

const VERIFIED_PATH = process.env['WARDEN_VERIFIED_PATH'] ?? 'data/verified.json';

/** One tool's proof: a real request from it, and what Warden decided. */
export const verifiedSchema = z.object({
  /** `claude-code`, `codex`, `opencode` — the same ids the wiring report uses. */
  tool: z.string().min(1).max(64),
  /** The audit handle, never the prompt. */
  auditId: z.string().min(1),
  verdict: z.enum(['ALLOW', 'ESCALATE', 'BLOCK']),
  /** The rules that fired. Empty is not a verification — see `recordVerified`. */
  ruleIds: z.array(z.string()),
  at: z.string(),
  /** Which policy was in force, so a later reader knows what was verified. */
  policyVersion: z.string()
});
export type Verified = z.infer<typeof verifiedSchema>;

const personSchema = z.object({
  /** Written once, with the first verification. Never cleared. */
  completedAt: z.string().optional(),
  tools: z.record(z.string(), verifiedSchema).default({})
});

/** employee id → what that person has verified. */
const storeSchema = z.record(z.string(), personSchema);
type VerificationStore = z.infer<typeof storeSchema>;

let cached: VerificationStore | null = null;

function load(): VerificationStore {
  if (cached) return cached;
  if (!existsSync(VERIFIED_PATH)) return (cached = {});
  try {
    cached = storeSchema.parse(JSON.parse(readFileSync(VERIFIED_PATH, 'utf8')));
  } catch {
    // Unlike the audit log, this is not a record anybody is accountable to:
    // it is what a setup screen reads. A file that will not parse is rebuilt
    // from the next real request rather than a reason to refuse to serve the
    // console. The cost of being wrong is one onboarding shown again.
    cached = {};
  }
  return cached;
}

function save(store: VerificationStore): void {
  cached = store;
  // 0600 and gitignored, like devices.json. It holds no prompt text, but it
  // does say which tools somebody uses and when they used them.
  atomicJSON(VERIFIED_PATH, store);
}

/** Only for tests, which swap `WARDEN_VERIFIED_PATH` between cases. */
export function forgetVerifications(): void {
  cached = null;
}

/**
 * A real request from a real tool, decided by a rule. The only writer.
 *
 * Three conditions, and all three are refusals to be generous:
 *
 * - **A tool has to be named.** `source` comes from the hook. Without it the
 *   request proves that something reached the gateway, which is not the claim
 *   the screen makes.
 * - **`ALLOW` does not verify.** It proves the path — tool reached Warden and
 *   got an answer — and proves nothing about the rule. The flow has a separate
 *   outcome for exactly this, and it does not complete.
 * - **No fired rules, no verification.** A decision the active rule had no part
 *   in cannot be evidence that the active rule works. This is the one that
 *   would quietly pass if somebody "simplified" the check to `verdict !==
 *   'ALLOW'`, because an ESCALATE can come from a quota or a tampering flag
 *   with no rule behind it.
 *
 * Returns whether anything was written, so the caller can tell a verification
 * from an ordinary decision without reading the file back.
 */
export function recordVerified(
  employeeId: string,
  entry: { tool?: string; auditId: string; verdict: Verdict; ruleIds: string[]; policyVersion: string }
): boolean {
  if (!employeeId || !entry.tool || entry.tool === 'unknown') return false;
  if (entry.verdict === 'ALLOW') return false;
  if (entry.ruleIds.length === 0) return false;

  const store = load();
  const now = new Date().toISOString();
  const person = store[employeeId] ?? { tools: {} };
  save({
    ...store,
    [employeeId]: {
      // The first one to arrive sets it, and nothing after that moves it. This
      // is what makes the onboarding a one-time event rather than a state the
      // screen keeps re-deriving.
      completedAt: person.completedAt ?? now,
      tools: {
        ...person.tools,
        [entry.tool]: {
          tool: entry.tool,
          auditId: entry.auditId,
          verdict: entry.verdict,
          ruleIds: entry.ruleIds,
          at: now,
          policyVersion: entry.policyVersion
        }
      }
    }
  });
  return true;
}

/**
 * The ground moved under a tool's proof, so the proof goes.
 *
 * Called when the active rule set changes (any of them: a preset toggled, a
 * rule written, a rule deleted) and when a tool's wiring is rewritten. It is
 * deliberately blunt — it does not try to work out whether the rule that
 * changed is the rule that fired. A verification is a claim about a specific
 * request under a specific policy; once the policy is not that one any more,
 * the honest answer is that nobody has checked yet.
 *
 * `completedAt` survives. Withdrawing a verification changes what This device
 * says; it does not reopen the first run.
 */
export function withdrawVerification(employeeId: string, tool?: string): void {
  const store = load();
  const person = store[employeeId];
  if (!person) return;
  const tools = tool
    ? Object.fromEntries(Object.entries(person.tools).filter(([id]) => id !== tool))
    : {};
  save({ ...store, [employeeId]: { ...person, tools } });
}

/** What this person has verified, by tool. */
export function verifiedFor(employeeId: string): Verified[] {
  return Object.values(load()[employeeId]?.tools ?? {}).sort((a, b) => b.at.localeCompare(a.at));
}

/** Whether this person ever finished the first run. Survives every withdrawal. */
export function completedFirstRun(employeeId: string): boolean {
  return Boolean(load()[employeeId]?.completedAt);
}
