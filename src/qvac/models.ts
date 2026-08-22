/**
 * Which model plays which role, and how to get it onto a machine.
 *
 * QVAC ships model constants that resolve through its own registry, which
 * fetches over Hyperswarm (P2P/UDP). That works on an open network and hangs
 * indefinitely behind a restrictive one — a corporate proxy, a locked-down
 * container, conference wifi. Since we cannot control which of those the team
 * is on during a hackathon, every model here is also resolvable to a plain
 * HTTPS URL that `npm run setup` can fetch, and `loadModel` accepts the
 * resulting local path just as happily as a registry constant.
 */
import {
  EMBEDDINGGEMMA_300M_Q8_0,
  LLAMA_3_2_1B_INST_Q4_0,
  QWEN3_1_7B_INST_Q4,
  QWEN3_600M_INST_Q4
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
  }
];

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
