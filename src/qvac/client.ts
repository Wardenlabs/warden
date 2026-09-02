/**
 * Model lifecycle. One loaded instance per role, shared across the process.
 *
 * Loading a GGUF costs seconds and hundreds of megabytes of resident memory, so
 * roles are loaded lazily on first use and kept until shutdown. A single guard
 * evaluation touches three roles; reloading per call would make the pipeline
 * unusable.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { loadModel, unloadModel, close } from '@qvac/sdk';
import { withDeadline } from './deadline.js';
import { MODEL_SPECS, modelsDir } from './models.js';
import { remoteCompilerConfig } from './remote.js';
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
  // Absolute, always. The SDK rejects a relative `modelSrc` outright — "must be
  // an absolute path" — and the documented way to use this override is
  // relative: `WARDEN_MODEL_ADJUDICATOR=models/Qwen3-8B-Q4_K_M.gguf`, in the
  // README and in `models.ts` both. So the one path this project offers for
  // trying a larger model had never worked, and it failed in the worst
  // available way: `existsSync` passes, the override is accepted, and every
  // generation throws at load time. A bench run against it recorded 56 cells of
  // ERROR and, before today's fix to how those are counted, reported the broken
  // model as significantly better than the working one.
  return resolve(path);
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

  // The compiler has no weights of its own. It ran on the adjudicator's model
  // before it was a separate role and it still does when nothing else is
  // configured, so splitting the role changed no defaults — it only made the
  // seat something a deployment can fill separately, locally with
  // `WARDEN_MODEL_COMPILER` or off-machine with `WARDEN_COMPILER_API`.
  const specRole: ModelRole = role === 'compiler' ? 'adjudicator' : role;

  const spec = MODEL_SPECS.find((m) => m.role === specRole);
  if (!spec) throw new Error(`no model registered for role "${role}"`);

  // Resolved for the same reason as the override above: this is the path taken
  // on any machine that has the weights but no `warden.local.json`.
  const conventional = resolve(modelsDir(), spec.filename);
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
    // Compilation is one call with an administrator waiting on it, so there is
    // nothing to batch. A wider context because a rule draft carries the role
    // list and the roster on the way in and six fields on the way out.
    case 'compiler':
      return { ctx_size: 8192, parallel: 1 };
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
const unloadable = new Map<ModelRole, { until: number; why: string }>();
const LOAD_RETRY_AFTER_MS = 5 * 60_000;

/**
 * What to say when a model will not load, in the order the reader needs it.
 *
 * The SDK's own message is the useful part and it goes first. What it cannot
 * know is whether the weights are even on this disk: when `sourceFor` falls
 * through to the registry constant there is no local file at all, the load is
 * a P2P fetch, and "RPC initialization timed out" is then a description of a
 * download that was never going to arrive rather than of a broken runtime.
 * Those two need different actions, so the sentence says which one it is.
 */
function loadFailure(role: ModelRole, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  let onDisk = false;
  try {
    onDisk = typeof sourceFor(role) === 'string';
  } catch {
    /* unresolvable counts as not present */
  }
  return onDisk
    ? `${detail} (the ${role} weights are on this disk, so this is the runtime, not a download)`
    : `${detail} (the ${role} weights are NOT on this disk: download them from Rules, or run pnpm run setup)`;
}

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
    if (Date.now() < cooling.until) {
      // The original failure, not a sentence about the cooldown. Every request
      // for the next five minutes used to come back "the adjudicator model
      // failed to load and is not being retried yet", which says a retry is
      // being withheld and says nothing about why the first attempt died. So
      // the one screen built to explain an unevaluated rule explained the
      // rate limiter instead, and the reason, which had been thrown once and
      // dropped, was gone before anybody could read it.
      return Promise.reject(new Error(cooling.why));
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
    unloadable.set(role, { until: Date.now() + LOAD_RETRY_AFTER_MS, why: loadFailure(role, err) });
    throw new Error(loadFailure(role, err));
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
  // Compilation may not be running on anything in `models/`. When it is remote
  // the local weights are not who answers, and reporting them would file a
  // draft under a model that never saw it — the same failure `sourceFor` is
  // careful about, one layer up.
  if (role === 'compiler') {
    const remote = remoteCompilerConfig();
    if (remote) return remote.model;
  }
  try {
    const src = sourceFor(role);
    if (typeof src === 'string') return src.split('/').pop() ?? src;
    const entry = src as { name?: string; src?: string };
    return entry.name ?? entry.src ?? 'registry';
  } catch (err) {
    return `unresolved (${err instanceof Error ? err.message : String(err)})`;
  }
}

/**
 * Can the runtime the SDK spawns actually run on this machine?
 *
 * Two wrong guesses at "RPC initialization timed out after 30000ms, the worker
 * process may have failed to start" cost two releases, and the thing that made
 * both of them guesses is that the error carries no `Worker stderr:` section. A
 * process that starts and dies leaves stderr behind. An empty tail means it
 * never started, and nothing downstream can tell the difference between a
 * binary that is missing, one the OS refused to execute, and one that is fine
 * while something else is broken.
 *
 * So ask it directly: run `bare --version` and keep whatever comes back. It is
 * the same binary `@qvac/sdk` spawns through `bare-runtime/spawn`, so a failure
 * here is the failure there, named, in under a second, on the machine that has
 * the problem rather than on mine.
 */
