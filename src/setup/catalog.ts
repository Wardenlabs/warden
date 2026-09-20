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
import { loadAdjudicatorSettings, loadCompilerSettings } from '../settings.js';
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
    filename: 'DynaGuard-4B.Q6_K.gguf',
    url: 'https://huggingface.co/mradermacher/DynaGuard-4B-GGUF/resolve/cf94049a948f35ea5b57ad6b3b83cb2e4cc60773/DynaGuard-4B.Q6_K.gguf',
    approxMB: 3630,
    required: true
  },
  {
    role: 'compiler',
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
    role: 'adjudicator-dynaguard-8b',
    filename: 'DynaGuard-8B.Q4_K_M.gguf',
    url: 'https://huggingface.co/mradermacher/DynaGuard-8B-GGUF/resolve/95b1f72477e3f436e80121c5461e303b3459555b/DynaGuard-8B.Q4_K_M.gguf',
    approxMB: 5030,
    required: false
  },
  {
    role: 'adjudicator-qwen3-4b',
    filename: 'Qwen_Qwen3-4B-Q6_K.gguf',
    url: 'https://huggingface.co/bartowski/Qwen_Qwen3-4B-GGUF/resolve/cb76885dc66d50759b207c5a48c4e78dfa00c638/Qwen_Qwen3-4B-Q6_K.gguf',
    approxMB: 3310,
    required: false
  },
  { role: 'adjudicator-shieldstral', filename: 'Shieldstral-1.0-3B-Q6_K.gguf', url: 'https://huggingface.co/noctrex/Shieldstral-1.0-3B-GGUF/resolve/c6baba9c3299630d7d6e3fdd40371683b5cb0e5c/Shieldstral-1.0-3B-Q6_K.gguf', approxMB: 2822, required: false },
  { role: 'adjudicator-granite-guardian', filename: 'granite-guardian-4.1-8b-Q6_K.gguf', url: 'https://huggingface.co/ibm-granite/granite-guardian-4.1-8b-GGUF/resolve/bc78f0995361543a70438fe44a60bb7613fed2f0/granite-guardian-4.1-8b-Q6_K.gguf', approxMB: 6880, required: false },
  {
    role: 'ocr',
    filename: 'latin_g2.gguf',
    url: null,
    approxMB: 90,
    required: false
  }
];

/**
 * The physical files the console's Library may fetch one at a time.
 *
 * A second list rather than a flag on `MODEL_CATALOG` because the two answer
 * different questions: that one is what setup can download, this one is what a
 * browser is allowed to ask a running gateway for. The detector, the embedder
 * and the bench-only Qwen3 4B are in the first and deliberately not here.
 *
 * `id` is the catalogue role, which is the artifact's identity: Qwen3 1.7B is
 * the local compiler and the `base` analyzer seat, and it is one file, one row
 * and one transfer. URLs stay in `MODEL_CATALOG`; nothing here reaches a disk
 * path or a network address without going through it.
 */
export type LibraryBuiltin = {
  id: string;
  name: string;
  roles: Array<'compiler' | 'adjudicator'>;
  adjudicatorChoice: string;
  format: 'compliance' | 'dynaguard' | 'shieldstral' | 'granite-guardian';
};

export const LIBRARY_BUILTINS: LibraryBuiltin[] = [
  { id: 'adjudicator', name: 'DynaGuard 4B', roles: ['adjudicator'], adjudicatorChoice: 'default', format: 'dynaguard' },
  { id: 'adjudicator-dynaguard', name: 'DynaGuard 1.7B', roles: ['adjudicator'], adjudicatorChoice: 'dynaguard', format: 'dynaguard' },
  { id: 'adjudicator-dynaguard-8b', name: 'DynaGuard 8B', roles: ['adjudicator'], adjudicatorChoice: 'dynaguard-8b', format: 'dynaguard' },
  { id: 'compiler', name: 'Qwen3 1.7B', roles: ['compiler', 'adjudicator'], adjudicatorChoice: 'base', format: 'compliance' },
  { id: 'adjudicator-large', name: 'Qwen3 8B', roles: ['adjudicator'], adjudicatorChoice: 'large', format: 'compliance' },
  { id: 'adjudicator-shieldstral', name: 'Shieldstral 1.0 3B', roles: ['adjudicator'], adjudicatorChoice: 'shieldstral', format: 'shieldstral' },
  { id: 'adjudicator-granite-guardian', name: 'Granite Guardian 4.1 8B', roles: ['adjudicator'], adjudicatorChoice: 'granite-guardian', format: 'granite-guardian' }
];

/** A Library id and the pinned download it stands for, or null for anything else. */
export function libraryBuiltin(id: string): { builtin: LibraryBuiltin; spec: DownloadSpec } | null {
  const builtin = LIBRARY_BUILTINS.find((entry) => entry.id === id);
  const spec = builtin && MODEL_CATALOG.find((entry) => entry.role === builtin.id && entry.url);
  return builtin && spec ? { builtin, spec } : null;
}

/** The bundled compiler is optional when drafting uses a CLI, an endpoint, or
 * an imported model. Read the same settings as the gateway, including its
 * conservative local fallback for unreadable prior configuration. */
function needsBundledCompiler(settingsPath: string | undefined, env: NodeJS.ProcessEnv): boolean {
  if (env['WARDEN_COMPILER_CLI']?.trim() || env['WARDEN_COMPILER_API']?.trim() || env['WARDEN_MODEL_COMPILER']?.trim()) return false;
  const saved = loadCompilerSettings(settingsPath);
  if (saved.provider === 'local') return true;
  if (saved.provider === 'catalog' || saved.provider.endsWith('-cli')) return false;
  // Legacy incomplete endpoint settings fall back to local at runtime. Keep
  // that path usable without turning an invalid saved object into a new CLI.
  if (!saved.baseUrl.trim()) return true;
  if (saved.apiKey.trim()) return false;
  try { return !['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(saved.baseUrl).hostname); }
  catch { return true; }
}

/** Settings-aware first-run downloads, shared by the shell and terminal setup.
 * Optional analyzer seats are included only for an explicit download request;
 * the automatic demo-exit check continues to require the base guard weights.
 * The Qwen base analyzer shares the bundled compiler file, so selecting that
 * analyzer still requires it even when compilation uses Claude Code. */
export function setupModelDownloads(
  settingsPath?: string,
  includeExtras = false,
  env: NodeJS.ProcessEnv = process.env
): DownloadSpec[] {
  const analyzer = loadAdjudicatorSettings(settingsPath);
  const chosen = !env['WARDEN_MODEL_ADJUDICATOR']?.trim() && !analyzer.modelId ? analyzer.model : 'default';
  const compiler = needsBundledCompiler(settingsPath, env) || chosen === 'base';
  return MODEL_CATALOG.filter((spec) => spec.url && (
    (spec.required && spec.role !== 'compiler') ||
    (spec.role === 'compiler' && compiler) ||
    (includeExtras && spec.role === `adjudicator-${chosen}`)
  ));
}
