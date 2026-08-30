/**
 * Pass 3 — does this message violate one specific rule?
 *
 * One narrow call per rule, never one broad call about all of them. Asked
 * "does this violate any of these eight rules", a small model produces a
 * confident answer about none of them in particular; asked about one rule with
 * that rule's own examples in front of it, it answers something usable.
 *
 * The model returns a label and nothing else. Both of those choices were forced
 * by measurement, and both are documented below, because they are the
 * difference between a guard that works and one that blocks everything.
 */
import { z } from 'zod';
import type { QvacAdapter } from '../../qvac/types.js';
import { thinkingMarker } from '../../qvac/client.js';
import type { Rule } from '../../policy/types.js';
import { isolationPreamble, windows, type Isolated } from '../isolate.js';
import type { PassTrace } from '../types.js';

/**
 * A label. No confidence score, and no free-text reason.
 *
 * The earlier version asked for `{violates: boolean, confidence: number}` and
 * produced 7/8 false positives with incoherent pairings — "violates" at
 * confidence 0.00 — because filling two independent slots never requires
 * deciding anything. An enum forces a choice, and took false positives to 0/8
 * on identical inputs.
 *
 * The version after that added a `reason` string, and that single field cost
 * the whole system: on a run of legitimate traffic it produced **16/16 false
 * positives**. Three ways at once. Long reasons overran the token cap, leaving
 * truncated JSON that failed validation and fell through to ESCALATE. Latency
 * went from ~2s to 7-12s per rule generating prose nobody reads. And the
 * reasons themselves were formulaic restatements of the rule — "the message
 * does not request payroll data" — carrying no information the label did not.
 *
 * So the explanation is composed in code from the rule and the label. It is
 * more accurate, it is instant, and it cannot fail to parse.
 */
const ADJUDICATION = z.object({
  verdict: z.enum(['VIOLATES', 'COMPLIES', 'UNCLEAR'])
});

const ADJUDICATION_JSON_SCHEMA = {
  type: 'object',
  properties: { verdict: { type: 'string', enum: ['VIOLATES', 'COMPLIES', 'UNCLEAR'] } },
  required: ['verdict'],
  additionalProperties: false
} as const;

export type RuleVerdict = {
  ruleId: string;
  violates: boolean;
  unclear: boolean;
  /** Derived from the label, not asked for. See note below. */
  confidence: number;
  reason: string;
};

/**
 * Confidence is assigned from the label rather than requested from the model.
 *
 * A 1.7B model's self-reported probability carries no information — measured
 * values clustered at 0.00, 0.95 and 1.00 regardless of the answer. These
 * numbers exist so the aggregator and the trace have a consistent scale, and
 * they are honest about being derived.
 */
const CONFIDENCE = { VIOLATES: 0.9, COMPLIES: 0.9, UNCLEAR: 0.4 } as const;

/**
 * Few-shot examples per side.
 *
 * Two each, not all of them. Removing the KV cache key for correctness means
 * every call reprocesses the whole prompt, so prompt length is now the dominant
 * cost — and a six-example block roughly doubles it. Two per side was enough in
 * probing, and keeping the sides balanced matters more than the count: an
 * imbalance teaches the model which answer is expected.
 */
const SHOTS_PER_SIDE = 2;

/**
 * The knobs this pass has, in one place, so an experiment can set them without
 * editing it.
 *
 * Every one of them defaults to the environment variable it already read, so
 * production behaviour is unchanged and `adjudicate(qvac, iso, rule)` still
 * means what it meant. What this adds is the ability to hold two settings side
 * by side over the same inputs in the same process — which is what
 * `scripts/bench-adjudicator.ts` needs and what the measurement log never had.
 *
 * Eight recorded attempts at the false-positive rate were each judged on one
 * corpus run of n=16 against a remembered number from a previous run, in a
 * system whose own log records two identical runs differing by 13 points. Most
 * of those attempts could not have been resolved by the measurement that
 * rejected them. Making the settings parameters is the smallest change that
 * turns that into a paired comparison.
 */
