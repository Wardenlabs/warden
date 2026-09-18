/**
 * How the adjudicator's question is put to a model, and how its answer is
 * read back as one of three labels.
 *
 * Every form ends in a single label and nothing else. That was forced by
 * measurement: `{violates, confidence}` gave 7/8 false positives with pairings
 * like "violates at 0.00", because filling two slots never requires deciding;
 * adding a free-text `reason` gave 16/16, because long reasons overran the
 * token cap, doubled latency, and restated the rule. The explanation is
 * composed in code from the rule and the label instead. A form changes the
 * words the model is asked to say and nothing past this file: the aggregator,
 * the trace and the audit record know three labels and keep knowing three.
 */
import { z } from 'zod';
import { analyzerFormat, isNativeGuard, SHIELD_SYSTEM, graniteInstructions, type NativeGuard } from '../../qvac/native-guards.js';
import { promptOverride, renderPrompt } from '../../prompts/store.js';
import { customAdjudicatorForm, resolvedModel, thinkingMarker } from '../../qvac/client.js';
import type { Rule } from '../../policy/types.js';
import { isolationPreamble, type Isolated } from '../isolate.js';

export type Label = 'VIOLATES' | 'COMPLIES' | 'UNCLEAR';

/** VIOLATES beats UNCLEAR beats COMPLIES — the same direction as the verdict lattice. */
export const LABEL_STRICTNESS: Record<Label, number> = { COMPLIES: 0, UNCLEAR: 1, VIOLATES: 2 };

/**
 * The forms.
 *
 * `compliance` is the shipped form for a base model: VIOLATES / COMPLIES /
 * UNCLEAR, where the benign answer is a negation.
 *
 * `choice` names the benign answer instead (ORDINARY_REQUEST). Measured once
 * as a clean 5-0 that did not survive more cells; kept as a bench variant.
 *
 * `dynaguard` is for weights trained to answer this question: PASS or FAIL
 * about a policy block and a dialogue, grammar-constrained to the same
 * one-field JSON as the other forms so the parser, the mock and the
 * fail-closed path are identical. It is what the default seat runs.
 *
 * `dynaguard-native` is the same question in exactly the shape the model
 * card gives — "Provide the final answer directly", a numbered policy, the
 * answer as `<answer>PASS</answer>` free text with no grammar. It exists
 * because the grammar-constrained form was a deliberate first cut and the
 * pass's own note said the trained form was the next thing to measure. The
 * SDK cannot prefill the assistant turn, so the model is asked to begin with
 * `<answer>` rather than started there; whether that costs anything is what
 * the bench is for. Unmeasured, off, `pnpm run bench -- --a dynaguard --b dynaguard-native`.
 */
export type Form = 'compliance' | 'choice' | 'dynaguard' | 'dynaguard-native' | NativeGuard;

export type FormOptions = {
  form: Form;
  /** `v2` writes what is allowed into the DynaGuard policy. Measured worse; kept as a variant. */
  dynaguardPolicy: 'v1' | 'v2';
  /** Whether the message reaches the DynaGuard forms inside the nonce fence. Measured: costs nothing. */
  dynaguardFence: boolean;
};

export type Shots = { violating: string[]; compliant: string[] };

/**
 * Which form, when nothing asked for one.
 *
 * The environment wins, so a bench can hold the form fixed while it swaps the
 * weights. Otherwise the form follows the weights: DynaGuard answers the
 * question it was trained on or it answers badly, and an administrator who
 * picks that seat in the console has not been asked to also know about
 * prompt forms. Recognised by the resolved filename, the same way
 * `thinkingMarker` decides whether `/no_think` means anything.
 */
export function formFromEnv(): Form {
  const raw = process.env['WARDEN_ADJUDICATOR_FORM'];
  if (raw === 'choice' || raw === 'dynaguard' || raw === 'compliance' || raw === 'dynaguard-native' || (raw && isNativeGuard(raw))) return raw;
  return customAdjudicatorForm() ?? analyzerFormat(resolvedModel('adjudicator'));
}

export function isDynaguard(form: Form): boolean {
  return form === 'dynaguard' || form === 'dynaguard-native';
}

/** The benign label under each grammar-constrained form. */
const BENIGN_LABEL = { compliance: 'COMPLIES', choice: 'ORDINARY_REQUEST', dynaguard: 'PASS' } as const;

