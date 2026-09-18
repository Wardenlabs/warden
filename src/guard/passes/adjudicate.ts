import { isNativeGuard, nativeHistory, parseGuardAnswer } from '../../qvac/native-guards.js';
import { withModelRole } from '../../qvac/coordination.js';
import { promptMetadata, withPromptSnapshot } from '../../prompts/store.js';
/**
 * Pass 3 — does this message violate one specific rule?
 *
 * One narrow call per rule, never one broad call about all of them. Asked
 * "does this violate any of these eight rules", a small base model produces
 * a confident answer about none of them in particular; asked about one rule
 * with that rule's own examples in front of it, it answers something usable.
 * The one exception is the optional screen at the bottom of this file, for
 * weights that were trained on multi-rule policies, and it is off until
 * measured.
 *
 * The model returns a label and nothing else; the words it is asked to say
 * are in `forms.ts`, the examples it is shown are chosen in `shots.ts`, and
 * this file is what happens around one call: windows, the confirmation
 * vote, the deadline, and the fail-closed path.
 */
import type { QvacAdapter } from '../../qvac/types.js';
import { thinkingMarker } from '../../qvac/client.js';
import type { Rule } from '../../policy/types.js';
import { windows, type Isolated } from '../isolate.js';
import type { PassTrace } from '../types.js';
import {
  LABEL_STRICTNESS,
  nativePrompts,
  dynaguardPolicyUser,
  dynaguardUser,
  formFromEnv,
  isDynaguard,
  parseNative,
  schemaFor,
  systemPrompt,
  analyzerUser,
  dynaguardSystem,
  toLabel,
  type Form,
  type FormOptions,
  type Label
} from './forms.js';
import { pickShots, type ShotSelection } from './shots.js';

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

const SHOTS_PER_SIDE = 2;

/**
 * How many extra samples to draw before letting a VIOLATES stand.
 *
 * **Default zero, because it was measured and it does not work.** Set it to 2
 * to get a majority of three; the mechanism is kept and tested, and the reason
 * it fails is worth more than the mechanism.
 *
 * The argument for it was arithmetic: each prompt is judged against about
 * four rules and any single VIOLATES stops it, so a ~13% per-rule
 * false-positive rate compounds to the 44% observed, and majority voting takes
 * an independent 13% error down to about 5%. Measured over 32 evaluations:
 * 16/32 false positives with the vote against 14/32 without, at 178 model
 * calls instead of 128. The word doing the damage in that argument is
 * *independent*. `r-instruction-override` does not misfire at random — it
 * returns VIOLATES because something in the prompt pushes it there, and
 * sampling that three times at temperature 0.4 returns the same wrong answer
 * three times. What this model has is a lean, not noise.
 */
const CONFIRM_VOTES = Number(process.env['WARDEN_CONFIRM_VOTES'] ?? 0);

/**
 * Temperature for the confirming samples. The first sample is greedy and
 * deterministic, so a vote over greedy samples is one vote counted three
 * times; the confirmations have to sample to carry any information. Low,
 * because the goal is to find where the model is genuinely torn.
 */
const CONFIRM_TEMP = Number(process.env['WARDEN_CONFIRM_TEMP'] ?? 0.4);

/**
 * Cut a message longer than this into windows and judge each one.
 *
 * **Defaults to 0, which is off, and the reason is the corpus rather than the
 * idea.** Every benign prompt in `benign-controls` is under 100 characters and
 * every prompt over 400 is a `volume-distraction` attack, so a corpus run of
 * this switch can only find upside. The cost is on traffic the corpus does
 * not contain: a person pasting a long document to summarise pays for every
 * window, and the strictest wins. What it is aimed at: `volume-distraction`
 * is stopped 25% of the time, and its payload is a sentence buried in 630-917
 * characters of business text. Anyone turning this on should first put a few
 * long, legitimate documents in front of it.
 */
const WINDOW_CHARS = Number(process.env['WARDEN_WINDOW_CHARS'] ?? 0);

/** How much each window repeats of the one before it, so a payload split by a cut is whole in one. */
const WINDOW_OVERLAP = Number(process.env['WARDEN_WINDOW_OVERLAP'] ?? 200);

