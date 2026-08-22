/**
 * Turning what an admin says into policy the guard can enforce.
 *
 * The model drafts; the admin ratifies. That split is not politeness — it is
 * the security boundary. If compilation could enact policy on its own, someone
 * who reached the compiler could talk it into writing a permissive rule, and
 * every guarantee downstream would rest on a 1.7B model's judgement about who
 * is allowed to define the rules.
 */
import { randomUUID } from 'node:crypto';
import type { QvacAdapter } from '../qvac/types.js';
import { isolate, isolationPreamble } from '../guard/isolate.js';
import { adjudicate } from '../guard/passes/adjudicate.js';
import { EVERYONE, employeeToken, sanitiseAudience } from './audience.js';
import { loadDirectory } from './people.js';
import { loadPolicy, savePolicy } from './store.js';
import {
  RULE_DRAFT_JSON_SCHEMA,
  ruleDraftSchema,
  ruleSchema,
  type PolicySpec,
  type Rule,
  type RuleDraft
} from './types.js';

/**
 * Compile an admin's sentence into a structured rule.
 *
 * Two things about this prompt earn their place. The role list is injected so
 * `appliesTo` resolves to roles that exist rather than plausible inventions.
 * And the instruction to produce compliant examples is emphatic, because a
 * model asked for "examples" of a prohibition supplies only violations, and a
 * rule with no compliant anchors teaches the adjudicator to block on sight.
 */
export type CompileOptions = {
  /** Role names the rule may bind. Defaults to the company directory. */
  roles?: string[];
  /** People the rule may bind by name. Defaults to the company directory. */
  people?: { id: string; name: string }[];
  /**
   * Force the audience instead of letting the model choose it.
   *
   * Set when the admin is writing a rule from inside one person's page: they
   * have already said who it is for by being there, and asking a 1.7B model to
   * re-derive that from prose is a way to get it wrong.
   */
  lockTo?: string[];
};

export async function compileRule(
  qvac: QvacAdapter,
  text: string,
  policy: PolicySpec,
  options: CompileOptions = {}
): Promise<Rule> {
  const directory = safeDirectory();
  const roles = options.roles ?? directory.roles;
  const people = options.people ?? directory.employees;
  const iso = isolate(text);

  const system = [
    'You convert a policy statement written by a company administrator into a structured rule.',
    '',
    `Valid role names: ${roles.join(', ')}.`,
    // Naming the people is what makes "Ana cannot ask for payroll" compile into
    // a rule about Ana rather than a rule about everyone. Without the roster the
    // model has no token for a person and defaults to the whole company, which
    // is a much broader rule than the admin asked for.
    people.length > 0
      ? `Named employees, referred to with an @ prefix: ${people.map((p) => `${employeeToken(p.id)} (${p.name})`).join(', ')}.`
      : '',
    'Use ["*"] when the rule binds everyone.',
    '',
    'Fields:',
    '- text: one unambiguous sentence stating what is prohibited, in English.',
    '- scope: "input" for what employees send, "output" for what the assistant returns, "both".',
    '- appliesTo: who the rule binds — role names, @employee tokens, or ["*"].',
    '  Bind it to a person only when the administrator named that person.',
    '- severity: "block" to refuse outright, "escalate" to route to a human.',
    '- examples.violating: 2-3 realistic requests this rule should stop.',
    '- examples.compliant: 2-3 realistic requests that are NEARBY but legitimate and',
    '  must still be allowed. These matter most. Without them the rule blocks honest work.',
    '',
    'Write examples in the same language the administrator used.',
    isolationPreamble(iso.nonce),
    '/no_think'
  ]
    .filter(Boolean)
    .join('\n');

  const res = await qvac.completeJSON<RuleDraft>(
    {
      role: 'adjudicator',
      system,
      user: `${iso.envelope}\n\nConvert the statement above into a rule.`,
      maxTokens: 640,
      timeoutMs: 60_000
    },
    ruleDraftSchema,
    RULE_DRAFT_JSON_SCHEMA
  );

  const draft = res.value;
  return ruleSchema.parse({
    ...draft,
    id: `r-${slug(draft.text)}-${randomUUID().slice(0, 4)}`,
    // Keep only audiences that exist. A hallucinated role or employee id would
    // silently narrow the rule to nobody, which fails open — the one direction
    // we never accept.
    appliesTo:
      options.lockTo ??
      sanitiseAudience(draft.appliesTo, roles, people.map((p) => p.id))
  });
}

