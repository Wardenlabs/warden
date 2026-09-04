/**
 * Which model plays which role, and how to get it onto a machine.
 *
 * QVAC ships model constants that resolve through its own registry, which
 * fetches over Hyperswarm (P2P/UDP). That works on an open network and hangs
 * indefinitely behind a restrictive one — a corporate proxy, a locked-down
 * container, conference wifi. Since we cannot control which of those the team
 * is on during a hackathon, every model here is also resolvable to a plain
 * HTTPS URL that `pnpm run setup` can fetch, and `loadModel` accepts the
 * resulting local path just as happily as a registry constant.
 */
import {
  EMBEDDINGGEMMA_300M_Q8_0,
  LLAMA_3_2_1B_INST_Q4_0,
  OCR_LATIN,
  QWEN3_1_7B_INST_Q4,
  QWEN3_600M_INST_Q4,
  QWEN3_8B_INST_Q4_K_M
} from '@qvac/sdk';
import type { ModelRole } from './types.js';

/** A registry entry as the SDK exposes it. Only the fields we rely on. */
type RegistryEntry = { name: string; src: string; registryPath?: string };

export type ModelSpec = {
  role: ModelRole;
  /** The SDK constant — preferred when P2P works. */
  entry: RegistryEntry;
  /** Filename on disk once downloaded. */
  filename: string;
  /** Approximate download size, for the setup progress display. */
  approxMB: number;
  /** Whether setup should fetch this by default. */
  required: boolean;
  why: string;
};

export const MODEL_SPECS: ModelSpec[] = [
  {
    role: 'detector',
    entry: QWEN3_600M_INST_Q4 as unknown as RegistryEntry,
    filename: 'Qwen3-0.6B-Q4_0.gguf',
    approxMB: 365,
    required: true,
    why: 'Injection detection — one narrow binary question, so the smallest model is enough and its speed matters more than its judgement.'
  },
  {
    role: 'adjudicator',
    entry: QWEN3_1_7B_INST_Q4 as unknown as RegistryEntry,
    filename: 'Qwen3-1.7B-Q4_0.gguf',
    approxMB: 1100,
    required: true,
    why: 'Per-rule adjudication — the pass that actually needs judgement.'
  },
  {
    role: 'embedder',
    entry: EMBEDDINGGEMMA_300M_Q8_0 as unknown as RegistryEntry,
    filename: 'embeddinggemma-300M-Q8_0.gguf',
    approxMB: 320,
    required: true,
    why: 'Rule retrieval by cosine similarity, keeping the adjudicator context small.'
  },
  {
    role: 'assistant',
    entry: LLAMA_3_2_1B_INST_Q4_0 as unknown as RegistryEntry,
    filename: 'Llama-3.2-1B-Instruct-Q4_0.gguf',
    approxMB: 770,
    required: false,
    why: 'The company assistant sitting behind the gateway — the thing being protected in the demo.'
  },
  {
    role: 'ocr',
    entry: OCR_LATIN as unknown as RegistryEntry,
    filename: 'latin_g2.gguf',
    approxMB: 90,
    required: false,
    why: 'Reads text out of attachments, which is how the document-borne injection reaches the guard at all.'
  }
];

/**
 * A larger adjudicator, for measuring whether size buys accuracy here.
 *
 * Not in MODEL_SPECS and not downloaded by setup: at ~5 GB it is a different
 * proposition from the 1.1 GB default, and nobody should get it by accident.
 * Fetch it deliberately and point the adjudicator at it:
 *
 *   pnpm run setup -- --model adjudicator-large
 *   WARDEN_MODEL_ADJUDICATOR=models/Qwen3-8B-Q4_K_M.gguf pnpm run redteam
 *
 * Qwen3-4B would be the more proportionate step up and the SDK has a constant
 * for it, but its source is `registry://s3/...` rather than HuggingFace, so it
 * cannot be fetched over HTTPS — the same limitation that keeps the OCR model
 * off the setup path. 8B is the next size that can actually be downloaded.
 *
 * Whether it is better here is an open question, not a claim. Nothing in this
 * repo reports a number from it until someone runs the corpus against it.
 */
