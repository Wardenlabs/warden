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
import { adjudicatorFilename, MODEL_SPECS, modelsDir } from './models.js';
import { remoteCompilerConfig } from './remote.js';
import { loadAdjudicatorSettings, loadCompilerSettings, savedAdjudicatorChoice } from '../settings.js';
import { MODEL_CATALOG } from '../setup/catalog.js';
import { installedModel } from '../setup/model-files.js';
import { findModel, fingerprint, modelPath, type ManagedRole } from '../models/store.js';
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
 * A shipped file in the models directory, if it is usable.
 *
 * `existsSync` was enough while the only thing that wrote here was setup
 * against a stopped gateway. The console now downloads into a live one, and a
 * name on disk is no longer proof of a model: the shared presence check wants a
 * receipt, or for older files a GGUF header and a plausible size. A file that
 * is there and fails it throws rather than returning null, because null means
 * "look elsewhere", and quietly loading a different model than the one on this
 * disk is the confusion `overrideFor` throws to avoid.
 */
function shippedFile(filename: string): string | null {
  const path = resolve(modelsDir(), filename);
  const spec = MODEL_CATALOG.find((m) => m.filename === filename);
  if (!spec) return existsSync(path) ? path : null;
  const state = installedModel(spec, modelsDir());
  if (state.onDisk) return path;
  if (state.downloadBlockedReason) throw new Error(`${filename} in the models directory is incomplete or damaged. Move it out and download it again from Models.`);
  return null;
}

/**
 * Where a role's weights live.
 *
 * An explicit env override wins, then the path `pnpm run setup` recorded, then
 * the conventional filename in the models directory, and finally the SDK
 * registry constant so a machine with working P2P still resolves.
 */
export function sourceFor(role: ModelRole): string | object {
  const override = overrideFor(role);
  if (override) return override;

  const custom = selectedLocalModel(role);
  if (custom) { fingerprint(custom); return modelPath(custom); }

  // The seat an administrator picked in the console, which outranks whatever
  // `pnpm run setup` happened to record. Below the env override on purpose:
  // `WARDEN_MODEL_ADJUDICATOR` exists so a bench can pin a model for one run,
  // and a run pinned from the shell must not be silently redirected by a
  // setting somebody changed in a browser three weeks ago.
  //
  // Missing weights fall through to the default rather than throwing. Choosing
  // the larger seat is what STARTS a 5 GB download, so between the click and
  // the restart there is a window where the choice is recorded and the file is
  // not there yet — and throwing across that window would stop the guard
  // judging because somebody asked for a better model. It keeps judging with
  // what it has. Honesty is handled where it belongs, in the answer: every
  // route that reports the seat reports `inForce` alongside the choice, so the
  // console can say the download has not landed instead of implying it has.
  //
  // An explicit `default` counts as a pick. It used to be skipped here, so
  // pressing Use on DynaGuard 4B tested that file and then loaded whatever
  // analyzer path `warden.local.json` still named. An installation that never
  // chose keeps the setup path, which is why this asks what was saved rather
  // than what the settings fall back to.
  if (role === 'adjudicator') {
    const chosen = savedAdjudicatorChoice();
    const path = chosen && shippedFile(adjudicatorFilename(chosen));
    if (path) return path;
  }

  const fromConfig = config()?.models[role];
  if (fromConfig && existsSync(fromConfig)) return fromConfig;

  // The compiler used to borrow the adjudicator's weights. Since the
  // adjudicator seat became a PASS/FAIL fine-tune it has its own required
  // entry in MODEL_SPECS — the Qwen3-1.7B it always ran on — and is filled
  // separately, locally with `WARDEN_MODEL_COMPILER` or off-machine with
  // `WARDEN_COMPILER_API`.
  const spec = MODEL_SPECS.find((m) => m.role === role);
  if (!spec) throw new Error(`no model registered for role "${role}"`);

  // Resolved for the same reason as the override above: this is the path taken
  // on any machine that has the weights but no `warden.local.json`.
  const conventional = shippedFile(spec.filename);
  if (conventional) return conventional;

  return spec.entry as unknown as object;
}