/** One enum field, as zod and as the grammar the decoder is constrained with. */
function labelSchema(values: readonly string[]): { zod: z.ZodType<{ verdict: string }>; json: Record<string, unknown> } {
  return {
    zod: z.object({ verdict: z.enum(values as [string, ...string[]]) }),
    json: {
      type: 'object',
      properties: { verdict: { type: 'string', enum: [...values] } },
      required: ['verdict'],
      additionalProperties: false
    }
  };
}

export function schemaFor(form: Exclude<Form, 'dynaguard-native' | NativeGuard>): ReturnType<typeof labelSchema> {
  if (form === 'dynaguard') return labelSchema(['FAIL', 'PASS']);
  return labelSchema(['VIOLATES', BENIGN_LABEL[form], 'UNCLEAR']);
}

/** What the model said, as the one label vocabulary the rest of the guard reads. */
export function toLabel(said: string): Label {
  if (said === BENIGN_LABEL.choice || said === BENIGN_LABEL.dynaguard) return 'COMPLIES';
  if (said === 'FAIL') return 'VIOLATES';
  return said as Label;
}

/**
 * The free-text answer of the native form. Anything that is not a clean
 * PASS or FAIL is an error, which the caller turns into a fail-closed
 * ESCALATE like any other pass error — never a guess.
 */
export function parseNative(text: string): Label {
  const m = /<answer>\s*(PASS|FAIL)\s*(?:<\/answer>|$)/i.exec(text) ?? /^\s*(PASS|FAIL)\b/i.exec(text);
  if (!m) throw new Error(`DynaGuard answered outside its form: ${JSON.stringify(text.slice(0, 80))}`);
  return m[1]!.toUpperCase() === 'PASS' ? 'COMPLIES' : 'VIOLATES';
}

/**
 * The system prompt for the base-model forms.
 *
 * Two clauses in here are not padding — each fixes a measured failure mode,
 * and both are generic enough to help every rule.
 *
 * *Asking about a process is not doing the thing.* Without it the adjudicator
 * labelled "cuál es el proceso para pedir un aumento?" as violating a payroll
 * rule — a question about procedure, matched on topic alone. This single line
 * took a six-case probe from 1/6 to 5/6.
 *
 * *A rule's own limits are part of the rule.* Rules qualify themselves — about
 * *another* employee, above *a threshold*, *outside* the company — and the
 * model reliably drops the qualifier and fires on the bare subject.
 *
 * The rule's boundary, when the compiler wrote one, is read here and not by
 * the DynaGuard forms: measured 2026-09-04, it took the shipped 1.7B from 72%
 * to 52% of honest requests refused, and the same sentences took the
 * fine-tune from 45% to 68%.
 */
export function defaultSystemPrompt(rule: Rule, nonce: string, form: 'compliance' | 'choice', shots: Shots, tokens = false): string {
  const benign = BENIGN_LABEL[form];
  const examples = [
    ...shots.violating.map((t) => `VIOLATES: ${t}`),
    ...shots.compliant.map((t) => `${benign}: ${t}`)
  ].join('\n');
  const benignClause = form === 'compliance'
    ? [
        'COMPLIES  - it does not. Two things that are NOT violations, however much',
        '            they share the rule\'s subject:',
        '            · asking how a process works, what a policy says, or who to ask;',
        '            · anything outside the rule\'s own limits — if it is about another',
        '              person, a threshold, or a destination, a message that stays',
        '              inside those limits complies.',
        '            Most messages comply.'
      ]
    : [
        'ORDINARY_REQUEST - someone doing their job. This is what most messages are,',
        '            including messages about the rule\'s own subject:',
        '            · asking how a process works, what a policy says, or who to ask;',
        '            · an ordinary work instruction — draft this, approve that, clean',
        '              this file — which is a task for you, not a change to your rules;',
        '            · anything inside the rule\'s own limits, when it names a person,',
        '              a threshold, or a destination.'
      ];

  return [
    'You check one message against one rule and answer with a single label.',
    '',
    `RULE: ${tokens ? '{{rule}}' : rule.text}`,
    ...(tokens ? ['{{boundary}}'] : rule.boundary ? [`NOT COVERED: ${rule.boundary}`] : []),
    '',
    'VIOLATES  - the message actually does what the rule prohibits.',
    ...benignClause,
    'UNCLEAR   - only when the message is genuinely ambiguous. If it plainly does',
    `            not do the prohibited thing, answer ${benign}.`,
    '',
    'Examples for this rule:',
    tokens ? '{{examples}}' : examples,
    '',
    tokens ? '{{isolation}}' : isolationPreamble(nonce),
    tokens ? '{{thinking}}' : thinkingMarker('adjudicator')
  ].join('\n');
}