export const ALTERNATE_MODELS: Record<string, ModelSpec> = {
  'adjudicator-large': {
    role: 'adjudicator',
    entry: QWEN3_8B_INST_Q4_K_M as unknown as RegistryEntry,
    filename: 'Qwen3-8B-Q4_K_M.gguf',
    approxMB: 5030,
    required: false,
    why: 'Optional larger adjudicator, for measuring accuracy against model size on a given machine.'
  },
  /**
   * The same 1.7B, fine-tuned for this job.
   *
   * DynaGuard (tomg-group-umd, Apache 2.0) is Qwen3-1.7B trained on forty
   * thousand user-written policies to answer whether a dialogue complies with
   * one — the adjudicator's question, on the adjudicator's base model. The SDK
   * has no registry constant for it, so the entry is written out by hand in
   * the same `registry://hf/...` shape `toHttpsUrl` reads, pinned to a revision
   * like every other download here. Q8_0 rather than the Q4_0 the default
   * ships as: the brief that brought it in was not to lose model quality, and
   * at this size the difference is a gigabyte on disk, not a second a decision.
   *
   * Measured before it was given a seat — see `ADJUDICATOR_CHOICES` and the
   * 2026-09-04 rows in `docs/MEASUREMENTS.md`. `adjudicate.ts` switches to the
   * PASS/FAIL prompt it was trained on whenever the resolved weights carry this
   * name, so choosing the seat is the whole configuration.
   */
  'adjudicator-dynaguard': {
    role: 'adjudicator',
    entry: {
      name: 'DynaGuard-1.7B.Q8_0',
      src: 'registry://hf/mradermacher/DynaGuard-1.7B-GGUF/resolve/8ac2780c26c909110f97bdc55a06bc96d6bdc5b7/DynaGuard-1.7B.Q8_0.gguf'
    } as unknown as RegistryEntry,
    filename: 'DynaGuard-1.7B.Q8_0.gguf',
    approxMB: 2170,
    required: false,
    why: 'Qwen3-1.7B fine-tuned on user-written policies; the measured alternative to the default seat.'
  },
  /**
   * The 4B of the same family. Q6_K: at 3.6 GB it is the proportionate step
   * between the two seats Warden had, which `Qwen3-4B` could never be because
   * the SDK's constant for it is S3-only. Measured 2026-09-04 before it was
   * offered; see `ADJUDICATOR_CHOICES`.
   */
  'adjudicator-dynaguard-4b': {
    role: 'adjudicator',
    entry: {
      name: 'DynaGuard-4B.Q6_K',
      src: 'registry://hf/mradermacher/DynaGuard-4B-GGUF/resolve/cf94049a948f35ea5b57ad6b3b83cb2e4cc60773/DynaGuard-4B.Q6_K.gguf'
    } as unknown as RegistryEntry,
    filename: 'DynaGuard-4B.Q6_K.gguf',
    approxMB: 3630,
    required: false,
    why: 'DynaGuard at 4B; the middle seat, measured on both columns.'
  }
};

/**
 * Turn a `registry://hf/...` source into a public HuggingFace download URL.
 *
 * Entries use `/blob/` or `/resolve/` interchangeably; only `/resolve/` serves
 * file bytes, so both are normalised to it.
 *
 * @returns the URL, or null if the entry points somewhere we can't fetch over HTTPS.
 */
export function toHttpsUrl(entry: RegistryEntry): string | null {
  const match = /^registry:\/\/hf\/(.+?)\/(blob|resolve)\/(.+)$/.exec(entry.src ?? '');
  if (!match) return null;
  const [, repo, , rest] = match;
  return `https://huggingface.co/${repo}/resolve/${rest}`;
}

/** Where setup puts downloaded models, overridable for shared caches. */
export function modelsDir(): string {
  return process.env['WARDEN_MODELS_DIR'] ?? 'models';
}

/**
 * The two adjudicator seats the console offers, and what the corpus measured
 * about each.
 *
 * These numbers are the whole reason this is a choice rather than a default.
 * On the 185-prompt paired run the 1.7B refuses 63% of legitimate requests and
 * catches 89% of attacks; the 8B fixes the first number to 6% and drops the
 * second to 71%, losing thirteen of sixteen in `hypothetical-testing`,
 * `multi-turn-escalation` and `roleplay-fiction`. Neither passes both columns,
 * which is the honestly-unfinished item at the top of `CLAUDE.md`, and picking
 * between them is a judgement about which failure a given deployment can live
 * with. So the picker shows both numbers rather than a recommendation: an
 * administrator who chooses the 8B without being told it misses more attacks
 * has been misled by the interface.
 *
 * `perDecision` is the one number that is not about accuracy and is the reason
 * the default did not simply move. It was taken on four CPU cores first, and
 * on 2026-09-04 again on an M1 Pro with 16 GB and Metal: 2.5 s a decision for
 * the 1.7B and 11 s for the 8B, whose single call costs 1.6 s there but whose
 * four concurrent calls per decision are memory-bound on 16 GB. Both numbers
 * are in the sentence, because the machine decides which one applies.
 */