/**
 * How long one adjudication may take.
 *
 * Right for the models that ship on a GPU, and a knob because it was once
 * hardcoded at 25 s and read as accuracy: the 8B won the bench outright and
 * then scored 1 of 55 through the pipeline, because four concurrent 8B
 * generations on four CPU cores do not finish in 30 s and every timeout
 * became an ESCALATE. It stays bounded rather than optional: a guard with no
 * deadline does not fail late, it fails open, because the hook lets the
 * prompt through when it gives up. Raise it for measurement, where no hook
 * is in front of it:
 *
 *   WARDEN_ADJUDICATE_TIMEOUT_MS=180000 WARDEN_GENERATION_TIMEOUT_MS=200000 pnpm run eval
 */
const ADJUDICATE_TIMEOUT_MS = Number(process.env['WARDEN_ADJUDICATE_TIMEOUT_MS'] ?? 25_000);

/**
 * One screening call over the whole selected policy before any per-rule call.
 *
 * Off, and the reason is the invariant's cousin: a screen that says PASS
 * answers COMPLIES for every rule at once, which is the same thing four
 * per-rule COMPLIES say today, but from one question instead of four. For a
 * base model the repo measured that one broad question is answered worse
 * than four narrow ones. For DynaGuard, trained on policies with a median of
 * three rules, the hypothesis is the opposite, and the prize is real: the
 * honest path costs one call instead of four, and every applicable rule is
 * in the policy block rather than only the top three by retrieval. A FAIL
 * costs what it costs today — the per-rule calls follow, for attribution —
 * so an attack pays the full price and an honest request pays a quarter of
 * it. Only meaningful with DynaGuard weights; the base forms ignore it.
 *
 *   WARDEN_POLICY_SCREEN=1 pnpm run eval -- --attacks --reps 3
 */
const POLICY_SCREEN = process.env['WARDEN_POLICY_SCREEN'] === '1';

/**
 * The knobs this pass has, in one place, so an experiment can set them without
 * editing it. Every one defaults to the environment variable it already read,
 * so production behaviour is unchanged; what this adds is the ability to hold
 * two settings side by side over the same inputs in the same process, which
 * is what `scripts/bench-adjudicator.ts` needs and the measurement log never
 * had.
 */
export type AdjudicateOptions = Partial<FormOptions> & {
  shotSelection?: ShotSelection;
  shotsPerSide?: number;
  windowChars?: number;
  windowOverlap?: number;
  confirmVotes?: number;
  confirmTemp?: number;
  screen?: boolean;
};

/** What the screen said about the whole policy, when it ran. */
export type Screen = { label: Label; rules: number };

type Resolved = Required<AdjudicateOptions>;

function resolve(options: AdjudicateOptions | undefined): Resolved {
  return {
    form: options?.form ?? formFromEnv(),
    dynaguardPolicy: options?.dynaguardPolicy ?? (process.env['WARDEN_DYNAGUARD_POLICY'] === 'v2' ? 'v2' : 'v1'),
    dynaguardFence: options?.dynaguardFence ?? process.env['WARDEN_DYNAGUARD_FENCE'] !== '0',
    shotSelection: options?.shotSelection ?? (process.env['WARDEN_SHOT_SELECTION'] === 'nearest' ? 'nearest' : 'first'),
    shotsPerSide: options?.shotsPerSide ?? SHOTS_PER_SIDE,
    windowChars: options?.windowChars ?? WINDOW_CHARS,
    windowOverlap: options?.windowOverlap ?? WINDOW_OVERLAP,
    confirmVotes: options?.confirmVotes ?? CONFIRM_VOTES,
    confirmTemp: options?.confirmTemp ?? CONFIRM_TEMP,
    screen: options?.screen ?? POLICY_SCREEN
  };
}

/** A readable explanation, composed rather than generated. */
function explain(label: Label): string {
  return {
    VIOLATES: 'the request does what this rule prohibits',
    UNCLEAR: 'could not clearly tell whether this rule applies',
    COMPLIES: 'no conflict with this rule'
  }[label];
}

