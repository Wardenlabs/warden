/**
 * "Propose a prompt that would go through" — after the refusal, never inside it.
 *
 * A block that only says no is a dead end. The person is holding a real task,
 * and with false positives where they currently sit, a good share of those dead
 * ends are honest work. So Warden can offer them a version of their own request
 * that stays inside the rule.
 *
 * Two things about where this lives are load-bearing.
 *
 * **It is not a pass.** Nothing here runs during a decision. `Decision` still
 * contains no generated text, the refusal is still composed in code from the
 * ratified rule, and the measured 16/16 false positives that came from asking
 * the adjudicator for prose stay fixed. This runs only when the employee asks
 * for it, after the verdict already exists and is already in the audit log.
 *
 * **A machine that rewrites blocked prompts until they pass is an evasion
 * oracle.** That is the honest description of the risk, and no wording in the
 * prompt below defends against it. What defends against it is structural, and
 * most of it lives in the caller (`/api/guard/rewrite`): a rewrite is bound by
 * hash to a block that actually happened, there is exactly one per block so
 * nobody can iterate toward a phrasing that lands, it costs quota, and it is
 * audited. This module owns the last two: it refuses outright when the original
 * prompt was aimed at the instruction layer, and it re-judges its own
 * suggestion through the full guard, returning nothing unless that comes back
 * ALLOW. The suggestion is verified, not asserted.
 */
import { z } from 'zod';
import type { PolicySpec, Rule } from '../policy/types.js';
import type { QvacAdapter } from '../qvac/types.js';
import { isolate, isolationPreamble, type IsolationFlags } from './isolate.js';
import { evaluate } from './pipeline.js';
import type { Actor, Decision, PassTrace } from './types.js';

/**
 * One string. The same reasoning as the adjudicator's single enum: every extra
 * field is another chance for a small model to fill a slot instead of deciding.
 */
const REWRITE = z.object({ rewritten: z.string() });

const REWRITE_JSON_SCHEMA = {
  type: 'object',
  properties: { rewritten: { type: 'string' } },
  required: ['rewritten'],
  additionalProperties: false
} as const;

/** Compliant examples shown to the rewriter. Matches the adjudicator's anchors. */
const SHOTS = 2;

/**
 * Longest prompt worth rewriting.
 *
 * Past this the rewrite would be truncated by the token cap into invalid JSON
 * anyway, and a request this size is usually a pasted document rather than a
 * sentence someone can restate. Refusing is clearer than failing closed.
 */
const MAX_INPUT_CHARS = 2000;

/** Why there is no suggestion. Machine-readable so callers render their own copy. */
export type RewriteRefusal =
  /** Nothing fired that a rewrite could be aimed at. */
  | 'no-rule'
  /** The prompt targeted the instruction layer. No honest rewrite of that exists. */
  | 'no-honest-rewrite'
  /** Longer than a request anyone can restate. */
  | 'too-long'
  /** Generation failed closed — no suggestion is the safe direction. */
  | 'model-unavailable'
  /** The model found nothing legitimate left once the prohibited part was removed. */
  | 'nothing-left'
  /** The rewrite did not survive its own re-check. */
  | 'still-blocked'
  /** The re-check hit the employee's daily ceiling. */
  | 'quota';

export type RewriteResult =
  | {
      suggestion: string;
      /** The re-check's own audit id. The suggestion passed; this is the proof. */
      auditId: string;
      reason?: undefined;
    }
  | { suggestion: null; reason: RewriteRefusal };

/**
 * The rule a rewrite should aim at, or null when there is nothing to aim at.
 *
 * Pinned rules are skipped as targets and do not veto the attempt. That
 * distinction took a measurement to get right and is worth stating plainly.
 *
 * Pinned is how the policy marks the rules that run on every prompt because an
 * attacker phrases them to look like anything — instruction override, chiefly.
 * Vetoing on one looks like the cautious reading, and it is the wrong one:
 * `r-instruction-override` is pinned, so it runs on 100% of traffic, and it
 * caused 10 of every 14 refusals on legitimate requests. A veto would switch
 * this feature off in precisely the case it exists for, and switch it on only
 * where the block was probably correct.
 *
 * Skipping it as a *target* is what matters, because that is what would have
 * the model search for phrasing that gets past it. Nothing is loosened by
 * allowing the attempt: a rewrite still has to clear every rule, the pinned one
 * included, in the re-check below — and the deterministic gate above has
 * already refused anything whose phrasing actually reached for the instruction
 * layer, which measured 0 false positives across all 16 benign controls.
 */
function targetRule(decision: DecisionLike, policy: PolicySpec): Rule | null {
  const byId = new Map(policy.rules.map((r) => [r.id, r]));
  const fired = decision.firedRules.map((f) => byId.get(f.ruleId)).filter((r): r is Rule => !!r);
  return fired.find((r) => !r.pinned) ?? null;
}

/**
 * Structural signals from the original decision.
 *
 * Read back out of the recorded trace rather than recomputed, so the gate is
 * answering for the prompt that was actually blocked. Invisible characters,
 * embedded role markers and phrasing aimed at the instruction layer are all
 * deliberate acts — none of them is something an ordinary request does by
 * accident, and none of them has a benign version to propose.
 */
function wasAimedAtTheInstructionLayer(decision: DecisionLike): boolean {
  const iso = decision.passes.find((p) => p.pass === 'isolate');
  const flags = iso?.detail as Partial<IsolationFlags> | undefined;
  if (!flags) return false;
  return Boolean(flags.hadInvisibleChars || flags.hadRoleMarkers || flags.hadMetaInstructions);
}

/** What this needs from a decision — the live one or the audited copy. */
type DecisionLike = Pick<Decision, 'firedRules' | 'passes'>;