/**
 * Per-role load settings.
 *
 * `parallel` configures native context slots. The QVAC 0.17.1 request registry
 * still serializes completions per model; document checks explicitly queue
 * admission so their generation deadlines do not expire while waiting.
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
const inForce = new Map<ModelRole, string>();
const inForceFormats = new Map<ModelRole, 'compliance' | 'dynaguard' | 'shieldstral' | 'granite-guardian' | null>();

function selectedLocalModel(role: ModelRole) {
  const settings = role === 'adjudicator' ? loadAdjudicatorSettings() : role === 'compiler' ? loadCompilerSettings() : null;
  if (!settings?.modelId || (role === 'compiler' && loadCompilerSettings().provider !== 'catalog')) return null;
  const entry = findModel(settings.modelId);
  if (entry.kind !== 'local' || !entry.roles.includes(role as ManagedRole)) return null;
  return entry;
}

/** Custom files carry a declared dialect; a renamed file cannot silently change
 * PASS/FAIL into a general instruction model's compliance prompt. */
export function customAdjudicatorForm(): 'compliance' | 'dynaguard' | 'shieldstral' | 'granite-guardian' | null {
  if (inForceFormats.has('adjudicator')) return inForceFormats.get('adjudicator') ?? null;
  if (process.env['WARDEN_MODEL_ADJUDICATOR']) return null;
  return selectedLocalModel('adjudicator')?.format ?? null;
}
export function activeLocalModel(role: ModelRole): string | null { return inForce.get(role) ?? null; }

/** Desired configuration, including a built-in whose download is still pending.
 * This must remain separate from the identity and dialect of cached weights. */
export function configuredModel(role: ModelRole): string {
  try {
    if (role === 'compiler') {
      const remote = remoteCompilerConfig();
      if (remote) return remote.model;
    }
    const override = process.env[`WARDEN_MODEL_${role.toUpperCase()}`];
    if (override) return override.split('/').pop() ?? override;
    const custom = selectedLocalModel(role);
    if (custom) return `${custom.id}.gguf`;
    if (role === 'adjudicator') {
      const chosen = loadAdjudicatorSettings().model;
      if (chosen !== 'default') return adjudicatorFilename(chosen);
    }
    return sourceName(sourceFor(role));
  } catch (err) {
    return `unresolved (${err instanceof Error ? err.message : String(err)})`;
  }
}

function sourceName(source: string | object): string {
  if (typeof source === 'string') return source.split('/').pop() ?? source;
  const entry = source as { name?: string; src?: string };
  return entry.name ?? entry.src ?? 'registry';
}

export async function withTemporaryModel<T>(role: ManagedRole, path: string, work: (id: string) => Promise<T>): Promise<T> {
  const pending = loadModel({ modelSrc: path as never, modelType: 'llm' as never, modelConfig: configFor(role) as never });
  let modelId: string | undefined;
  try {
    modelId = await withDeadline(pending, LOAD_TIMEOUT_MS, 'loading the candidate model');
    return await work(modelId);
  } finally {
    if (modelId) await unloadModel({ modelId }).catch(() => {});
    else void pending.then((late) => unloadModel({ modelId: late })).catch(() => {});
  }
}

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
  if (!onDisk) {
    return `${detail} (the ${role} weights are NOT on this disk: download them from Rules, or run pnpm run setup)`;
  }
  // The probe belongs in this sentence and not on another screen. The panel in
  // Rules has carried it since the last release and the reports kept arriving
  // as screenshots of this line, which is fair: this is the line that appears
  // when the thing goes wrong, and asking somebody to go and read a different
  // one is asking them to do the diagnosis. It is a boot-time result, so
  // reading it here costs nothing.
  const probe = lastRuntimeProbe;
  const runtime = !probe
    ? ''
    : probe.ok
      ? ` The bare runtime at ${probe.path} runs (${probe.detail}), so the binary is fine and the worker is failing after it starts.`
      : ` The bare runtime will not run: ${probe.path ?? 'not found'} — ${probe.detail}`;
  return `${detail} (the ${role} weights are on this disk, so this is the runtime, not a download.${runtime})`;
}

/**
 * The last answer `probeRuntime` gave, so a failure can quote it.
 *
 * Filled at boot and refreshed whenever the console asks. Absent only in the
 * window before the first probe finishes, which is short and which the message
 * simply omits rather than guessing about.
 */
