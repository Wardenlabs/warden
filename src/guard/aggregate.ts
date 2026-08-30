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
import type { InjectionFinding } from './passes/injection.js';
import type { IsolationFlags } from './isolate.js';
import { tighten, type FiredRule, type Verdict } from './types.js';

export type AggregateInput = {
  verdicts: RuleVerdict[];
  rules: Rule[];
  flags: IsolationFlags;
  /** Rules that were meant to be judged. A missing verdict is not an absence of evidence. */
  expectedRuleIds: string[];
  /**
   * Findings from the injection pass, each already tied to the rule it answers
   * for. Empty when the pass is off, which is the shipped default.
   */
  injections?: { ruleId: string; finding: InjectionFinding }[];
  /** Pinned rules whose injection pass threw. Nobody judged them. */
  unansweredPinned?: string[];
  /** Attachments whose text could not be extracted. */
  unreadableAttachments?: number;
};

export type AggregateResult = {
  verdict: Verdict;
  firedRules: FiredRule[];
  /** Recorded for the trace and the report even when they did not change the verdict. */
  unclearRules: FiredRule[];
  /** Rules the admin set to `warn`. They fired, they explain themselves, and they let the request through. */
  warnings: FiredRule[];
  explanation: string;
};

/**
 * Structural signals strong enough to escalate on their own.
 *
 * Most of them are tamper evidence: invisible characters, faked conversation
 * turns, homoglyph mixes, a forged delimiter, an order aimed at the classifier.
 * Nobody types those by accident and no rule has to authorise noticing them, so
 * they stand on their own.
 *
 * `hadMetaInstructions` is different, and the difference was found by an admin
 * deleting a rule and watching the behaviour survive it. That signal is *about*
 * something — instruction override — and the policy is where the company says
 * whether it cares. A guard that keeps enforcing a rule after the admin removed
 * it has quietly stopped being governed by the policy, and the admin has no
 * object left to point at: the refusal names no rule, because there is none.
 *
 * So it is admitted only while a pinned rule is in force. `pinned` is the marker
 * for a rule that must be judged on every prompt regardless of similarity, which
 * is the always-on security class this signal serves. Remove those rules and the
 * signal goes quiet with them — which is what the admin asked for by removing
 * them.
 *
 * An admin who pins an unrelated rule keeps the detector on. That is harmless:
 * it only ever adds evidence, and never blocks on its own.
 *
 * `hadEnvelopeForgery` and `hadGuardProtocol` are ungated, and the reason is
 * the same one that admits the first three. They are not about a subject any
 * policy governs — they are about this pipeline's own machinery: a forged copy
 * of the delimiter that fences untrusted text, or a message writing the
 * adjudicator's verdict label for it. There is no company that has "notice when
 * someone forges our delimiter" as a business rule to delete, and an admin who
 * removed every rule would still not be asking for that. Deleting a rule
 * silences the signals that were about the rule; these were never about one.
 *
 * They are also the cheapest evidence in the system. Measured across the whole
 * corpus and twenty held-out benign prompts written to trip them: 0 false
 * flags, and 5 of the 8 `guard-targeted` attacks — the class the corpus calls
 * the most valuable finding in the project, and the one that was at 50%.
 */
function structuralConcerns(flags: IsolationFlags, rules: Rule[]): string[] {
  const concerns: string[] = [];
  if (flags.hadInvisibleChars) concerns.push('invisible characters');
  if (flags.hadRoleMarkers) concerns.push('embedded conversation-role markers');
  if (flags.hadEnvelopeForgery) concerns.push("a forged copy of the guard's own delimiters");
  if (flags.hadGuardProtocol) concerns.push("instructions addressed to the guard's own machinery");
  if (flags.hadMetaInstructions && rules.some((r) => r.pinned)) {
    concerns.push('phrasing aimed at the instruction layer');
  }
  if (flags.nonAsciiRatio > 0.4 && flags.length > 40) concerns.push('unusual character mix');
  return concerns;
}