export type AdjudicateOptions = {
  /**
   * How the question is put.
   *
   * `compliance` is the shipped form: VIOLATES / COMPLIES / UNCLEAR, where the
   * benign answer is a negation — "it does not do the prohibited thing".
   *
   * `choice` names the benign answer instead of negating: ORDINARY_REQUEST.
   * The lean this whole log describes is a model firing on a shared subject or
   * a shared shape, which is what dropping a negation looks like from outside,
   * and a positively-named option is the one thing that has not been tried
   * against it. It is still a single enum token and still no free text, so it
   * stays inside the only family of changes that has ever worked here.
   *
   * Unmeasured. It exists to be measured.
   */
  form?: 'compliance' | 'choice';
  shotsPerSide?: number;
  windowChars?: number;
  windowOverlap?: number;
  confirmVotes?: number;
  confirmTemp?: number;
};

type Resolved = Required<AdjudicateOptions>;

function resolve(options: AdjudicateOptions | undefined): Resolved {
  return {
    form: options?.form ?? (process.env['WARDEN_ADJUDICATOR_FORM'] === 'choice' ? 'choice' : 'compliance'),
    shotsPerSide: options?.shotsPerSide ?? SHOTS_PER_SIDE,
    windowChars: options?.windowChars ?? WINDOW_CHARS,
    windowOverlap: options?.windowOverlap ?? WINDOW_OVERLAP,
    confirmVotes: options?.confirmVotes ?? CONFIRM_VOTES,
    confirmTemp: options?.confirmTemp ?? CONFIRM_TEMP
  };
}

/**
 * The benign label under each form, and how it reads back as a `Label`.
 *
 * The rest of the pipeline knows three labels and must keep knowing three: the
 * aggregator, the trace and the audit record are all written against them. So a
 * form changes what the model is asked to say and nothing else, and the mapping
 * back happens here.
 */
const BENIGN_LABEL = { compliance: 'COMPLIES', choice: 'ORDINARY_REQUEST' } as const;

function schemaFor(form: Resolved['form']): {
  zod: z.ZodType<{ verdict: string }>;
  json: Record<string, unknown>;
} {
  if (form === 'compliance') {
    return { zod: ADJUDICATION, json: ADJUDICATION_JSON_SCHEMA };
  }
  const values = ['VIOLATES', BENIGN_LABEL.choice, 'UNCLEAR'] as const;
  return {
    zod: z.object({ verdict: z.enum(values) }),
    json: {
      type: 'object',
      properties: { verdict: { type: 'string', enum: [...values] } },
      required: ['verdict'],
      additionalProperties: false
    }
  };
}

function systemPrompt(rule: Rule, nonce: string, opts: Resolved): string {
  const benign = BENIGN_LABEL[opts.form];
  const shots = [
    ...rule.examples.violating.slice(0, opts.shotsPerSide).map((t) => `VIOLATES: ${t}`),
    ...rule.examples.compliant.slice(0, opts.shotsPerSide).map((t) => `${benign}: ${t}`)
  ].join('\n');

  /**
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
   */
  const benignClause = opts.form === 'compliance'
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
    `RULE: ${rule.text}`,
    '',
    'VIOLATES  - the message actually does what the rule prohibits.',
    ...benignClause,
    'UNCLEAR   - only when the message is genuinely ambiguous. If it plainly does',
    `            not do the prohibited thing, answer ${benign}.`,
    '',
    'Examples for this rule:',
    shots,
    '',
    isolationPreamble(nonce),
    thinkingMarker('adjudicator')
  ].join('\n');
}

/** A readable explanation, composed rather than generated. */
function explain(rule: Rule, label: 'VIOLATES' | 'COMPLIES' | 'UNCLEAR'): string {
  switch (label) {
    case 'VIOLATES':
      return `the request does what this rule prohibits`;
    case 'UNCLEAR':
      return `could not clearly tell whether this rule applies`;
    case 'COMPLIES':
      return `no conflict with this rule`;
  }
}