export async function probeRuntime(): Promise<{ path: string | null; ok: boolean; detail: string }> {
  // Resolved through the package entry and then walked to `bin/`, because the
  // package's `exports` map does not publish `./bin/bare` and asking for it
  // directly fails with "subpath is not defined by exports" — which looks like
  // a missing binary and is not one.
  let binary: string;
  try {
    const entry = createRequire(import.meta.url).resolve('bare-runtime');
    const pkgRoot = entry.slice(0, entry.lastIndexOf('bare-runtime') + 'bare-runtime'.length);
    binary = resolve(pkgRoot, 'bin', process.platform === 'win32' ? 'bare.exe' : 'bare');
  } catch (err) {
    return {
      path: null,
      ok: false,
      detail: `bare-runtime is not resolvable from the gateway: ${
        err instanceof Error ? err.message : String(err)
      }`
    };
  }

  if (!existsSync(binary)) {
    return { path: binary, ok: false, detail: 'the file is not there' };
  }

  return new Promise((resolve) => {
    execFile(binary, ['--version'], { timeout: 10_000 }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ path: binary, ok: true, detail: String(stdout || stderr).trim() || 'ran' });
        return;
      }
      // The code is the useful part. EACCES is a permission bit, ENOENT after
      // an existsSync is a missing interpreter or library, and a kill signal on
      // macOS is Gatekeeper refusing an executable it will not vouch for.
      const code = (err as NodeJS.ErrnoException).code ?? '';
      const signal = (err as { signal?: string }).signal ?? '';
      resolve({
        path: binary,
        ok: false,
        detail: [code, signal, String(stderr || err.message).trim()].filter(Boolean).join(' · ').slice(0, 300)
      });
    });
  });
}

/**
 * Which weights are on this disk, per role, and which are not.
 *
 * `resolvedModel` answers "what would load", which is not the same question and
 * is the only one the console could ask. So a person with no models installed
 * saw the adjudicator named after a file that is not there, decided it was
 * fine, and then could not work out why every rule came back unevaluated. The
 * name of a thing is not evidence that the thing exists.
 *
 * `onDisk` is false when `sourceFor` fell through to the SDK registry constant,
 * which resolves over P2P and, on a normal corporate network, hangs until the
 * load deadline instead of arriving. Reporting that as "installed" would be the
 * console telling somebody their download finished when it never started.
 */
export function modelInventory(): {
  role: ModelRole;
  name: string;
  onDisk: boolean;
  bytes: number | null;
}[] {
  const roles: ModelRole[] = ['adjudicator', 'embedder', 'detector', 'ocr', 'assistant'];
  return roles.map((role) => {
    try {
      const src = sourceFor(role);
      if (typeof src !== 'string') {
        const entry = src as { name?: string; src?: string };
        return { role, name: entry.name ?? entry.src ?? 'registry', onDisk: false, bytes: null };
      }
      let bytes: number | null = null;
      try {
        bytes = statSync(src).size;
      } catch {
        /* present per existsSync but unreadable; size is a nicety */
      }
      return { role, name: src.split('/').pop() ?? src, onDisk: true, bytes };
    } catch (err) {
      return {
        role,
        name: `unresolved (${err instanceof Error ? err.message : String(err)})`,
        onDisk: false,
        bytes: null
      };
    }
  });
}

/**
 * The marker that switches a model's chain-of-thought off, when it has one.
 *
 * `/no_think` is Qwen3's control token. Four prompt builders in this repo ended
 * every system block with it — the adjudicator, the injection pass, the rewriter
 * and the policy compiler — which is correct for the models `setup` downloads
 * and is a defect for every other one: on a Llama or a Mistral it is not a
 * control token, it is the literal string "/no_think" appended to the
 * instructions, and an instruction-following model has to decide what to do
 * with it. A guard whose prompts carry another vendor's private syntax is tuned
 * to a model rather than written for the job.
 *
 * So it is emitted only where it means something. Recognition is by the
 * resolved weights rather than by the role, because the role is a job and the
 * file behind it is whatever the deployment pointed at:
 * `WARDEN_MODEL_ADJUDICATOR` can put a Llama in the adjudicator's seat.
 *
 * `WARDEN_THINKING_MARKER` overrides it — a string to emit for every model, or
 * `off` to emit nothing. That is the escape hatch for a model whose marker this
 * function has never heard of, and it is why the list below not being
 * exhaustive is survivable.
 *
 * The generation parameter beside it, `reasoning_budget: 0`, is the SDK's own
 * and not a vendor's, so it stays unconditional.
 */
const THINKING_MARKERS: [RegExp, string][] = [[/qwen\s*3/i, '/no_think']];

export function thinkingMarker(role: ModelRole): string {
  const override = process.env['WARDEN_THINKING_MARKER'];
  if (override !== undefined) return override === 'off' ? '' : override;

  const model = resolvedModel(role);
  return THINKING_MARKERS.find(([pattern]) => pattern.test(model))?.[1] ?? '';
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
