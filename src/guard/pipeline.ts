/**
 * The guard: one prompt in, one decision out.
 *
 * Cheap and certain first, expensive and probabilistic last. Quotas and secret
 * detection are counters and regexes, so they run ahead of any model and cost
 * nothing; by the time inference happens the request has already survived
 * everything that can be decided without it.
 *
 * Every stage records a trace entry. The trace is not debug output — it is what
 * the console renders and what the audit log keeps, and it is how a human
 * answers "why was this blocked" in five seconds instead of five minutes.
 */
import { recordDecision } from '../audit/log.js';
import { selectRules } from '../policy/index.js';
import { rulesForActor } from '../policy/store.js';
import type { PolicySpec } from '../policy/types.js';
import type { QvacAdapter } from '../qvac/types.js';
import { aggregate } from './aggregate.js';
import { checkBudget } from './budget.js';
import { isolate, normalizeUntrusted } from './isolate.js';
import { adjudicateAll } from './passes/adjudicate.js';
import { checkQuota } from './quota.js';
import { sanitize } from './sanitize.js';
import { tighten } from './types.js';
import type { Decision, GuardInput, PassTrace } from './types.js';

/** How many non-pinned rules to adjudicate. Each one is a model call. */
const TOP_K = Number(process.env['WARDEN_TOP_K'] ?? 3);