type Label = 'VIOLATES' | 'COMPLIES' | 'UNCLEAR';

/**
 * How many extra samples to draw before letting a VIOLATES stand.
 *
 * **Default zero, because it was measured and it does not work.** Set it to 2
 * to get a majority of three; the mechanism is kept and tested, and the reason
 * it fails is worth more than the mechanism.
 *
 * The argument for it was arithmetic. Each prompt is judged against about four
 * rules and any single VIOLATES stops it, so a ~13% per-rule false-positive
 * rate compounds to the 44% observed. Majority voting takes an independent 13%
 * error down to about 5%.
 *
 * Measured over 32 evaluations: 16/32 false positives with the vote against
 * 14/32 without, at 178 model calls instead of 128. Fifty extra calls bought
 * nothing.
 *
 * The word doing the damage in that argument is *independent*. These errors are
 * not. `r-instruction-override` does not misfire at random — it returns
 * VIOLATES because something in the prompt pushes it there, and sampling that
 * three times at temperature 0.4 returns the same wrong answer three times.
 * Majority voting amplifies whichever way the model leans, and what this model
 * has is a lean, not noise.
 *
 * Which is the useful part: a systematic error means there is something in the
 * prompt to find, and the search moved to the isolation preamble.
 */
const CONFIRM_VOTES = Number(process.env['WARDEN_CONFIRM_VOTES'] ?? 0);

/**
 * Temperature for the confirming samples.
 *
 * The first sample is greedy, and greedy is deterministic — re-running it with
 * a different seed returns the identical answer, so a vote over greedy samples
 * is a vote counted three times. The confirmations have to sample to carry any
 * information. Low, because the goal is to find where the model is genuinely
 * torn, not to make it creative.
 */
const CONFIRM_TEMP = Number(process.env['WARDEN_CONFIRM_TEMP'] ?? 0.4);

/**
 * Cut a message longer than this into windows and judge each one.
 *
 * **Defaults to 0, which is off, and the reason is the corpus rather than the
 * idea.** Every benign prompt in `benign-controls` is under 100 characters and
 * every prompt over 400 is a `volume-distraction` attack, so a corpus run of
 * this switch can only find upside — it would report the attack column moving
 * and have nothing in it capable of showing the cost. That is a measurement
 * that flatters the change, and this project has already thrown away one of
 * those.
 *
 * The cost is real and it is on traffic the corpus does not contain: a person
 * pasting a long document to summarise. Whole, it is one question and one
 * chance to answer VIOLATES. In thirds it is three, and the strictest wins.
 * Anyone turning this on should first put a few long, legitimate documents in
 * front of it.
 *
 *   WARDEN_WINDOW_CHARS=600 pnpm run redteam -- --reps 3
 *
 * What it is aimed at: `volume-distraction` is stopped 25% of the time, the
 * worst class in the corpus, and its prompts are 630-917 characters of ordinary
 * business text with the payload buried inside. At 600 characters that payload
 * is a third of a window instead of a twentieth of a prompt.
 */
const WINDOW_CHARS = Number(process.env['WARDEN_WINDOW_CHARS'] ?? 0);

/**
 * How much each window repeats of the one before it.
 *
 * Enough that a buried instruction split by a cut is still whole in one window.
 * The payloads this is aimed at are one or two sentences.
 */
const WINDOW_OVERLAP = Number(process.env['WARDEN_WINDOW_OVERLAP'] ?? 200);

/** VIOLATES beats UNCLEAR beats COMPLIES — the same direction as the verdict lattice. */
const LABEL_STRICTNESS: Record<Label, number> = { COMPLIES: 0, UNCLEAR: 1, VIOLATES: 2 };

