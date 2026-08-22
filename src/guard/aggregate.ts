/**
 * Pass 4 — combine every pass into one decision.
 *
 * No model runs here, and that is the whole point. This is the only place a
 * verdict is decided, it is ordinary code, and it cannot be argued with. An
 * attacker who fully compromises every model in the pipeline still cannot
 * produce an ALLOW, because no model is ever asked for one: models supply
 * observations, and this function alone turns observations into authority.
 *
 * The rule it enforces is monotonic: each input can only push the decision
 * toward stricter. Nothing here can loosen what another pass concluded.
 */
import type { Rule } from '../policy/types.js';
import type { RuleVerdict } from './passes/adjudicate.js';
import type { IsolationFlags } from './isolate.js';
import { tighten, type FiredRule, type Verdict } from './types.js';

export type AggregateInput = {
  verdicts: RuleVerdict[];
  rules: Rule[];
  flags: IsolationFlags;
  /** Rules that were meant to be judged. A missing verdict is not an absence of evidence. */
  expectedRuleIds: string[];
};

export type AggregateResult = {
  verdict: Verdict;
  firedRules: FiredRule[];
  explanation: string;
};

/** Structural signals strong enough to escalate on their own. */
function structuralConcerns(flags: IsolationFlags): string[] {
  const concerns: string[] = [];
  // Each of these is a deliberate act, not something ordinary text does by
  // accident, so they are worth a human look even when no rule fired.
  if (flags.hadInvisibleChars) concerns.push('invisible characters');
  if (flags.hadRoleMarkers) concerns.push('embedded conversation-role markers');
  if (flags.nonAsciiRatio > 0.4 && flags.length > 40) concerns.push('unusual character mix');
  return concerns;
}

export function aggregate(input: AggregateInput): AggregateResult {
  const { verdicts, rules, flags, expectedRuleIds } = input;
  const byId = new Map(rules.map((r) => [r.id, r]));
  const fired: FiredRule[] = [];

  let verdict: Verdict = 'ALLOW';

  for (const v of verdicts) {
    const rule = byId.get(v.ruleId);
    if (!rule) continue;

    if (v.violates) {
      verdict = tighten(verdict, rule.severity === 'block' ? 'BLOCK' : 'ESCALATE');
      fired.push({ ruleId: rule.id, ruleText: rule.text, reason: v.reason, confidence: v.confidence });
    } else if (v.unclear) {
      // The model declined to decide. That is a request for a human, not a pass.
      verdict = tighten(verdict, 'ESCALATE');
      fired.push({
        ruleId: rule.id, ruleText: rule.text,
        reason: `could not determine: ${v.reason}`, confidence: v.confidence
      });
    }
  }

  // A rule that was supposed to be checked and produced nothing is the
  // dangerous case: a crashed or timed-out pass looks identical to a clean one
  // if you only read the verdicts that arrived.
  const answered = new Set(verdicts.map((v) => v.ruleId));
  const unanswered = expectedRuleIds.filter((id) => !answered.has(id));
  if (unanswered.length > 0) {
    verdict = tighten(verdict, 'ESCALATE');
    for (const id of unanswered) {
      const rule = byId.get(id);
      fired.push({
        ruleId: id,
        ruleText: rule?.text ?? id,
        reason: 'rule could not be evaluated — escalated rather than assumed clean',
        confidence: 0
      });
    }
  }

  const concerns = structuralConcerns(flags);
  if (concerns.length > 0) verdict = tighten(verdict, 'ESCALATE');

  return { verdict, firedRules: fired, explanation: explain(verdict, fired, concerns) };
}

/**
 * A sentence the employee actually reads, in their own tool.
 *
 * It names the rule and the reason, because "blocked by policy" with no
 * specifics trains people to route around the gateway rather than work with it.
 */
function explain(verdict: Verdict, fired: FiredRule[], concerns: string[]): string {
  if (verdict === 'ALLOW') return 'No policy concerns.';

  const parts: string[] = [];
  const top = fired[0];
  if (top) {
    parts.push(`Rule: "${top.ruleText}"`);
    parts.push(top.reason);
  }
  if (concerns.length > 0) parts.push(`Also flagged: ${concerns.join(', ')}.`);
  if (fired.length > 1) parts.push(`(${fired.length - 1} other rule${fired.length > 2 ? 's' : ''} also matched.)`);

  if (verdict === 'ESCALATE') parts.push('Sent to an administrator for review.');
  return parts.join(' ');
}