/**
 * One rule as a DynaGuard policy reads it: the prohibition, the standing
 * clause that measurably helped, and its examples as plain sentences — the
 * way a policy author would write them and the way the model saw them. Short
 * on purpose: every longer policy written for this model made it worse
 * (`dynaguard-v2`, the bounded rule texts), so a boundary sentence is not
 * read here and the two nearest compliant examples carry it instead.
 */
export function defaultDynaguardClauses(rule: Rule, shots: Shots, policy: FormOptions['dynaguardPolicy'], tokens = false): string[] {
  const clauses = policy === 'v2'
    ? [
        'The user is an employee giving work instructions to an AI assistant at their company.',
        `Rule: ${tokens ? '{{rule}}' : rule.text}`,
        'Only a message that actually does what the rule prohibits violates it.',
        'Allowed: asking how a process works, what a policy says, or who to ask.',
        'Allowed: an ordinary work instruction to the assistant — draft this, approve that, ignore or delete rows in a file, rewrite a paragraph — which is a task for the assistant, not a change to its rules.',
        "Allowed: anything inside the rule's own limits. If the rule is about another person, a threshold or a destination, a message that stays inside those limits complies."
      ]
    : [tokens ? '{{rule}}' : rule.text, 'Asking how a process works, what a policy says, or who to ask is allowed.'];
  return [
    ...clauses,
    ...(tokens ? ['{{examples}}'] : [...shots.violating.map((t) => `A message like "${t}" violates this policy.`),
    ...shots.compliant.map((t) => `A message like "${t}" is allowed.`)])
  ];
}

/** The DynaGuard prompt: a policy block and a dialogue block, all in the user turn. */
export function defaultDynaguardUser(rule: Rule, iso: Isolated, shots: Shots, opts: FormOptions, tokens = false): string {
  const policy = tokens ? ['{{policy}}'] : dynaguardClauses(rule, shots, opts.dynaguardPolicy);
  const message = tokens ? '{{message}}' : opts.dynaguardFence ? iso.envelope : iso.clean;
  if (opts.form === 'dynaguard-native') {
    return [
      'Evaluate the following dialogue for compliance with the given policy. Provide the final answer directly.',
      '',
      '## Policy',
      ...(tokens ? ['{{policy}}'] : policy.map((line, i) => `${i + 1}. ${line}`)),
      '',
      '## Dialogue',
      `User: ${message}`,
      '',
      'Begin your reply with <answer>PASS</answer> or <answer>FAIL</answer>.'
    ].join('\n');
  }
  return [
    'Evaluate the following dialogue for compliance with the given policy.',
    '',
    '## Policy',
    policy.join('\n'),
    '',
    '## Dialogue',
    `User: ${message}`
  ].join('\n');
}

/**
 * Several rules as one numbered DynaGuard policy, for the screening call.
 *
 * DynaBench policies have a median of three rules and the model was trained
 * to answer about the whole list, so this is the shape it knows. Rule texts
 * only, no examples: a screen is asked whether anything in the policy is
 * touched, and per-rule attribution with examples follows only when it says
 * FAIL. Kept short for the same reason every DynaGuard prompt here is short.
 */
export function defaultDynaguardPolicyUser(rules: Rule[], iso: Isolated, opts: FormOptions, tokens = false): string {
  const message = tokens ? '{{message}}' : opts.dynaguardFence ? iso.envelope : iso.clean;
  return [
    'Evaluate the following dialogue for compliance with the given policy. Provide the final answer directly.',
    '',
    '## Policy',
    ...(tokens ? ['{{policies}}'] : rules.map((r, i) => `${i + 1}. ${r.text}`)),
    `${tokens ? '{{nextRuleIndex}}' : rules.length + 1}. Asking how a process works, what a policy says, or who to ask is allowed.`,
    '',
    '## Dialogue',
    `User: ${message}`,
    ...(opts.form === 'dynaguard-native' ? ['', 'Begin your reply with <answer>PASS</answer> or <answer>FAIL</answer>.'] : [])
  ].join('\n');
}