let lastRuntimeProbe: { path: string | null; ok: boolean; detail: string } | null = null;

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
  const source = sourceFor(role);
  const format = role === 'adjudicator' && !process.env['WARDEN_MODEL_ADJUDICATOR'] ? selectedLocalModel(role)?.format ?? null : null;
  const pending = loadModel({
    modelSrc: source as never,
    modelType: modelTypeFor(role) as never,
    modelConfig: configFor(role) as never
  });
  const loading = withDeadline(
    pending,
    LOAD_TIMEOUT_MS,
    `loading the ${role} model`
  ).then((id) => {
    inForce.set(role, typeof source === 'string' ? source.split('/').pop()! : (source as { name?: string }).name ?? 'registry');
    inForceFormats.set(role, format);
    return id;
  }).catch((err: unknown) => {
    // A deadline does not cancel the SDK's load. If it finishes after a failed
    // activation was rolled back, release those abandoned weights as well.
    void pending.then((id) => unloadModel({ modelId: id })).catch(() => {});
    // Drop the rejected promise so a later call can retry rather than
    // permanently inheriting a transient failure, and start the cooldown so
    // that retry is not immediate.
    loaded.delete(role);
    inForce.delete(role);
    inForceFormats.delete(role);
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
 * Loaded weights keep their identity until they are unloaded. Before the first
 * load this follows `sourceFor`, including its available-model fallback.
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
  // A missing built-in selection is only a download request. The old weights
  // keep serving until restart, and their identity determines their dialect.
  // Reporting the desired filename here would prompt those old weights using
  // the new model's instructions before the new bytes had even arrived.
  const active = inForce.get(role);
  if (active) return active;
  try {
    return sourceName(sourceFor(role));
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
  const answer = await runProbe();
  lastRuntimeProbe = answer;
  return answer;
}

async function runProbe(): Promise<{ path: string | null; ok: boolean; detail: string }> {
  // Resolved exactly the way `bare-runtime/lib/spawn.js` resolves it, which is
  // the only resolution worth probing. The first version of this probed
  // `bare-runtime/bin/bare` and was testing the wrong file: that is a
  // 130-byte `#!/usr/bin/env node` shim for people typing `bare` at a prompt,
  // and the SDK never runs it — it imports `bare-runtime/spawn` in-process and
  // execs the platform package's binary directly. Probing the shim reported
  // first EACCES and then "env: node: No such file or directory", both true of
  // the shim and neither the reason inference was failing.
  let binary: string;
  try {
    const require_ = createRequire(import.meta.url);
    const pkg = `bare-runtime-${process.platform}-${process.arch}`;
    const entry = require_.resolve(pkg);
    const root = entry.slice(0, entry.lastIndexOf(pkg) + pkg.length);
    binary = resolve(root, 'bin', process.platform === 'win32' ? 'bare.exe' : 'bare');
  } catch (err) {
    return {
      path: null,
      ok: false,
      detail: `no bare runtime for ${process.platform}-${process.arch}: ${
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
 * A model name alone does not answer this question. A person with no models installed
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
  const roles: ModelRole[] = ['adjudicator', 'compiler', 'embedder', 'detector', 'ocr', 'assistant'];
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

/**
 * Drop a role's loaded model so the next caller resolves it again.
 *
 * Changing the adjudicator from the console has to take effect without a
 * restart, and `loaded` caches the promise for the lifetime of the process —
 * so without this the console would report the new model while the old one
 * kept answering, which is the exact confusion `sourceFor` throws to avoid.
 *
 * The unload is awaited rather than fired and forgotten: the two adjudicators
 * are 1.1 GB and 5 GB of resident memory, and holding both because a switch
 * did not finish is how a machine starts swapping mid-decision.
 */
export async function forgetRole(role: ModelRole): Promise<void> {
  const previous = loaded.get(role);
  loaded.delete(role);
  inForce.delete(role);
  inForceFormats.delete(role);
  unloadable.delete(role);
  if (!previous) return;
  try {
    await unloadModel({ modelId: await previous });
  } catch {
    // It never loaded, or the worker is already gone. Either way the cache is
    // clear, which is what the caller asked for.
  }
}

/** Load roles ahead of first request so the demo doesn't pay for it on camera. */
export async function warmup(roles: ModelRole[]): Promise<void> {
  await Promise.all(roles.map((r) => modelFor(r)));
}

export async function shutdown(): Promise<void> {
  const entries = [...loaded.entries()];
  loaded.clear();
  inForce.clear();
  inForceFormats.clear();
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