/**
 * The strictest label any window of this message earns.
 *
 * Sequential with an early exit rather than concurrent: VIOLATES is the
 * strictest answer available, so once a window has said it there is nothing a
 * later window could add, and an attack — the case this exists for — usually
 * says it in the window the payload sits in. Benign long text pays for every
 * window, which is the honest shape of the cost.
 */
async function labelOverWindows(
  qvac: QvacAdapter,
  iso: Isolated,
  rule: Rule,
  opts: Resolved
): Promise<{ label: Label; windowCount: number; judged: Isolated }> {
  const slices = windows(iso, opts.windowChars, opts.windowOverlap);
  if (slices.length === 1) {
    return { label: await sampleLabel(qvac, iso, rule, opts), windowCount: 1, judged: iso };
  }

  let worst: Label = 'COMPLIES';
  // The slice the answer came from, so a confirming vote can be asked the same
  // question. Asked over the whole message instead, a confirmation is answering
  // about text the first sample never saw: the payload this pass exists to find
  // is a sentence buried in nine hundred characters, and re-diluting it is
  // exactly how the window's VIOLATES gets voted back down to UNCLEAR — which
  // the aggregator does not escalate on its own. Windowing and voting together
  // were quietly worse than either alone.
  let judged: Isolated = slices[0] ?? iso;
  let seen = 0;
  for (const slice of slices) {
    seen++;
    const label = await sampleLabel(qvac, slice, rule, opts);
    if (LABEL_STRICTNESS[label] > LABEL_STRICTNESS[worst]) {
      worst = label;
      judged = slice;
    }
    if (worst === 'VIOLATES') break;
  }
  return { label: worst, windowCount: seen, judged };
}

/** One labelled sample. */
async function sampleLabel(
  qvac: QvacAdapter,
  iso: Isolated,
  rule: Rule,
  opts: Resolved,
  sampling?: { temp: number; seed: number }
): Promise<Label> {
  const schema = schemaFor(opts.form);
  const res = await qvac.completeJSON(
    {
      role: 'adjudicator',
      system: systemPrompt(rule, iso.nonce, opts),
      user: `${iso.envelope}\n\nLabel the message against the rule.`,
      ...(sampling ? { temp: sampling.temp, seed: sampling.seed } : {}),
      // The answer is one enum value. Anything longer means the model has left
      // the schema, and cutting it off beats waiting for it to wander back.
      maxTokens: 24,
      /**
       * No KV cache key here, deliberately.
       *
       * An earlier version passed `kvKey: adjudicate:<ruleId>`, reasoning that
       * the system block is identical for every call about that rule so only
       * the message would need prefilling. That is not what the cache stores:
       * it keys conversation state including the user turn, so reusing the key
       * across different messages replays the previous verdict. Measured
       * directly — three probes through one rule returned VIOLATES, VIOLATES,
       * VIOLATES, including for a message listed in that rule's own compliant
       * examples; the same rule and prompt without the key returned COMPLIES.
       *
       * It was the root cause of a 100% false-positive rate, and the failure
       * mode is silent: every answer is well-formed, plausible, and wrong.
       * Prompt-processing time is worth paying to avoid that.
       */
      timeoutMs: 25_000
    },
    schema.zod,
    schema.json
  );
  // A form only changes the word the model says for "no". Everything after this
  // line works in the three labels the aggregator and the audit log know.
  return res.value.verdict === BENIGN_LABEL.choice ? 'COMPLIES' : (res.value.verdict as Label);
}

