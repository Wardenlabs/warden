/** Defaults are rendered from the existing builders in token mode. Keeping the
 * builder as the source of truth avoids a second, drifting copy of its words. */
import { defaultCompilePrompt, defaultSplitPrompt } from '../policy/prompts.js';
import { nativeDefaults, defaultDynaguardClauses, defaultDynaguardPolicyUser, defaultDynaguardUser, defaultSystemPrompt, type Form, type FormOptions } from '../guard/passes/forms.js';
import type { Rule } from '../policy/types.js';
import type { Isolated } from '../guard/isolate.js';
import { defaultRewriteSystem } from '../guard/rewrite.js';

export type PromptDefinition = {
  id: string; role: 'compiler' | 'adjudicator'; name: string; description: string;
  defaultTemplate: string; tokens: { name: string; description: string; required: boolean }[]; outputContract: string;
};
const TOKEN_DESCRIPTION: Record<string, string> = {
  conversation: 'Administrator conversation history and current draft rules; empty on a first message.',
  roles: 'Current authorized company role names.', roster: 'Current employee identifiers and permitted names; empty when no employees exist.',
  followup: 'Instructions for updating the existing draft set; empty without current drafts.',
  maxStatements: 'Maximum number of statements accepted by the split response schema.',
  isolation: 'Required instructions matching this request’s nonce envelope. The isolation code supplies this block.',
  thinking: 'Current model’s thinking control marker, or an empty string when the model does not use one.',
  message: 'The current message supplied by the isolation layer, including its nonce fence when that form uses one.',
  rule: 'The ratified rule text for the current adjudication.',
  boundary: 'The current rule’s NOT COVERED clause, or an empty string when absent.',
  examples: 'Selected examples for the current rule, formatted for this model’s labels.',
  policy: 'The current rule and selected examples, using the selected DynaGuard policy template; numbered in native mode.',
  policies: 'Every rule selected for this screening call, numbered in order.',
  nextRuleIndex: 'The number immediately after the last screened rule.',
  guidance: 'Current rule guidance for legitimate next steps, or an empty string.',
  allowed: 'The current rule’s selected compliant examples.'
};
const CONTRACT = {
  compiler: 'Structured JSON matching the existing RuleDraft schema. Warden validates fields and the administrator must ratify a draft. This editor cannot change the response schema or activate a rule.',
  split: 'Structured JSON containing statements, bounded by the existing PolicySplit schema. Warden validates the result before compiling each statement.',
  compliance: 'Exactly one verdict field: VIOLATES, COMPLIES or UNCLEAR. The fixed parser and aggregate verdict ordering remain authoritative.',
  choice: 'Exactly one verdict field: VIOLATES, ORDINARY_REQUEST or UNCLEAR. ORDINARY_REQUEST maps to COMPLIES; the fixed aggregator remains authoritative.',
  dynaguard: 'Exactly one verdict field: FAIL or PASS. FAIL maps to VIOLATES and PASS to COMPLIES. The parser, isolation and aggregate verdict ordering cannot be edited here.',
  'dynaguard-native': 'A native PASS or FAIL answer accepted by the existing DynaGuard parser. Unparseable output fails closed. This editor does not change the parser.',
  rewrite: 'Structured JSON with one rewritten string. Empty means no suggestion. A nonempty rewrite must pass the unchanged guard before it is shown.'
};
function definition(id: string, name: string, description: string, template: string, tokens: string[], outputContract: string): PromptDefinition {
  return { id, name, description, defaultTemplate: template, role: id.startsWith('compiler.') ? 'compiler' : 'adjudicator',
    tokens: tokens.map((name) => ({ name, description: TOKEN_DESCRIPTION[name] ?? name, required: true })), outputContract };
}
export function definitions(): PromptDefinition[] {
  const rule = { text: '', boundary: '', examples: { violating: [], compliant: [] } } as unknown as Rule;
  const iso = { clean: '', envelope: '', nonce: '' } as Isolated;
  const shots = { violating: [], compliant: [] };
  const result = [
    definition('compiler.compile.system', 'Compile a rule · instructions', 'System instructions used to draft one administrator rule.', defaultCompilePrompt([], [], '', undefined, true), ['conversation', 'roles', 'roster', 'isolation', 'thinking'], CONTRACT.compiler),
    definition('compiler.compile.user', 'Compile a rule · request', 'The isolated administrator statement and final compile instruction.', '{{message}}\n\nConvert the statement above into a rule.', ['message'], CONTRACT.compiler),
    definition('compiler.split.system', 'Split a policy · instructions', 'System instructions used to turn a broad administrator request into rule statements.', defaultSplitPrompt('', undefined, true), ['conversation', 'followup', 'maxStatements', 'isolation', 'thinking'], CONTRACT.split),
    definition('compiler.split.user', 'Split a policy · request', 'The isolated broad administrator instruction.', '{{message}}\n\nSplit the instruction above.', ['message'], CONTRACT.split)
  ];
  for (const form of ['compliance', 'choice'] as const) {
    result.push(definition(`analyzer.${form}.system`, `${form} · instructions`, 'Single-rule analyzer instructions for this response format.', defaultSystemPrompt(rule, '', form, shots, true), ['rule', 'boundary', 'examples', 'isolation', 'thinking'], CONTRACT[form]),
      definition(`analyzer.${form}.user`, `${form} · message`, 'The isolated employee message judged against one rule.', '{{message}}\n\nLabel the message against the rule.', ['message'], CONTRACT[form]));
  }
  for (const form of ['dynaguard', 'dynaguard-native'] as const) {
    const opts: FormOptions = { form, dynaguardPolicy: 'v1', dynaguardFence: true };
    result.push(definition(`analyzer.${form}.system`, `${form} · instructions`, 'System slot used by both single-rule and optional multi-rule screening calls.', '{{thinking}}', ['thinking'], CONTRACT[form]),
      definition(`analyzer.${form}.user`, `${form} · message`, 'Policy and isolated dialogue for a single-rule analyzer call.', defaultDynaguardUser(rule, iso, shots, opts, true), ['policy', 'message'], CONTRACT[form]),
      definition(`analyzer.${form}.screen.user`, `${form} · policy screening`, 'Optional whole-policy screening; document checks do not use this shortcut.', defaultDynaguardPolicyUser([], iso, opts, true), ['policies', 'nextRuleIndex', 'message'], CONTRACT[form]));
  }
  for (const form of ['shieldstral', 'granite-guardian'] as const) {
    const defaults = nativeDefaults(form);
    const contract = 'Native yes/no verdict. yes maps to VIOLATES and no to COMPLIES. Invalid or incomplete output fails closed. Accuracy is not yet measured in Warden.';
    result.push(definition(`analyzer.${form}.system`, `${form} · instructions`, form === 'granite-guardian' ? 'Judging instructions sent as the second user turn required by Granite Guardian.' : 'Publisher-native system instructions.', defaults.system, form === 'granite-guardian' ? ['rule', 'boundary', 'examples', 'isolation'] : [], contract),
      definition(`analyzer.${form}.user`, `${form} · message`, 'The isolated message judged against one rule.', defaults.user, form === 'shieldstral' ? ['rule', 'boundary', 'examples', 'isolation', 'message'] : ['message'], contract));
  }
  for (const policy of ['v1', 'v2'] as const) result.push(definition(`analyzer.dynaguard.policy.${policy}`, `DynaGuard policy · ${policy}`, policy === 'v1' ? 'Rule policy block used by the shipped DynaGuard form.' : 'Experimental policy variant, used only when explicitly selected.', defaultDynaguardClauses(rule, shots, policy, true).join('\n'), ['rule', 'examples'], CONTRACT.dynaguard));
  result.push(definition('analyzer.rewrite.system', 'Suggest a rewrite · instructions', 'Auxiliary analyzer instructions for an employee-requested rewrite after a refusal. The result must pass the ordinary guard.', defaultRewriteSystem(rule, '', true), ['rule', 'guidance', 'allowed', 'isolation', 'thinking'], CONTRACT.rewrite),
    definition('analyzer.rewrite.user', 'Suggest a rewrite · request', 'The isolated refused message to rephrase. Existing rewrite eligibility and recheck gates remain unchanged.', '{{message}}\n\nRewrite the message.', ['message'], CONTRACT.rewrite));
  return result;
}

export function templateIsActive(id: string, form: Form, policy: 'v1' | 'v2', screen: boolean): boolean {
  if (id.startsWith('compiler.')) return true;
  if (id.startsWith('analyzer.rewrite.')) return form !== 'shieldstral' && form !== 'granite-guardian';
  if (id.startsWith('analyzer.dynaguard.policy.')) return (form === 'dynaguard' || form === 'dynaguard-native') && id.endsWith(policy);
  if (id.includes('.screen.')) return id.startsWith(`analyzer.${form}.`) && screen;
  return id.startsWith(`analyzer.${form}.`);
}
