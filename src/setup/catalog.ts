/**
 * The downloadable-model catalog, free of `@qvac/sdk`.
 *
 * `src/qvac/models.ts` is the authority on which model plays which role, but
 * importing it drags the whole SDK in — the registry constants live there.
 * The desktop app's first-run screen runs in the Electron main process, which
 * must not load the SDK, so the HTTPS form of each entry is mirrored here as
 * plain data.
 *
 * `pnpm run setup` cross-checks this table against MODEL_SPECS on every run and
 * warns loudly on drift, so a model change cannot quietly leave the desktop
 * app downloading the wrong weights.
 */
import type { DownloadSpec } from './download.js';

export const MODEL_CATALOG: DownloadSpec[] = [
  {
    role: 'detector',
    filename: 'Qwen3-0.6B-Q4_0.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/50968a4468ef4233ed78cd7c3de230dd1d61a56b/Qwen3-0.6B-Q4_0.gguf',
    approxMB: 365,
    required: true
  },
  {
    role: 'adjudicator',
    filename: 'Qwen3-1.7B-Q4_0.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/d7f544eead698dbd1f15126ef60b45a1e1933222/Qwen3-1.7B-Q4_0.gguf',
    approxMB: 1100,
    required: true
  },
  {
    role: 'embedder',
    filename: 'embeddinggemma-300M-Q8_0.gguf',
    url: 'https://huggingface.co/unsloth/embeddinggemma-300m-GGUF/resolve/6661a6504c30d8304af13455cb4a5d4f5bc6011f/embeddinggemma-300M-Q8_0.gguf',
    approxMB: 320,
    required: true
  },
  {
    role: 'assistant',
    filename: 'Llama-3.2-1B-Instruct-Q4_0.gguf',
    url: 'https://huggingface.co/unsloth/Llama-3.2-1B-Instruct-GGUF/resolve/b69aef112e9f895e6f98d7ae0949f72ff09aa401/Llama-3.2-1B-Instruct-Q4_0.gguf',
    approxMB: 770,
    required: false
  },
  {
    // Not a guard role: a catalog id for the optional larger adjudicator, kept
    // distinct from 'adjudicator' so the drift check in scripts/setup.ts pairs
    // each entry with the right spec instead of matching whichever came first.
    role: 'adjudicator-large',
    filename: 'Qwen3-8B-Q4_K_M.gguf',
    url: 'https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/7c41481f57cb95916b40956ab2f0b139b296d974/Qwen3-8B-Q4_K_M.gguf',
    approxMB: 5030,
    required: false
  },
  {
    role: 'adjudicator-dynaguard',
    filename: 'DynaGuard-1.7B.Q8_0.gguf',
    url: 'https://huggingface.co/mradermacher/DynaGuard-1.7B-GGUF/resolve/8ac2780c26c909110f97bdc55a06bc96d6bdc5b7/DynaGuard-1.7B.Q8_0.gguf',
    approxMB: 2170,
    required: false
  },
  {
    role: 'adjudicator-dynaguard-4b',
    filename: 'DynaGuard-4B.Q6_K.gguf',
    url: 'https://huggingface.co/mradermacher/DynaGuard-4B-GGUF/resolve/cf94049a948f35ea5b57ad6b3b83cb2e4cc60773/DynaGuard-4B.Q6_K.gguf',
    approxMB: 3630,
    required: false
  },
  {
    role: 'ocr',
    filename: 'latin_g2.gguf',
    url: null,
    approxMB: 90,
    required: false
  }
];
