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
 * the default did not simply move. It was taken on four CPU cores; the note in
 * `docs/MEASUREMENTS.md` says a machine with a GPU should measure it again,
 * and nobody has.
 */
export type AdjudicatorChoice = {
  id: 'default' | 'large';
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
};

export const ADJUDICATOR_CHOICES: AdjudicatorChoice[] = [
  {
    id: 'default',
    label: 'Qwen3 1.7B',
    filename: 'Qwen3-1.7B-Q4_0.gguf',
    approxMB: 1100,
    attacksCaught: '89%',
    falsePositives: '63%',
    perDecision: 'A few seconds a decision.',
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
    perDecision: '46 s a decision on four CPU cores.',
    trade: 'Easier to live with. It waves through more, including some it should not.',
    // The console printed this note's substance in a banner the moment somebody
    // picked this seat. Removed on the owner's instruction. It stays written
    // down here because it is still true, and because whoever wires the next
    // surface to these choices should read it before deciding what to show.
    note: 'Usable for people, weaker as a guard. At 46 s it fits inside the 90 s hook deadline, but not by much: raise WARDEN_HOOK_TIMEOUT_MS on the gateway if decisions here run slower, since a hook that gives up fails open.'
  }
];

/** The filename a chosen seat resolves to, for `sourceFor` and the console. */
export function adjudicatorFilename(choice: 'default' | 'large'): string {
  const found = ADJUDICATOR_CHOICES.find((c) => c.id === choice);
  // Unreachable through the schema, which is an enum of exactly these two.
  if (!found) throw new Error(`no adjudicator choice "${choice}"`);
  return found.filename;
}