export type PreviewRow = {
  prompt: string;
  expected: 'BLOCK' | 'ALLOW';
  verdict: 'BLOCK' | 'ALLOW' | 'ESCALATE';
  confidence: number;
  reason: string;
  /** Legitimate request the candidate rule would wrongly stop. */
  isFalsePositive: boolean;
  /** Violation the candidate rule would wrongly let through. */
  isMiss: boolean;
};

/**
 * Show the admin how a candidate rule behaves before it can affect anyone.
 *
 * Runs the rule's own examples through the real adjudicator — the same code
 * path that will judge live traffic, so the preview cannot flatter itself. A
 * rule that reads sensibly and still blocks its own compliant examples is the
 * common failure, and this is where it surfaces: before twenty people lose an
 * afternoon to it, rather than after.
 */
export async function previewRule(
  qvac: QvacAdapter,
  rule: Rule,
  _policy?: PolicySpec
): Promise<{ rows: PreviewRow[]; falsePositives: number; misses: number }> {
  const parsed = ruleSchema.parse(rule);

  const cases: { prompt: string; expected: 'BLOCK' | 'ALLOW' }[] = [
    ...parsed.examples.violating.map((p) => ({ prompt: p, expected: 'BLOCK' as const })),
    ...parsed.examples.compliant.map((p) => ({ prompt: p, expected: 'ALLOW' as const }))
  ];

  const rows = await Promise.all(
    cases.map(async ({ prompt, expected }): Promise<PreviewRow> => {
      const iso = isolate(prompt);
      try {
        const { verdict } = await adjudicate(qvac, iso, parsed);
        const decided = verdict.violates
          ? parsed.severity === 'block' ? 'BLOCK' : 'ESCALATE'
          : 'ALLOW';
        return {
          prompt, expected, verdict: decided,
          confidence: verdict.confidence,
          reason: verdict.reason,
          isFalsePositive: expected === 'ALLOW' && decided !== 'ALLOW',
          isMiss: expected === 'BLOCK' && decided === 'ALLOW'
        };
      } catch (err) {
        // A pass that cannot decide escalates, exactly as it would in production.
        return {
          prompt, expected, verdict: 'ESCALATE', confidence: 0,
          reason: `could not evaluate: ${err instanceof Error ? err.message : String(err)}`,
          isFalsePositive: expected === 'ALLOW',
          isMiss: false
        };
      }
    })
  );

  return {
    rows,
    falsePositives: rows.filter((r) => r.isFalsePositive).length,
    misses: rows.filter((r) => r.isMiss).length
  };
}

/**
 * Put a rule into force.
 *
 * The only path that changes what employees are judged against, which is why
 * it lives behind an explicit admin action rather than happening at the end of
 * compilation.
 */
export async function ratifyRule(rule: Rule): Promise<PolicySpec> {
  const parsed = ruleSchema.parse(rule);
  const current = loadPolicy();
  const rules = current.rules.filter((r) => r.id !== parsed.id).concat(parsed);
  return savePolicy(rules, current.quotas);
}

export async function removeRule(ruleId: string): Promise<PolicySpec> {
  const current = loadPolicy();
  return savePolicy(current.rules.filter((r) => r.id !== ruleId), current.quotas);
}

/**
 * The directory, or an empty stand-in.
 *
 * Compilation must not fail because the company file is missing — a fresh
 * clone with no directory can still write company-wide rules, which is the
 * first thing anyone does. The fallback binds everyone, the broad direction.
 */
function safeDirectory(): { roles: string[]; employees: { id: string; name: string }[] } {
  try {
    const dir = loadDirectory();
    return { roles: dir.roles, employees: dir.employees };
  } catch {
    return { roles: [EVERYONE], employees: [] };
  }
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .split('-')
    .filter(Boolean)
    .slice(0, 4)
    .join('-');
}