export type AdjudicatorChoice = {
  id: 'default' | 'large' | 'dynaguard' | 'dynaguard-4b';
  label: string;
  filename: string;
  approxMB: number;
  /** Share of corpus attacks the guard caught with this model in the seat. */
  attacksCaught: string;
  /** Share of legitimate requests it refused. */
  falsePositives: string;
  perDecision: string;
  /** One line on the seat, in the console. */
  trade: string;
  note: string;
  /**
   * The seat the measurements point at on a machine with a GPU. One seat at
   * most, and only with both columns measured behind it; the card says it and
   * the default does not move on it.
   */
  recommendedOnGpu?: boolean;
};

export const ADJUDICATOR_CHOICES: AdjudicatorChoice[] = [
  {
    id: 'default',
    label: 'Qwen3 1.7B',
    filename: 'Qwen3-1.7B-Q4_0.gguf',
    approxMB: 1100,
    attacksCaught: '89%',
    falsePositives: '63%',
    perDecision: 'About 2.5 s a decision on an Apple GPU; a few more on CPU.',
    trade: 'Strict. It stops more of what it should, and it turns away plenty that was fine.',
    note: 'The measured default. Catches the most attacks and fits inside the hook deadline, and refuses two of every three honest requests.'
  },
  {
    id: 'large',
    label: 'Qwen3 8B',
    filename: 'Qwen3-8B-Q4_K_M.gguf',
    approxMB: 5030,
    attacksCaught: '71%',
    falsePositives: '6%',
    perDecision: 'About 11 s a decision on an Apple GPU with 16 GB; 46 s on four CPU cores.',
    trade: 'Easier to live with. It waves through more, including some it should not.',
    // The console printed this note's substance in a banner the moment somebody
    // picked this seat. Removed on the owner's instruction. It stays written
    // down here because it is still true, and because whoever wires the next
    // surface to these choices should read it before deciding what to show.
    note: 'Usable for people, weaker as a guard. At 46 s it fits inside the 90 s hook deadline, but not by much: raise WARDEN_HOOK_TIMEOUT_MS on the gateway if decisions here run slower, since a hook that gives up fails open.'
  },
  {
    id: 'dynaguard',
    label: 'DynaGuard 1.7B',
    filename: 'DynaGuard-1.7B.Q8_0.gguf',
    approxMB: 2170,
    attacksCaught: '93%',
    falsePositives: '45%',
    perDecision: 'About 2 s a decision on an Apple GPU.',
    trade: 'Same size as the default, trained for this. Stops as many attacks and turns away fewer honest requests — still too many.',
    note: 'Measured 2026-09-04 on an M1 Pro, paired against the shipped 1.7B on the same machine and run: 39 prompts fixed, 11 broken (8 honest requests newly refused, 3 attacks newly missed), false positives 72% to 45%, attacks 95% to 93%. The bench said 96.7% of legitimate cells against 84.8% at p = 0.0000; four rules per decision compound that to 45%. Trained on English policies; half the measured traffic is Spanish. Both records are in docs/MEASUREMENTS.md.'
  },
  {
    id: 'dynaguard-4b',
    label: 'DynaGuard 4B',
    filename: 'DynaGuard-4B.Q6_K.gguf',
    approxMB: 3630,
    attacksCaught: '87%',
    falsePositives: '23%',
    perDecision: 'About 4.5 s a decision on an Apple GPU.',
    trade: 'The middle seat. Refuses a quarter of honest requests and stops most attacks; the 8B refuses fewer and stops fewer.',
    recommendedOnGpu: true,
    note: 'Measured 2026-09-04 on an M1 Pro, paired against DynaGuard 1.7B on the same machine and run: 29 prompts fixed, 10 broken (4 honest requests newly refused, 6 attacks newly missed, in roleplay, hypothetical and multi-turn). False positives 45% to 23%, attacks 93% to 87%. On the bench 99.3% of legitimate cells against 84.8% for the shipped 1.7B, attacks 92.7% against 85.4%. 19 of its 25 remaining refusals are r-instruction-override on developer sentences. Records in docs/MEASUREMENTS.md.'
  }
];

/** The filename a chosen seat resolves to, for `sourceFor` and the console. */
export function adjudicatorFilename(choice: AdjudicatorChoice['id']): string {
  const found = ADJUDICATOR_CHOICES.find((c) => c.id === choice);
  // Unreachable through the schema, which is an enum of exactly these ids.
  if (!found) throw new Error(`no adjudicator choice "${choice}"`);
  return found.filename;
}
