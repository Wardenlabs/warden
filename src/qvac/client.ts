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
import { withDeadline } from './deadline.js';
import { MODEL_SPECS, modelsDir } from './models.js';
import type { ModelRole } from './types.js';

/** Written by `pnpm run setup` — resolved absolute paths per role. */
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
 * An explicit env override wins, then the path `pnpm run setup` recorded, then
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

/**
 * How long a model may take to load before the role is treated as unavailable.
 *
 * Generous against a local file — the 1 GB adjudicator loads in a few seconds —
 * and short enough that a registry fetch which is never going to arrive gives
 * up instead of parking every request behind it.
 */
const LOAD_TIMEOUT_MS = 90_000;

const loaded = new Map<ModelRole, Promise<string>>();

/**
 * Roles whose load timed out, and when to stop holding it against them.
 *
 * Without this, every request that needs an unloadable role pays the full
 * deadline again: the corpus spends 90s per document-borne prompt discovering
 * the same thing about the same model, which is eighteen minutes of a run
 * learning nothing. A model that did not arrive in 90s is not going to arrive
 * in the next 90.
 *
 * It expires rather than being permanent because the cause is usually the
 * network, and a gateway that has been up for a day should not still be
 * refusing a role because the wifi was bad at breakfast.
 */
const unloadable = new Map<ModelRole, number>();
const LOAD_RETRY_AFTER_MS = 5 * 60_000;

/**
 * Resolve a role to a loaded model id, loading it on first use.
 *
 * The promise itself is cached rather than the resolved id, so concurrent
 * callers during startup share one load instead of racing into several.
 */
export function modelFor(role: ModelRole): Promise<string> {
  const cached = loaded.get(role);
  if (cached) return cached;

  const cooling = unloadable.get(role);
  if (cooling !== undefined) {
    if (Date.now() < cooling) {
      return Promise.reject(
        new Error(`the ${role} model failed to load and is not being retried yet`)
      );
    }
    unloadable.delete(role);
  }

  /**
   * Bounded, because this is where the guard actually hangs.
   *
   * A local GGUF loads in seconds. A role whose weights are not on disk falls
   * back to the SDK registry constant, and the registry fetches over Hyperswarm
   * — the path the README warns hangs indefinitely behind a restrictive
   * network. `OCR_LATIN` has no HTTPS mirror, so it takes that path on every
   * machine, and a corpus run stalled there for fifteen minutes with the
   * download frozen partway.
   *
   * Bounding `ocr()` and `embed()` was not enough: those wrap the inference,
   * and the load happens before either of them is called. This is the one place
   * that covers all three.
   */
  const loading = withDeadline(
    loadModel({
      modelSrc: sourceFor(role) as never,
      modelType: modelTypeFor(role) as never,
      modelConfig: configFor(role) as never
    }),
    LOAD_TIMEOUT_MS,
    `loading the ${role} model`
  ).catch((err: unknown) => {
    // Drop the rejected promise so a later call can retry rather than
    // permanently inheriting a transient failure, and start the cooldown so
    // that retry is not immediate.
    loaded.delete(role);
    unloadable.set(role, Date.now() + LOAD_RETRY_AFTER_MS);
    throw err;
  });

  loaded.set(role, loading);
  return loading;
}

/**
 * Which weights a role actually resolves to, as a name a report can print.
 *
 * A measurement that does not say which model answered is not comparable to
 * any other measurement, and the levers that change it — `WARDEN_MODEL_<ROLE>`,
 * `WARDEN_INJECTION_MODEL`, the optional 8B adjudicator — are exactly the ones
 * someone reaches for when tuning. Runs were recording `MODEL_ADJUDICATOR:
 * "(default)"`, which says only that no override was set: two machines with
 * different files on disk both wrote "(default)" and their numbers were filed
 * as the same configuration.
 *
 * Resolution order is `sourceFor`'s, so this is what will be loaded rather than
 * what someone hoped would be. A registry constant has no path, so it is named
 * by its own identity instead.
 */
export function resolvedModel(role: ModelRole): string {
  try {
    const src = sourceFor(role);
    if (typeof src === 'string') return src.split('/').pop() ?? src;
    const entry = src as { name?: string; src?: string };
    return entry.name ?? entry.src ?? 'registry';
  } catch (err) {
    return `unresolved (${err instanceof Error ? err.message : String(err)})`;
  }
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