export function aggregate(input: AggregateInput): AggregateResult {
  const {
    verdicts,
    rules,
    flags,
    expectedRuleIds,
    injections = [],
    unansweredPinned = [],
    unreadableAttachments = 0
  } = input;
  const byId = new Map(rules.map((r) => [r.id, r]));
  const fired: FiredRule[] = [];
  /** Rules the model hedged on. Allowed alone; escalated alongside other signals. */
  const unclearRules: FiredRule[] = [];
  /** Rules that fired but whose severity is `warn`. They inform; they never refuse. */
  const warnings: FiredRule[] = [];

  let verdict: Verdict = 'ALLOW';

  for (const v of verdicts) {
    const rule = byId.get(v.ruleId);
    if (!rule) continue;

    if (v.violates) {
      /**
       * A `warn` rule is separated here and nowhere else.
       *
       * It never reaches `tighten`, so it cannot move the verdict, and it is
       * kept out of `firedRules` so that nothing downstream — the refusal
       * message, the console's blocked list, the red-team runner's tally —
       * mistakes an advisory for a refusal. The employee is told what fired and
       * what the rule says; the request goes through.
       */
      if (rule.severity === 'warn') {
        warnings.push(firedFrom(rule, v.reason, v.confidence));
      } else {
        verdict = tighten(verdict, rule.severity === 'block' ? 'BLOCK' : 'ESCALATE');
        fired.push(firedFrom(rule, v.reason, v.confidence));
      }
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

  /**
   * The injection pass, folded in through the same lattice as everything else.
   *
   * It fires the rule it was asked about, so the refusal names a rule the
   * employee can read and the admin can edit — the property the whole design
   * turns on. A model that answered WORK_REQUEST is not granting anything: it
   * is one signal declining to fire, and the rest of the evidence still stands.
   *
   * `UNCLEAR` joins the hedged pile rather than refusing, for the reason
   * measured on the adjudicator: escalating on every hedge put 16 of 16
   * legitimate requests in front of a human, and a guard nobody can work with
   * gets switched off.
   */
  for (const { ruleId, finding } of injections) {
    const rule = byId.get(ruleId);
    if (!rule) continue;

    if (finding.attack) {
      const reason = 'this message is aimed at the assistant\'s rules rather than at a task';
      if (rule.severity === 'warn') {
        warnings.push(firedFrom(rule, reason, 0.9));
      } else {
        verdict = tighten(verdict, rule.severity === 'block' ? 'BLOCK' : 'ESCALATE');
        fired.push(firedFrom(rule, reason, 0.9));
      }
    } else if (finding.unclear) {
      unclearRules.push(firedFrom(rule, 'could not tell whether this is aimed at the rules or at a task', 0.4));
    }
  }

  // A pinned rule whose only judge threw is unjudged, and unjudged is never
  // clean. Kept separate from the adjudicator's list below because it failed in
  // a different pass, and the trace should be able to say which.
  for (const id of unansweredPinned) {
    verdict = tighten(verdict, 'ESCALATE');
    const rule = byId.get(id);
    fired.push({
      ruleId: id,
      ruleText: rule?.text ?? id,
      reason: 'the injection pass could not be evaluated — escalated rather than assumed clean',
      confidence: 0
    });
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

  const concerns = structuralConcerns(flags, rules);
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
    warnings,
    explanation: explain(verdict, fired, concerns, warnings)
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
function explain(
  verdict: Verdict,
  fired: FiredRule[],
  concerns: string[],
  warnings: FiredRule[] = []
): string {
  if (verdict === 'ALLOW') {
    if (warnings.length === 0) return 'No policy concerns.';
    /**
     * An allowed request that still has something to say.
     *
     * Written as a note rather than a refusal, and it names the rule, because a
     * warning nobody can act on is decoration. "Flagged" with no rule attached
     * teaches people to ignore the next one.
     */
    const lines = warnings.map((w) => `Heads-up — "${w.ruleText}"`);
    const top = warnings[0];
    if (top?.guidance) lines.push(`If that applies here: ${top.guidance}`);
    lines.push('Allowed. This is a note, not a refusal — nothing was blocked.');
    return lines.join('\n');
  }

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
