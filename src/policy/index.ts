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
    // sentence usually does not.
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
export async function selectRules(
  spec: PolicySpec,
  applicable: Rule[],
  prompt: string,
  k = 3
): Promise<{ rules: Rule[]; scores: Record<string, number>; degraded: boolean }> {
  const pinned = applicable.filter((r) => r.pinned);
  const rest = applicable.filter((r) => !r.pinned);

  if (rest.length <= k) {
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
        const score = v ? cosine(promptVec, v) : 0;
        scores[r.id] = Number(score.toFixed(4));
        return { rule: r, score };
      })
      .sort((a, b) => b.score - a.score)
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