/**
 * One model call under one form, returning a label.
 *
 * No KV cache key, deliberately. An earlier version passed
 * `kvKey: adjudicate:<ruleId>`, reasoning that the system block is identical
 * for every call about that rule. That is not what the cache stores: it keys
 * conversation state including the user turn, so reusing the key across
 * messages replayed the previous verdict — three probes through one rule
 * returned VIOLATES, VIOLATES, VIOLATES, including for a message in that
 * rule's own compliant examples. It was the root cause of a 100%
 * false-positive rate and every answer was well-formed. Prefill is worth
 * paying to avoid that.
 */
async function ask(
  qvac: QvacAdapter,
  form: Form,
  system: string,
  user: string,
  sampling?: { temp: number; seed: number }
): Promise<Label> {
  const req = {
    role: 'adjudicator' as const,
    system,
    user,
    ...(sampling ? { temp: sampling.temp, seed: sampling.seed } : {}),
    // The answer is one label. Anything longer means the model has left the
    // form, and cutting it off beats waiting for it to wander back.
    maxTokens: 24,
    timeoutMs: ADJUDICATE_TIMEOUT_MS
  };
  if (isNativeGuard(form)) return parseGuardAnswer(form, (await qvac.complete({ ...req, maxTokens: 64, history: nativeHistory(form, system, user) })).text);
  if (form === 'dynaguard-native') return parseNative((await qvac.complete(req)).text);
  const schema = schemaFor(form);
  return toLabel((await qvac.completeJSON(req, schema.zod, schema.json)).value.verdict);
}

/** The question about one rule, in the resolved form. */
async function sampleLabel(
  qvac: QvacAdapter,
  iso: Isolated,
  rule: Rule,
  opts: Resolved,
  sampling?: { temp: number; seed: number }
): Promise<Label> {
  const shots = await pickShots(qvac, rule, iso, opts.shotSelection, opts.shotsPerSide);
  const form = opts.form;
  if (isNativeGuard(form)) {
    const prompts = nativePrompts(form, rule, iso, shots);
    return ask(qvac, form, prompts.system, prompts.user, sampling);
  }
  if (form === 'dynaguard' || form === 'dynaguard-native') {
    // The whole thing is the user turn: the model card's template has no
    // separate system role, so the system slot carries only the thinking
    // marker, and only when the resolved weights are a Qwen3 that reads it.
    return ask(qvac, form, dynaguardSystem(form), dynaguardUser(rule, iso, shots, opts), sampling);
  }
  const system = systemPrompt(rule, iso.nonce, form, shots);
  return ask(qvac, form, system, analyzerUser(form, iso.envelope), sampling);
}

/**
 * The strictest label any window of this message earns.
 *
 * Sequential with an early exit: VIOLATES is the strictest answer available,
 * so once a window has said it there is nothing a later window could add.
 * The slice the answer came from is kept so a confirming vote can be asked
 * the same question: asked over the whole message instead, a confirmation
 * re-dilutes the payload the window found, and windowing and voting together
 * were quietly worse than either alone.
 */
