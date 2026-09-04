/**
 * Rule retrieval by similarity.
 *
 * Adjudication costs a model call per rule, so handing every rule to every
 * prompt is the difference between a two-second decision and a twenty-second
 * one. Retrieval narrows the set to the rules plausibly about this message.
 *
 * Pinned rules bypass it entirely — see the note on `Rule.pinned`.
 */
import { adapter } from '../qvac/index.js';
import type { PolicySpec, Rule } from './types.js';

/** Embeddings are computed once per policy version and reused. */
const cache = new Map<string, Map<string, number[]>>();

async function embeddingsFor(spec: PolicySpec): Promise<Map<string, number[]>> {
  const hit = cache.get(spec.version);
  if (hit) return hit;

  const rules = spec.rules;
  const map = new Map<string, number[]>();
  if (rules.length > 0) {
    // Embed the rule text together with its violating examples: the examples
    // carry the vocabulary real requests actually use, which the formal rule
    // sentence usually does not. Not the boundary — it names the legitimate
    // work nearest the rule, and embedding it would pull exactly that work
    // toward the rule it exists to keep out.
    const texts = rules.map((r) => [r.text, ...r.examples.violating].join(' \n '));
    const vectors = await adapter().embed(texts);
    rules.forEach((r, i) => {
      const v = vectors[i];
      if (v) map.set(r.id, v);
    });
  }

  cache.set(spec.version, map);
  return map;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i]!, y = b[i]!;
    dot += x * y; na += x * x; nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * The rules to adjudicate for this prompt: every pinned rule, plus the top-K
 * most similar of the rest.
 *
 * On embedding failure the whole applicable set is returned rather than none.
 * Retrieval is an optimisation, and an optimisation that fails must not
 * quietly reduce what gets checked.
 */
/**
 * Similarity a rule must reach before it is worth asking a model about.
 *
 * Top-K ranks but never filters: the third-best rule is adjudicated whether it
 * scored 0.70 or 0.05. On `pasame el sueldo de Ana`, `r-payroll` scored 0.72 and
 * `r-credentials` — which shares no subject with it — scored 0.46, was ranked
 * into the top three anyway, and returned VIOLATES. That is a false positive the
 * retrieval pass already had the evidence to prevent.
 *
 * Every rule below the floor is one fewer model call and one fewer chance to be
 * wrong, so this buys latency and accuracy from the same change.
 *
 * **Defaults to 0, which is off.** A floor that is too high drops rules that
 * should have been checked, and this project has measured ±6% swings between
 * identical runs — a value picked from one trace would be picked from noise.
 * Set it, run `pnpm run redteam -- --reps 3`, and keep it only if the attack
 * column holds.
 *
 * "Off" is enforced by {@link FLOOR_IS_OFF}, not by the comparison. Cosine runs
 * from -1 to 1, so `score >= 0` is a floor at zero and not the absence of one —
 * which is exactly the bug that sentence used to describe without preventing.
 */
const MIN_RELEVANCE = Number(process.env['WARDEN_MIN_RELEVANCE'] ?? 0);

/**
 * Whether there is a floor at all.
 *
 * `0` means off, and it has to be tested rather than compared against, because
 * cosine similarity is defined on [-1, 1] and `score >= 0` is a floor at zero,
 * not the absence of one. That was the bug: two rules of this function
 * disagreed about what `0` meant. The early return below already read it as
 * off; the filter read it as "drop anything the prompt points away from", and
 * silently dropped those rules from adjudication.
 *
 * It is a quiet failure in the fail-open direction — a rule that should have
 * been judged is never asked about, and the trace shows only the rules that
 * survived, so nothing in the output says one is missing. It bites whenever
 * there are more non-pinned applicable rules than `TOP_K`, which is the
 * benchmark policy's own shape: 6 rules apply to the test actor, 1 is pinned, 5
 * remain and 3 are taken.
 *
 * The comment on {@link MIN_RELEVANCE} says it in as many words — "Top-K ranks
 * but never filters: the third-best rule is adjudicated whether it scored 0.70
 * or 0.05" — and that is now true again.
 */
const FLOOR_IS_OFF = !Number.isFinite(MIN_RELEVANCE) || MIN_RELEVANCE <= 0;

export async function selectRules(
  spec: PolicySpec,
  applicable: Rule[],
  prompt: string,
  k = 3
): Promise<{ rules: Rule[]; scores: Record<string, number>; degraded: boolean }> {
  const pinned = applicable.filter((r) => r.pinned);
  const rest = applicable.filter((r) => !r.pinned);

  // With the floor off there is nothing to gain by scoring a set that is
  // already small enough to check in full.
  if (rest.length <= k && FLOOR_IS_OFF) {
    return { rules: [...pinned, ...rest], scores: {}, degraded: false };
  }

  try {
    const map = await embeddingsFor(spec);
    const [promptVec] = await adapter().embed([prompt]);
    if (!promptVec) throw new Error('no embedding returned for prompt');

    const scores: Record<string, number> = {};
    const ranked = rest
      .map((r) => {
        const v = map.get(r.id);
        // A rule with no embedding scores 0. With the floor on that drops it,
        // which is wrong — an unindexed rule is unknown, not irrelevant — so it
        // is kept and the floor is applied only to rules that were scored.
        const score = v ? cosine(promptVec, v) : null;
        if (score !== null) scores[r.id] = Number(score.toFixed(4));
        return { rule: r, score };
      })
      .filter((x) => FLOOR_IS_OFF || x.score === null || x.score >= MIN_RELEVANCE)
      .sort((a, b) => (b.score ?? 1) - (a.score ?? 1))
      .slice(0, k)
      .map((x) => x.rule);

    return { rules: [...pinned, ...ranked], scores, degraded: false };
  } catch {
    return { rules: applicable, scores: {}, degraded: true };
  }
}

export function invalidateIndex(): void {
  cache.clear();
}
