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
import { thinkingMarker } from '../qvac/client.js';
import { redactNames, remoteCompilerConfig } from '../qvac/remote.js';
import { isolate, isolationPreamble } from '../guard/isolate.js';
import { adjudicate } from '../guard/passes/adjudicate.js';
import { EVERYONE, employeeIdOf, employeeToken, sanitiseAudience } from './audience.js';
import { loadDirectory } from './people.js';
import { loadPolicy, savePolicy } from './store.js';
import {
  POLICY_SPLIT_JSON_SCHEMA,
  RULE_DRAFT_JSON_SCHEMA,
  policySplitSchema,
  ruleDraftSchema,
  ruleSchema,
  type PolicySpec,
  type PolicySplit,
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
      ? `Named employees, referred to with an @ prefix: ${people.map((p) => roster(p)).join(', ')}.`
      : '',
    'Use ["*"] when the rule binds everyone.',
    '',
    'Fields:',
    '- text: one unambiguous sentence stating what is prohibited, in English.',
    '- scope: "input" for what employees send, "output" for what the assistant returns, "both".',
    '- appliesTo: who the rule binds — role names, @employee tokens, or ["*"].',
    '  Bind it to a person only when the administrator named that person.',
    '- severity: "block" to refuse outright, "escalate" to route to a human,',
    '  "warn" to let the request through with a note saying why it was flagged.',
    '  Choose "warn" when the admin asks to be told rather than protected — when',
    '  they say to flag, note, remind, or keep an eye on something rather than',
    '  stop it, or when the rule is a preference rather than a prohibition.',
    '- guidance: one sentence telling an employee who just hit this rule what to do',
    '  instead — who to ask, or which nearby request is fine. Write it to them, not',
    '  about them. Never restate the prohibition; they already saw it.',
    '- examples.violating: 2-3 realistic requests this rule should stop.',
    '- examples.compliant: 2-3 realistic requests that are NEARBY but legitimate and',
    '  must still be allowed. These matter most. Without them the rule blocks honest work.',
    '',
    'Write examples in the same language the administrator used.',
    isolationPreamble(iso.nonce),
    // The compiler's marker, not the adjudicator's. They are the same local
    // model by default, and they are not the same model at all once
    // compilation is remote: this was emitting Qwen's `/no_think` control
    // token into a request bound for another vendor's API, which is the exact
    // failure `thinkingMarker` was written to prevent, one role over.
    thinkingMarker('compiler')
  ]
    .filter(Boolean)
    .join('\n');

  const res = await qvac.completeJSON<RuleDraft>(
    {
      // Not 'adjudicator', though it is the same local weights by default.
      // The distinct role is what lets a deployment put compilation on a model
      // it does not own without putting a single employee prompt there — see
      // `qvac/remote.ts`. Judging is not configurable in that direction.
      role: 'compiler',
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

/**
 * Ceiling on how many rules one instruction may become.
 *
 * Not a tuning knob. It is here because "stop people leaking data" is an
 * invitation to enumerate, and a model that answers it with fifteen rules has
 * handed the administrator a ratification queue nobody works through — at
 * which point they activate the list without reading it, and a model has
 * written policy after all. Five is the most a person will actually read.
 */
const MAX_STATEMENTS = 5;

/**
 * Split one broad instruction into the specific prohibitions it means.
 *
 * Fails soft, and the direction matters: a split that errors, times out, or
 * comes back unparseable returns the administrator's own sentence unchanged,
 * so the broad path degrades into the narrow one that already worked rather
 * than into an error page. It cannot fail open in the security sense — nothing
 * here decides anything, and every sentence it returns still has to survive
 * `compileRule` and then be ratified by a person.
 */
async function splitStatement(qvac: QvacAdapter, text: string): Promise<string[]> {
  const iso = isolate(text);

  const system = [
    'A company administrator has said what they want stopped, in their own words.',
    'Split it into separate, specific prohibitions — one sentence each.',
    '',
    `- At most ${MAX_STATEMENTS} statements, and fewer is better.`,
    '- Each one stands alone and names one concrete thing that is prohibited.',
    '- Never restate another one in different words.',
    // The one instruction that is a security instruction rather than a quality
    // one. An administrator who asks about customer data and gets back a rule
    // about overtime has been handed policy nobody asked for, and the fact
    // that they still have to ratify it is not a reason to put it in front of
    // them: a queue of plausible rules is exactly how ratification stops being
    // read.
    '- Stay strictly inside what was asked. Never add a prohibition the administrator did not ask for.',
    '- If what they said is already one specific prohibition, return it as the only statement.',
    '- Write them in the language the administrator used.',
    isolationPreamble(iso.nonce),
    thinkingMarker('compiler')
  ].join('\n');

  try {
    const res = await qvac.completeJSON<PolicySplit>(
      {
        role: 'compiler',
        system,
        user: `${iso.envelope}\n\nSplit the instruction above.`,
        // Five statements of ordinary length are well inside this, and the
        // margin is deliberate: a split that overran the cap would come back
        // as truncated JSON, fail to parse, and be caught below as "compile
        // the administrator's sentence as one rule" — a silent degradation
        // that looks exactly like the model deciding it was already specific.
        maxTokens: 512,
        timeoutMs: 60_000
      },
      policySplitSchema,
      POLICY_SPLIT_JSON_SCHEMA
    );

    const seen = new Set<string>();
    const statements: string[] = [];
    for (const raw of res.value.statements) {
      const statement = raw.trim();
      const key = statement.toLowerCase();
      if (!statement || seen.has(key)) continue;
      seen.add(key);
      statements.push(statement);
    }
    // A split of one is not a split. The pass was asked to break a worry into
    // parts and came back with the administrator's own sentence — so use the
    // administrator's own sentence, not the model's paraphrase of it.
    //
    // This is not tidiness. Measured on 2026-09-01 against Qwen3-1.7B-Q4_0,
    // the paraphrase is where the damage was: "nadie puede mandar datos de
    // clientes afuera de la empresa" came back as "nadar datos de clientes",
    // and "dejen de filtrar datos de clientes" came back as a rule against
    // *filtering* customer data — the false friend — whose compliant example
    // was "send customer data to a third-party for analysis". A pass that
    // returns one statement can now only return the one it was given, so the
    // worst failure this pass had is structurally gone rather than prompted
    // against.
    if (statements.length === 1) return [text];
    return statements.length > 0 ? statements.slice(0, MAX_STATEMENTS) : [text];
  } catch {
    return [text];
  }
}

/**
 * Compile one broad instruction into a set of specific rules.
 *
 * This is the sentence an administrator actually says out loud — "I want them
 * to stop leaking customer data" — and it is not a rule. `compileRule` would
 * take it and produce something technically valid and practically useless: one
 * prohibition wide enough to cover the whole worry, which is one prohibition
 * wide enough to refuse the day's honest work.
 *
 * Two passes and not one, deliberately. Asking a single call for N complete
 * rules would multiply a 640-token cap by N and give every field of every rule
 * another chance to be filled in without being decided — which is the failure
 * `docs/MEASUREMENTS.md` records for every extra field this compiler has ever
 * been asked to produce. So the split pass is asked for sentences only, and
 * the second pass is `compileRule`, unchanged and already measured, once each.
 *
 * Sequentially, not in parallel. The adapter batches concurrent work and the
 * measurement note in CLAUDE.md is explicit that batch composition moves the
 * numerics; a rule whose examples depend on what else happened to be in flight
 * is a rule that cannot be reproduced. On the machine this was written for it
 * is also simply faster.
 *
 * Which makes this the slowest thing in the product by a distance: the split,
 * then up to five compilations, each of which takes what a compilation takes.
 * On the four-core CPU the 46-second figure in CLAUDE.md was measured on, a
 * five-rule set is minutes. That is a fact about the machine and not a reason
 * to parallelise it into unreproducibility, but a caller putting this behind a
 * request needs to know it is not a request that returns quickly.
 *
 * **The boundary is unchanged.** The model drafts, the administrator ratifies,
 * one rule at a time, and a draft nobody ratified has never judged anybody.
 * Nothing in this function writes to the policy.
 */
export async function compilePolicy(
  qvac: QvacAdapter,
  text: string,
  policy: PolicySpec,
  options: CompileOptions = {}
): Promise<{ statements: string[]; rules: Rule[] }> {
  const statements = await splitStatement(qvac, text);

  const rules: Rule[] = [];
  for (const statement of statements) {
    rules.push(await compileRule(qvac, statement, policy, options));
  }

  return { statements, rules };
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
  /** Where the case came from: the compiler's own examples, or the audit log. */
  source: 'example' | 'log';
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
  _policy?: PolicySpec,
  /**
   * Extra cases judged alongside the compiler's own examples.
   *
   * The console passes prompts the gateway has already allowed, so the admin
   * can ask the question that actually matters before shipping a rule: would
   * this have stopped work that went through fine last week? A rule that reads
   * well against invented examples and blocks real traffic is exactly the
   * failure the examples cannot catch, because the compiler wrote them.
   */
  against: { prompt: string; expected: 'BLOCK' | 'ALLOW' }[] = []
): Promise<{ rows: PreviewRow[]; falsePositives: number; misses: number }> {
  const parsed = ruleSchema.parse(rule);

  const cases: { prompt: string; expected: 'BLOCK' | 'ALLOW'; source: 'example' | 'log' }[] = [
    ...parsed.examples.violating.map((p) => ({ prompt: p, expected: 'BLOCK' as const, source: 'example' as const })),
    ...parsed.examples.compliant.map((p) => ({ prompt: p, expected: 'ALLOW' as const, source: 'example' as const })),
    ...against.map((c) => ({ prompt: c.prompt, expected: c.expected, source: 'log' as const }))
  ];

  const rows = await Promise.all(
    cases.map(async ({ prompt, expected, source }): Promise<PreviewRow> => {
      const iso = isolate(prompt);
      try {
        const { verdict } = await adjudicate(qvac, iso, parsed);
        const decided = verdict.violates
          ? parsed.severity === 'block'
            ? 'BLOCK'
            // A `warn` rule fires without stopping anything, so a preview of it
            // firing has to read ALLOW. Showing ESCALATE here would preview a
            // refusal the ratified rule will never produce, which is the one
            // thing this preview exists to get right.
            : parsed.severity === 'warn' ? 'ALLOW' : 'ESCALATE'
          : 'ALLOW';
        return {
          prompt, expected, source, verdict: decided,
          confidence: verdict.confidence,
          reason: verdict.reason,
          isFalsePositive: expected === 'ALLOW' && decided !== 'ALLOW',
          isMiss: expected === 'BLOCK' && decided === 'ALLOW'
        };
      } catch (err) {
        // A pass that cannot decide escalates, exactly as it would in production.
        return {
          prompt, expected, source, verdict: 'ESCALATE', confidence: 0,
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
 *
 * The audience is re-checked here, not only at compile time: the console edits
 * `appliesTo` freely between the two steps, and a person can leave the
 * directory in the gap. A token naming nobody would store a rule that displays
 * normally and binds no one — failing open while looking active — so ratify
 * refuses it loudly instead of silently widening or narrowing the rule.
 */
export async function ratifyRule(rule: Rule): Promise<PolicySpec> {
  const parsed = ruleSchema.parse(rule);

  const dir = tryDirectory();
  if (dir) {
    const unknown = parsed.appliesTo.filter((token) => {
      if (token === EVERYONE) return false;
      const id = employeeIdOf(token);
      return id !== null
        ? !dir.employees.some((p) => p.id === id)
        : !dir.roles.includes(token);
    });
    if (unknown.length > 0) {
      throw new Error(
        `audience names nobody in the directory (${unknown.join(', ')}) — fix who the rule binds, then activate`
      );
    }
  }

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

/** The directory, or null when it cannot be read — callers decide what degrades. */
function tryDirectory(): { roles: string[]; employees: { id: string }[] } | null {
  try {
    const dir = loadDirectory();
    return { roles: dir.roles, employees: dir.employees };
  } catch {
    return null;
  }
}

/**
 * How one employee is named to the model.
 *
 * The display name is what makes "Ana cannot ask for payroll" compile into a
 * rule about Ana, so it is sent by default and the rule is better for it. When
 * compilation is remote, `WARDEN_COMPILER_REDACT_NAMES=1` reduces this to the
 * opaque token: the provider then sees `@e-01` and never the person. That is a
 * real accuracy cost paid deliberately, which is why it is a setting and not a
 * default — and why redaction is ignored when the model is local, where there
 * is no third party to withhold anything from.
 */
function roster(p: { id: string; name: string }): string {
  const token = employeeToken(p.id);
  const withhold = redactNames() && remoteCompilerConfig() !== null;
  return withhold ? token : `${token} (${p.name})`;
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