async function labelOverWindows(
  qvac: QvacAdapter,
  iso: Isolated,
  rule: Rule,
  opts: Resolved
): Promise<{ label: Label; windowCount: number; judged: Isolated }> {
  const slices = windows(iso, opts.windowChars, opts.windowOverlap);
  let worst: Label = 'COMPLIES';
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

/**
 * Judge one message against one rule.
 *
 * The first sample is greedy and decides on its own when it says COMPLIES or
 * UNCLEAR, so ordinary traffic costs exactly one call. A VIOLATES stops
 * someone working, so it is the answer that can be asked to pay for
 * `confirmVotes` more samples with a majority deciding (off by default, see
 * above). A dissenting minority is recorded as UNCLEAR rather than COMPLIES:
 * the model disagreed with itself, and the aggregator escalates UNCLEAR when
 * something structural is also wrong. A confirming sample that fails leaves
 * the VIOLATES standing — a call we could not make is never evidence that
 * something is fine.
 */
export async function adjudicate(
  qvac: QvacAdapter,
  iso: Isolated,
  rule: Rule,
  options?: AdjudicateOptions
): Promise<{ verdict: RuleVerdict; trace: PassTrace }> {
  return withModelRole('adjudicator', () => withPromptSnapshot(async () => {
  const started = Date.now();
  const opts = resolve(options);

  const { label: first, windowCount, judged } = await labelOverWindows(qvac, iso, rule, opts);
  let label = first;
  let votes: Label[] = [first];

  if (first === 'VIOLATES' && opts.confirmVotes > 0) {
    const extra = await Promise.all(
      Array.from({ length: opts.confirmVotes }, (_, i) =>
        sampleLabel(qvac, judged, rule, opts, { temp: opts.confirmTemp, seed: 1000 + i }).catch((): Label => 'VIOLATES')
      )
    );
    votes = [first, ...extra];
    const forViolation = votes.filter((v) => v === 'VIOLATES').length;
    label = forViolation * 2 > votes.length ? 'VIOLATES' : 'UNCLEAR';
  }

  return {
    verdict: {
      ruleId: rule.id,
      violates: label === 'VIOLATES',
      unclear: label === 'UNCLEAR',
      confidence: CONFIDENCE[label],
      reason: explain(label)
    },
    trace: {
      pass: `adjudicate:${rule.id}`,
      ms: Date.now() - started,
      verdict: label === 'VIOLATES' ? (rule.severity === 'block' ? 'BLOCK' : 'ESCALATE') : 'ALLOW',
      detail: {
        label,
        ...promptMetadata(),
        ...(votes.length > 1 ? { votes } : {}),
        ...(windowCount > 1 ? { windows: windowCount } : {}),
        ruleText: rule.text
      }
    }
  };
  }));
}

/**
 * One call over the whole selected policy. PASS means every rule complies
 * and the per-rule calls are skipped; anything else — FAIL, an error, a
 * timeout — means the per-rule calls run exactly as they would have. So the
 * screen can only ever remove calls from the honest path; it never decides
 * a refusal on its own, and a screen that cannot answer costs nothing but
 * its own time.
 */
async function screenPolicy(
  qvac: QvacAdapter,
  iso: Isolated,
  rules: Rule[],
  opts: Resolved
): Promise<{ screen: Screen | null; trace: PassTrace }> {
  const started = Date.now();
  try {
    const label = await ask(qvac, opts.form, dynaguardSystem(opts.form), dynaguardPolicyUser(rules, iso, opts));
    return {
      screen: { label, rules: rules.length },
      trace: { pass: 'screen', ms: Date.now() - started, verdict: 'ALLOW', detail: { label, rules: rules.length, ...promptMetadata() } }
    };
  } catch (err) {
    return {
      screen: null,
      trace: {
        pass: 'screen',
        ms: Date.now() - started,
        verdict: 'ALLOW',
        detail: { error: err instanceof Error ? err.message : String(err), rules: rules.length }
      }
    };
  }
}

/**
 * Judge a message against several rules at once.
 *
 * Rules are submitted together. The adapter determines actual concurrency;
 * document requests use explicit admission because the current QVAC runtime
 * serializes completions despite its native `parallel: 4` setting.
 *
 * With the screen on, `screenOver` is the whole applicable policy and `rules`
 * the retrieved few: the screen reads every rule the actor is bound by in one
 * call, and the per-rule calls that follow a FAIL attribute it among the ones
 * retrieval chose. A FAIL nothing attributes is handed to the aggregator as
 * the screen's own observation, where it can only tighten.
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
  options?: AdjudicateOptions & { screenOver?: Rule[] }
): Promise<{ verdicts: RuleVerdict[]; traces: PassTrace[]; screen: Screen | null }> {
  return withModelRole('adjudicator', () => withPromptSnapshot(async () => {
  const opts = resolve(options);
  const traces: PassTrace[] = [];
  let screen: Screen | null = null;

  const policy = options?.screenOver ?? rules;
  if (opts.screen && isDynaguard(opts.form) && policy.length > 1) {
    const result = await screenPolicy(qvac, iso, policy, opts);
    traces.push(result.trace);
    screen = result.screen;
    if (screen?.label === 'COMPLIES') {
      return {
        verdicts: rules.map((rule) => ({
          ruleId: rule.id, violates: false, unclear: false, confidence: CONFIDENCE.COMPLIES, reason: explain('COMPLIES')
        })),
        traces,
        screen
      };
    }
  }

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
    traces: [...traces, ...settled.map((s) => s.trace)],
    screen
  };
  }));
}