export async function evaluate(
  qvac: QvacAdapter,
  input: GuardInput,
  policy: PolicySpec
): Promise<Decision> {
  const started = Date.now();
  const passes: PassTrace[] = [];

  // ── pass -2: quota ─────────────────────────────────────────────────────────
  const quota = checkQuota(policy, input.actor);
  passes.push(quota.trace);
  if (!quota.allowed) {
    return finish({
      verdict: 'BLOCK', policy, passes, started,
      input, maskedPrompt: input.prompt, maskedSpans: [], firedRules: [],
      quota: { used: quota.used, limit: quota.limit ?? 0 },
      explanation: `Daily limit reached for role "${input.actor.role}" (${quota.used}/${quota.limit}).`
    });
  }

  // ── pass -1.5: session budget ──────────────────────────────────────────────
  // Observes only. Its ESCALATE is combined at the end rather than returned
  // here, because returning it would make a prompt that ALSO breaks a rule come
  // back held instead of refused — a decision loosened by adding a control.
  const budget = checkBudget(policy, input.actor, input.usage);
  passes.push(budget.trace);

  // ── pass -1: secrets ───────────────────────────────────────────────────────
  // Normalised before matching: a credential written with full-width
  // homoglyphs or zero-width characters matches no pattern in its raw form,
  // and every later stage — the guard model, the audit spans, the upstream
  // forward — reads the masked text. Tamper evidence survives because the
  // isolation flags below are computed against the raw text.
  const sanitizeStart = Date.now();
  const { masked, spans } = sanitize(normalizeUntrusted(input.prompt));
  passes.push({
    pass: 'sanitize',
    ms: Date.now() - sanitizeStart,
    verdict: 'ALLOW',
    detail: { masked: spans.length, kinds: spans.map((s) => s.kind) }
  });

  // Attachment text joins the message here, before isolation, because a
  // document is exactly as untrusted as the prompt that carried it — and it is
  // the channel an attacker uses when the employee is innocent.
  const SEPARATOR = '\n\n--- attachment ---\n';
  let subject = masked;
  let rawSubject = input.prompt;
  let unreadableAttachments = 0;
  if (input.attachments?.length) {
    const ocrStart = Date.now();
    const extracted: string[] = [];
    const rawExtracted: string[] = [];
    for (const path of input.attachments) {
      try {
        const text = await qvac.ocr(path);
        rawExtracted.push(text);
        extracted.push(sanitize(normalizeUntrusted(text)).masked);
      } catch (err) {
        unreadableAttachments++;
        const note = `[attachment could not be read: ${err instanceof Error ? err.message : err}]`;
        rawExtracted.push(note);
        extracted.push(note);
      }
    }
    subject = [masked, ...extracted].join(SEPARATOR);
    rawSubject = [input.prompt, ...rawExtracted].join(SEPARATOR);
    passes.push({
      pass: 'ocr',
      ms: Date.now() - ocrStart,
      // An attachment nobody could read is the case this pass exists for: the
      // document-borne attack hides in exactly the text OCR would have
      // surfaced. Clearing it would mean approving a document sight unseen.
      ...(unreadableAttachments > 0 ? { verdict: 'ESCALATE' as const, failedClosed: true } : {}),
      detail: {
        attachments: input.attachments.length,
        unreadable: unreadableAttachments,
        chars: subject.length - masked.length
      }
    });
  }

  // ── pass 0: isolate ────────────────────────────────────────────────────────
  const isoStart = Date.now();
  const iso = isolate(subject, rawSubject);
  passes.push({ pass: 'isolate', ms: Date.now() - isoStart, verdict: 'ALLOW', detail: iso.flags });

  // ── pass 2: retrieve ───────────────────────────────────────────────────────
  // Company-wide rules, the actor's role rules, and any rule the admin wrote
  // for this person by name — resolved in one place so none can be forgotten.
  const applicable = rulesForActor(policy, input.actor);
  const retrieveStart = Date.now();
  const selected = await selectRules(policy, applicable, iso.clean, TOP_K);
  passes.push({
    pass: 'retrieve',
    ms: Date.now() - retrieveStart,
    detail: {
      applicable: applicable.length,
      selected: selected.rules.map((r) => r.id),
      scores: selected.scores,
      // A degraded retrieval judged every rule instead of the top few: slower,
      // never less safe, and worth surfacing rather than hiding.
      degraded: selected.degraded
    }
  });

  // ── pass 3: adjudicate (concurrent) ────────────────────────────────────────
  const { verdicts, traces } = await adjudicateAll(qvac, iso, selected.rules);
  passes.push(...traces);

  // ── pass 4: aggregate ──────────────────────────────────────────────────────
  const aggStart = Date.now();
  const result = aggregate({
    verdicts,
    rules: selected.rules,
    flags: iso.flags,
    expectedRuleIds: selected.rules.map((r) => r.id),
    unreadableAttachments
  });
  passes.push({
    pass: 'aggregate',
    ms: Date.now() - aggStart,
    verdict: result.verdict,
    detail: { fired: result.firedRules.length }
  });

  // The budget joins here, through the same lattice as everything else. It can
  // only make the verdict stricter; a rule that fired still refuses.
  const verdict = tighten(result.verdict, budget.verdict);
  const explanation = [budget.explanation, result.explanation].filter(Boolean).join('\n\n');

  return finish({
    verdict, policy, passes, started, input,
    maskedPrompt: masked, maskedSpans: spans,
    firedRules: result.firedRules,
    quota: { used: quota.used, limit: quota.limit ?? 0 },
    budget: budget.status,
    explanation
  });
}

function finish(args: {
  verdict: Decision['verdict'];
  policy: PolicySpec;
  passes: PassTrace[];
  started: number;
  input: GuardInput;
  maskedPrompt: string;
  maskedSpans: Decision['maskedSpans'];
  firedRules: Decision['firedRules'];
  quota: { used: number; limit: number };
  budget?: Decision['budget'];
  explanation: string;
}): Decision {
  const partial = {
    verdict: args.verdict,
    policyVersion: args.policy.version,
    totalMs: Date.now() - args.started,
    firedRules: args.firedRules,
    passes: args.passes,
    maskedPrompt: args.maskedPrompt,
    maskedSpans: args.maskedSpans,
    quota: args.quota,
    ...(args.budget ? { budget: args.budget } : {}),
    explanation: args.explanation
  };

  // Recording assigns the audit id, so the id the employee is shown is the one
  // that actually exists in the log rather than a number generated alongside it.
  const entry = recordDecision(args.input.actor, args.input.prompt, partial);
  return { ...partial, auditId: entry.auditId };
}