export function systemPrompt(rule: Rule, nonce: string, form: 'compliance' | 'choice', shots: Shots): string {
  const examples = [...shots.violating.map((text) => `VIOLATES: ${text}`),
    ...shots.compliant.map((text) => `${BENIGN_LABEL[form]}: ${text}`)].join('\n');
  return renderPrompt(`analyzer.${form}.system`, { rule: rule.text, boundary: rule.boundary ? `NOT COVERED: ${rule.boundary}` : '',
    examples, isolation: isolationPreamble(nonce), thinking: thinkingMarker('adjudicator')
  }, () => defaultSystemPrompt(rule, nonce, form, shots));
}
function dynaguardClauses(rule: Rule, shots: Shots, policy: FormOptions['dynaguardPolicy']): string[] {
  const id = `analyzer.dynaguard.policy.${policy}`;
  if (promptOverride(id) === undefined) return defaultDynaguardClauses(rule, shots, policy);
  const examples = [...shots.violating.map((text) => `A message like "${text}" violates this policy.`),
    ...shots.compliant.map((text) => `A message like "${text}" is allowed.`)].join('\n');
  return renderPrompt(id, { rule: rule.text, examples }, () => '').split('\n');
}
export function dynaguardUser(rule: Rule, iso: Isolated, shots: Shots, opts: FormOptions): string {
  const clauses = dynaguardClauses(rule, shots, opts.dynaguardPolicy);
  const policy = opts.form === 'dynaguard-native' ? clauses.map((line, i) => `${i + 1}. ${line}`).join('\n') : clauses.join('\n');
  return renderPrompt(`analyzer.${opts.form}.user`, { policy, message: opts.dynaguardFence ? iso.envelope : iso.clean },
    () => defaultDynaguardUser(rule, iso, shots, opts));
}
export function dynaguardPolicyUser(rules: Rule[], iso: Isolated, opts: FormOptions): string {
  return renderPrompt(`analyzer.${opts.form}.screen.user`, { policies: rules.map((rule, i) => `${i + 1}. ${rule.text}`).join('\n'),
    nextRuleIndex: String(rules.length + 1), message: opts.dynaguardFence ? iso.envelope : iso.clean
  }, () => defaultDynaguardPolicyUser(rules, iso, opts));
}
export function analyzerUser(form: 'compliance' | 'choice', envelope: string): string {
  return renderPrompt(`analyzer.${form}.user`, { message: envelope }, () => `${envelope}\n\nLabel the message against the rule.`);
}
export function dynaguardSystem(form: Form): string {
  return renderPrompt(`analyzer.${form}.system`, { thinking: thinkingMarker('adjudicator') }, () => thinkingMarker('adjudicator'));
}

/** Publisher-native binary questions, with the same policy scope and nonce isolation. */
export function nativeDefaults(form: NativeGuard): { system: string; user: string } {
  const criteria = "The user's message violates this rule: {{rule}}\n{{boundary}}\nAsking about a process or policy is not performing the prohibited action. Respect all limits in the rule.\nExamples:\n{{examples}}\n{{isolation}}";
  return form === 'shieldstral'
    ? { system: SHIELD_SYSTEM, user: `<Instruct>: {{isolation}}\nRespect all limits in the rule. Asking about a process is not performing the prohibited action.\n\n<Query>: Does the user's message violate this rule? {{rule}}\n{{boundary}}\nExamples:\n{{examples}}\n\n<Document>: {{message}}` }
    : { system: graniteInstructions(criteria), user: '{{message}}' };
}
export function nativePrompts(form: NativeGuard, rule: Rule, iso: Isolated, shots: Shots): { system: string; user: string } {
  const defaults = nativeDefaults(form);
  const values = { rule: rule.text, boundary: rule.boundary ? `NOT COVERED: ${rule.boundary}` : '',
    examples: [...shots.violating.map(t => `yes: ${t}`), ...shots.compliant.map(t => `no: ${t}`)].join('\n'),
    isolation: isolationPreamble(iso.nonce), message: iso.envelope };
  return { system: renderPrompt(`analyzer.${form}.system`, values, () => defaults.system.replace(/\{\{([^{}]*)\}\}/g, (_m, key: string) => values[key as keyof typeof values])),
    user: renderPrompt(`analyzer.${form}.user`, values, () => defaults.user.replace(/\{\{([^{}]*)\}\}/g, (_m, key: string) => values[key as keyof typeof values])) };
}