/**
 * Judge one message against one rule.
 *
 * The first sample is greedy and decides on its own when it says COMPLIES or
 * UNCLEAR, so ordinary traffic still costs exactly one call. A VIOLATES is the
 * expensive answer — it stops someone working — so it is the one that has to
 * be paid for, and it triggers `CONFIRM_VOTES` more samples with a majority
 * deciding.
 *
 * Off by default: measured at 16/32 false positives against 14/32 without, for
 * 50 extra model calls. See the note on CONFIRM_VOTES for why the arithmetic
 * that predicted otherwise was wrong.
 *
 * A dissenting minority is recorded as UNCLEAR rather than COMPLIES. The model
 * genuinely disagreed with itself, and UNCLEAR says so; it does not block on
 * its own, but the aggregator escalates it when something structural is also
 * wrong.
 *
 * Failure of a confirming sample leaves the original VIOLATES standing. That
 * keeps the direction of failure the same as everywhere else: a call we could
 * not make is never evidence that something is fine.
 */
export async function adjudicate(
  qvac: QvacAdapter,
  iso: Isolated,
  rule: Rule,
  options?: AdjudicateOptions
): Promise<{ verdict: RuleVerdict; trace: PassTrace }> {
  const started = Date.now();
  const opts = resolve(options);

  const { label: first, windowCount, judged } = await labelOverWindows(qvac, iso, rule, opts);

  let label = first;
  let votes: Label[] = [first];

  if (first === 'VIOLATES' && opts.confirmVotes > 0) {
    const extra = await Promise.all(
      Array.from({ length: opts.confirmVotes }, (_, i) =>
        sampleLabel(qvac, judged, rule, opts, { temp: opts.confirmTemp, seed: 1000 + i }).catch(
          // A confirmation we could not obtain does not get to acquit.
          (): Label => 'VIOLATES'
        )
      )
    );
    votes = [first, ...extra];
    const forViolation = votes.filter((v) => v === 'VIOLATES').length;
    label = forViolation * 2 > votes.length ? 'VIOLATES' : 'UNCLEAR';
  }

  const verdict: RuleVerdict = {
    ruleId: rule.id,
    violates: label === 'VIOLATES',
    unclear: label === 'UNCLEAR',
    confidence: CONFIDENCE[label],
    reason: explain(rule, label)
  };

  return {
    verdict,
    trace: {
      pass: `adjudicate:${rule.id}`,
      ms: Date.now() - started,
      verdict: label === 'VIOLATES'
        ? rule.severity === 'block' ? 'BLOCK' : 'ESCALATE'
        : 'ALLOW',
      detail: {
        label,
        ...(votes.length > 1 ? { votes } : {}),
        ...(windowCount > 1 ? { windows: windowCount } : {}),
        ruleText: rule.text
      }
    }
  };
}

/**
 * Judge a message against several rules at once.
 *
 * Concurrency is what makes multi-rule policy viable: the adjudicator model is
 * loaded with `parallel: 4`, so four of these share one model instance instead
 * of queueing. Sequentially, eight rules at ~2s each would put every prompt
 * behind a sixteen-second wait.
 *
 * A rule whose adjudication fails yields a trace but **no verdict**. That
 * asymmetry is deliberate: the aggregator compares the verdicts it received
 * against the rules it expected, and escalates on the difference. Returning a
 * placeholder verdict instead would make a crashed pass indistinguishable from
 * a clean one — a fail-open hole in the middle of a fail-closed design.
 */
export async function adjudicateAll(
  qvac: QvacAdapter,
  iso: Isolated,
  rules: Rule[],
  options?: AdjudicateOptions
): Promise<{ verdicts: RuleVerdict[]; traces: PassTrace[] }> {
  const settled = await Promise.all(
    rules.map(async (rule) => {
      const started = Date.now();
      try {
        return await adjudicate(qvac, iso, rule, options);
      } catch (err) {
        return {
          verdict: null,
          trace: {
            pass: `adjudicate:${rule.id}`,
            ms: Date.now() - started,
            verdict: 'ESCALATE' as const,
            failedClosed: true,
            detail: { error: err instanceof Error ? err.message : String(err) }
          } satisfies PassTrace
        };
      }
    })
  );

  return {
    verdicts: settled.map((s) => s.verdict).filter((v): v is RuleVerdict => v !== null),
    traces: settled.map((s) => s.trace)
  };
}