/**
 * The rewriter's instructions.
 *
 * The "do not restate it in other words" clause is a mitigation, not a
 * guarantee: a model asked to remove a prohibited request can still produce a
 * softened version of it, and this prompt is inside the untrusted envelope with
 * the employee's own text, which may itself be trying to steer it. The
 * guarantee is downstream — the suggestion is judged by the same guard as any
 * other prompt before anyone sees it.
 */
function systemPrompt(rule: Rule, nonce: string): string {
  const allowed = rule.examples.compliant.slice(0, SHOTS).map((e) => `· ${e}`).join('\n');

  return [
    'A company rule blocked the request below. Rewrite it so it stays inside the rule.',
    '',
    `RULE: ${rule.text}`,
    ...(rule.guidance ? ['', `WHAT THE PERSON IS TOLD TO DO INSTEAD: ${rule.guidance}`] : []),
    '',
    'Requests of this kind that are allowed:',
    allowed,
    '',
    'Rewrite the message so it asks only for the part the rule permits.',
    '- Remove what the rule prohibits. Do not restate it in other words, do not',
    '  split it into pieces, and do not ask for it as a hypothetical.',
    '- Keep the person\'s own language and their legitimate goal.',
    '- If nothing legitimate is left once the prohibited part is gone, answer with',
    '  an empty string. That is a correct answer and a better one than a disguised',
    '  version of the same request.',
    '',
    'Answer with the rewritten request and nothing else.',
    isolationPreamble(nonce),
    '/no_think'
  ].join('\n');
}

/**
 * Everything that can refuse a rewrite without running anything.
 *
 * Exported so a caller can answer for free — no model call, no quota charged,
 * no attempt spent — and called again inside `suggestRewrite` so a caller that
 * skips it cannot reach the model anyway. Returns null when a rewrite may be
 * attempted.
 */
export function rewriteGate(args: {
  prompt: string;
  decision: DecisionLike;
  policy: PolicySpec;
}): RewriteRefusal | null {
  if (args.prompt.length > MAX_INPUT_CHARS) return 'too-long';
  /**
   * The one hard veto, and it is deterministic.
   *
   * Invisible characters, embedded conversation-role markers and phrasing aimed
   * at the instruction layer are deliberate acts — ordinary text does not do
   * them by accident — so there is no benign version of the request to propose.
   * This is also the signal that cannot be argued down by anything written in
   * the message, which is the property a gate on this endpoint needs.
   */
  if (wasAimedAtTheInstructionLayer(args.decision)) return 'no-honest-rewrite';
  if (targetRule(args.decision, args.policy)) return null;
  // Nothing rewritable. Either nothing fired, or the only things that fired
  // were the pinned rules this must not aim at.
  return args.decision.firedRules.length > 0 ? 'no-honest-rewrite' : 'no-rule';
}

/**
 * Suggest a version of a blocked prompt that passes, or explain why there is none.
 *
 * Costs two model passes — one to write it, one to judge it — which is why the
 * caller charges quota and why this is never on the decision path.
 */
export async function suggestRewrite(
  qvac: QvacAdapter,
  args: {
    actor: Actor;
    /** The prompt that was blocked, verified against the audit entry's hash by the caller. */
    prompt: string;
    decision: DecisionLike;
    policy: PolicySpec;
    /**
     * Called with the re-check's decision, if one was made.
     *
     * The re-check is a real decision by a real employee and it belongs in the
     * console's live trace like any other — an admin watching a rewrite happen
     * should see the guard judge it, not just hear that it did.
     */
    onRecheck?: (decision: Decision) => void;
  }
): Promise<RewriteResult> {
  const { actor, prompt, decision, policy } = args;

  const refusal = rewriteGate(args);
  if (refusal) return { suggestion: null, reason: refusal };

  // Not null: `rewriteGate` returns a refusal whenever this would be.
  const rule = targetRule(decision, policy)!;

  const iso = isolate(prompt);
  let rewritten: string;
  try {
    const res = await qvac.completeJSON(
      {
        role: 'adjudicator',
        system: systemPrompt(rule, iso.nonce),
        user: `${iso.envelope}\n\nRewrite the message.`,
        // A restated request, not an essay. Long enough for a sentence or two.
        maxTokens: 200,
        // No kvKey, for the reason documented in `adjudicate.ts`: the cache keys
        // conversation state including the user turn, so reuse replays the
        // previous answer.
        timeoutMs: 30_000
      },
      REWRITE,
      REWRITE_JSON_SCHEMA
    );
    rewritten = res.value.rewritten.trim();
  } catch {
    // Fail-closed here means no suggestion. The refusal stands, which is the
    // direction every failure in this system resolves toward.
    return { suggestion: null, reason: 'model-unavailable' };
  }

  if (!rewritten) return { suggestion: null, reason: 'nothing-left' };

  /**
   * The suggestion goes through the same guard as any other prompt, under the
   * same identity, before anyone reads it. Nothing about having been generated
   * here gives it standing — and a rewrite that cannot clear the policy is not
   * a suggestion, it is a phrasing that got closer, which is the one thing this
   * endpoint must never hand back.
   */
  const recheck = await evaluate(qvac, { actor, prompt: rewritten }, policy);
  args.onRecheck?.(recheck);
  if (quotaBlocked(recheck.passes)) return { suggestion: null, reason: 'quota' };
  if (recheck.verdict !== 'ALLOW') return { suggestion: null, reason: 'still-blocked' };

  return { suggestion: rewritten, auditId: recheck.auditId };
}

/** A re-check stopped by the daily ceiling is not the rewrite being refused. */
function quotaBlocked(passes: PassTrace[]): boolean {
  return passes.some((p) => p.pass === 'quota' && p.verdict === 'BLOCK');
}
