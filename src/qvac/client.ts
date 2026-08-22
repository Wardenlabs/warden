/**
 * Model lifecycle. One loaded instance per role, shared across the process.
 *
 * Loading a GGUF costs seconds and hundreds of megabytes of resident memory, so
 * roles are loaded lazily on first use and kept until shutdown. A single guard
 * evaluation touches three roles; reloading per call would make the pipeline
 * unusable.
 */
import { existsSync, readFileSync } from 'node:fs';
import { loadModel, unloadModel, close } from '@qvac/sdk';
import { MODEL_SPECS, modelsDir } from './models.js';
import type { ModelRole } from './types.js';

/** Written by `npm run setup` — resolved absolute paths per role. */
type LocalConfig = { modelsDir: string; adapter: string; models: Record<string, string> };

let localConfig: LocalConfig | null = null;

function config(): LocalConfig | null {
  if (localConfig) return localConfig;
  if (!existsSync('warden.local.json')) return null;
  localConfig = JSON.parse(readFileSync('warden.local.json', 'utf8')) as LocalConfig;
  return localConfig;
}

/**
 * An explicit per-role model override, e.g.
 * `WARDEN_MODEL_ADJUDICATOR=models/Qwen3-8B-Q4_K_M.gguf`.
 *
 * The adjudicator is the one role where model size plausibly buys accuracy, and
 * the honest way to find out is to measure the same corpus against two of them
 * on the same machine. That has to be doable without editing code, because the
 * machine worth measuring on is somebody else's laptop.
 */
function overrideFor(role: ModelRole): string | null {
  const path = process.env[`WARDEN_MODEL_${role.toUpperCase()}`];
  if (!path) return null;
  if (!existsSync(path)) {
    // Silently falling back would mean a benchmark that reports one model's
    // numbers under another model's name, which is worse than not running.
    throw new Error(
      `WARDEN_MODEL_${role.toUpperCase()} points at "${path}", which does not exist`
    );
  }
  return path;
}

/**
 * Where a role's weights live.
 *
 * An explicit env override wins, then the path `npm run setup` recorded, then
 * the conventional filename in the models directory, and finally the SDK
 * registry constant so a machine with working P2P still resolves.
 */
function sourceFor(role: ModelRole): string | object {
  const override = overrideFor(role);
  if (override) return override;

  const fromConfig = config()?.models[role];
  if (fromConfig && existsSync(fromConfig)) return fromConfig;

  const spec = MODEL_SPECS.find((m) => m.role === role);
  if (!spec) throw new Error(`no model registered for role "${role}"`);

  const conventional = `${modelsDir()}/${spec.filename}`;
  if (existsSync(conventional)) return conventional;

  return spec.entry as unknown as object;
}

/**
 * Per-role load settings.
 *
 * `parallel` on the adjudicator is what lets pass 3 judge K rules concurrently
 * against one loaded model — the alternative is K sequential calls, which is
 * the difference between a usable pipeline and a three-second-per-rule one.
 */
function configFor(role: ModelRole): Record<string, unknown> {
  switch (role) {
    case 'detector':
      return { ctx_size: 4096, parallel: 2 };
    case 'adjudicator':
      return { ctx_size: 8192, parallel: 4 };
    case 'assistant':
      return { ctx_size: 8192 };
    case 'embedder':
      return {};
    case 'ocr':
      return {};
  }
}

/**
 * The plugin that handles a role's model.
 *
 * These are the SDK's plugin identifiers, not descriptive names — `embedding`
 * and `ocr` both fail to resolve with "Plugin not found for model type". That
 * failure surfaced as retrieval silently degrading to judging every rule, which
 * doubled the work per prompt and pushed adjudications past their timeout.
 */
function modelTypeFor(role: ModelRole): string {
  if (role === 'embedder') return 'llamacpp-embedding';
  if (role === 'ocr') return 'ggml-ocr';
  return 'llm';
}

const loaded = new Map<ModelRole, Promise<string>>();

/**
 * Resolve a role to a loaded model id, loading it on first use.
 *
 * The promise itself is cached rather than the resolved id, so concurrent
 * callers during startup share one load instead of racing into several.
 */
export function modelFor(role: ModelRole): Promise<string> {
  const cached = loaded.get(role);
  if (cached) return cached;

  const loading = loadModel({
    modelSrc: sourceFor(role) as never,
    modelType: modelTypeFor(role) as never,
    modelConfig: configFor(role) as never
  }).catch((err: unknown) => {
    // Drop the rejected promise so a later call can retry rather than
    // permanently inheriting a transient failure.
    loaded.delete(role);
    throw err;
  });

  loaded.set(role, loading);
  return loading;
}

/** Load roles ahead of first request so the demo doesn't pay for it on camera. */
export async function warmup(roles: ModelRole[]): Promise<void> {
  await Promise.all(roles.map((r) => modelFor(r)));
}

export async function shutdown(): Promise<void> {
  const entries = [...loaded.entries()];
  loaded.clear();
  for (const [, idPromise] of entries) {
    try {
      await unloadModel({ modelId: await idPromise });
    } catch {
      // Already gone, or the worker died — nothing useful to do while exiting.
    }
  }
  try {
    await close();
  } catch {
    /* ignore */
  }
}
