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
  /** Attachments whose text could not be extracted. */
  unreadableAttachments?: number;
};

export type AggregateResult = {
  verdict: Verdict;
  firedRules: FiredRule[];
  /** Recorded for the trace and the report even when they did not change the verdict. */
  unclearRules: FiredRule[];
  explanation: string;
};

/** Structural signals strong enough to escalate on their own. */
function structuralConcerns(flags: IsolationFlags): string[] {
  const concerns: string[] = [];
  // Each of these is a deliberate act, not something ordinary text does by
  // accident, so they are worth a human look even when no rule fired.
  if (flags.hadInvisibleChars) concerns.push('invisible characters');
  if (flags.hadRoleMarkers) concerns.push('embedded conversation-role markers');
  // Computed on every request since pass 0 was written, and until now thrown
  // away — the one deterministic signal aimed squarely at instruction override
  // was the only flag that never reached a decision. It costs nothing, cannot be
  // argued down by anything in the message, and measured 0 false positives
  // across all 16 benign controls while matching 5 of 8 direct-override attacks.
  if (flags.hadMetaInstructions) concerns.push('phrasing aimed at the instruction layer');
  if (flags.nonAsciiRatio > 0.4 && flags.length > 40) concerns.push('unusual character mix');
  return concerns;
}

export function aggregate(input: AggregateInput): AggregateResult {
  const { verdicts, rules, flags, expectedRuleIds, unreadableAttachments = 0 } = input;
  const byId = new Map(rules.map((r) => [r.id, r]));
  const fired: FiredRule[] = [];
  /** Rules the model hedged on. Allowed alone; escalated alongside other signals. */
  const unclearRules: FiredRule[] = [];

  let verdict: Verdict = 'ALLOW';

  for (const v of verdicts) {
    const rule = byId.get(v.ruleId);
    if (!rule) continue;

    if (v.violates) {
      verdict = tighten(verdict, rule.severity === 'block' ? 'BLOCK' : 'ESCALATE');
      fired.push(firedFrom(rule, v.reason, v.confidence));
    } else if (v.unclear) {
      /**
       * A model that answered UNCLEAR did its job and expressed doubt. That is
       * not the same as a pass that produced nothing, and it must not be
       * treated the same way.
       *
       * An earlier version escalated on every UNCLEAR and measured **16/16
       * false positives** on legitimate traffic: with several rules per prompt,
       * a model that hedges on anything hedges on something, and every ordinary
       * request ended up in front of a human. A guard nobody can work with gets
       * switched off, which protects nothing.
       *
       * So a bare UNCLEAR is recorded and allowed. It escalates only when
       * something else independently looks wrong — see the structural check
       * below, which is deterministic and cannot be talked into silence.
       */
      unclearRules.push(firedFrom(rule, v.reason, v.confidence));
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

  // An attachment we could not read is the one case where the evidence the
  // guard needed is precisely what went missing — a document-borne injection
  // hides in the text OCR would have surfaced. Approving it would be approving
  // a document sight unseen.
  if (unreadableAttachments > 0) {
    verdict = tighten(verdict, 'ESCALATE');
    fired.push({
      ruleId: 'attachment-unreadable',
      ruleText: 'Attachments must be readable before their contents can be cleared',
      reason: `${unreadableAttachments} attachment(s) could not be read — escalated rather than approved unseen`,
      confidence: 1
    });
  }

  const concerns = structuralConcerns(flags);
  if (concerns.length > 0) verdict = tighten(verdict, 'ESCALATE');

  // Doubt plus a structural signal is worth a human; either alone is not.
  // The structural check is deterministic, so this cannot be argued down by
  // anything written in the message.
  if (unclearRules.length > 0 && concerns.length > 0) {
    verdict = tighten(verdict, 'ESCALATE');
    fired.push(...unclearRules);
  }

  return {
    verdict,
    firedRules: fired,
    unclearRules,
    explanation: explain(verdict, fired, concerns)
  };
}

/** Carry the rule's own guidance onto the decision, so the refusal can use it. */
function firedFrom(rule: Rule, reason: string, confidence: number): FiredRule {
  return {
    ruleId: rule.id,
    ruleText: rule.text,
    reason,
    confidence,
    severity: rule.severity,
    ...(rule.guidance ? { guidance: rule.guidance } : {}),
    // Two, not all of them. This is read by a person mid-keystroke in their
    // terminal, and a wall of examples is skipped the same way no examples is.
    ...(rule.examples.compliant.length > 0
      ? { allowedExamples: rule.examples.compliant.slice(0, 2) }
      : {})
  };
}

/**
 * What the employee actually reads, in their own tool.
 *
 * A refusal is a dead end unless it answers the question the person is now
 * holding: what am I allowed to do instead? "Blocked by policy" does not, and
 * people who get it twice learn to route around the gateway — which protects
 * nothing and is worse than not having one. So the message names the rule, says
 * what to do instead, and shows two nearby requests that would have gone
 * through.
 *
 * Every part of it is read from the ratified rule. Nothing here is generated at
 * decision time: that was measured at 16/16 false positives when the
 * adjudicator was asked for a reason, and it would put a text generation in the
 * path of every refusal for prose that says less than the rule already does.
 */
function explain(verdict: Verdict, fired: FiredRule[], concerns: string[]): string {
  if (verdict === 'ALLOW') return 'No policy concerns.';

  const lines: string[] = [];
  const top = fired[0];

  if (top) {
    lines.push(`Rule: "${top.ruleText}"`);
    if (top.guidance) lines.push(`Instead: ${top.guidance}`);
    if (top.allowedExamples?.length) {
      lines.push(`These would go through: ${top.allowedExamples.map((e) => `"${e}"`).join(' · ')}`);
    }
    // Only worth saying when there is no guidance to say instead of it — on its
    // own it restates the verdict, which is the tautology this rewrite exists
    // to remove.
    if (!top.guidance) lines.push(top.reason);
  }

  if (concerns.length > 0) lines.push(`Also flagged: ${concerns.join(', ')}.`);
  if (fired.length > 1) {
    lines.push(`(${fired.length - 1} other rule${fired.length > 2 ? 's' : ''} also matched.)`);
  }
  if (verdict === 'ESCALATE') {
    // Now a description of something that happens. The queue this refers to was
    // an empty array and a stub for most of this project's life, which made
    // this the most confident sentence in the product and the least true one.
    lines.push(
      'Held for an administrator to review — you have not been refused, just queued. ' +
        'When they answer, ask again: an approved request goes through on its own merits.'
    );
  }

  return lines.join('\n');
}
