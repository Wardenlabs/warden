/**
 * Adapter selection. Everything downstream imports `adapter()` and never the
 * concrete classes, so switching to the mock is a matter of one env var.
 */
import { MockQvacAdapter } from './mock.js';
import { LlamaCppAdapter } from './llamacpp.js';
import { RealQvacAdapter } from './real.js';
import { RemoteCompilerAdapter, remoteCompilerConfig, validate as validateRemoteCompiler } from './remote.js';
import { CompilerSetupRequiredError, type CompleteRequest, type QvacAdapter } from './types.js';
import { compilerSetupRequired } from '../settings.js';
import { loadAdjudicatorSettings } from '../settings.js';
import type { ZodType } from 'zod';
import { withModelRole } from './coordination.js';
import { CliCompilerAdapter, cliCompilerConfig, cliCompilerEnvironmentError } from './cli-compiler.js';
import { isKevChoice, KevAdapter, kevConfig } from './kev.js';

let instance: QvacAdapter | null = null;

/**
 * `WARDEN_ADAPTER=mock` runs the whole app with no model present.
 *
 * `llamacpp` runs the same weights under a different engine. It exists so that
 * "would this work better on something other than QVAC" can be answered by a
 * paired run over the same bench cells rather than by argument — see
 * `llamacpp.ts`. It is loaded lazily and its dependency is not in
 * `package.json`, so selecting it is a deliberate act and everyone else pays
 * nothing for its existence.
 */
let localInstance: QvacAdapter | null = null;
let compilerInstance: QvacAdapter | null = null;
let compilerSignature = '';
const kevInstances = new Map<string, KevAdapter>();

function activeKev(local: QvacAdapter): KevAdapter | null {
  if (process.env['WARDEN_ADAPTER'] === 'mock') return null;
  if (process.env['WARDEN_MODEL_ADJUDICATOR']?.trim()) return null;
  const selected = loadAdjudicatorSettings();
  if (selected.modelId || !isKevChoice(selected.model)) return null;
  const config = kevConfig(selected.model);
  const signature = JSON.stringify([config.choice, config.baseUrl, Boolean(config.apiKey), config.timeoutMs]);
  let current = kevInstances.get(signature);
  if (!current) {
    current = new KevAdapter(local, config);
    kevInstances.set(signature, current);
  }
  return current;
}

function roleAdapter(local: QvacAdapter, role: CompleteRequest['role']): QvacAdapter {
  if (role === 'compiler') return readyCompiler(local);
  if (role === 'adjudicator') return activeKev(local) ?? local;
  return local;
}

function compilerAdapter(local: QvacAdapter): QvacAdapter {
  if (compilerEnvironmentError()) return local;
  if (!process.env['WARDEN_COMPILER_CLI']?.trim() && !process.env['WARDEN_COMPILER_API']?.trim() && process.env['WARDEN_MODEL_COMPILER']?.trim()) return local;
  const cli = cliCompilerConfig();
  const remote = cli ? null : remoteCompilerConfig();
  const signature = JSON.stringify([cli, remote]);
  if (!compilerInstance || signature !== compilerSignature) {
    compilerInstance = cli ? new CliCompilerAdapter(local, cli) : remote ? new RemoteCompilerAdapter(local, remote) : local;
    compilerSignature = signature;
  }
  return compilerInstance;
}

/** A malformed explicit override is never permission to use another provider.
 * Status remains readable; only an actual compiler request raises the error. */
export function compilerEnvironmentError(): string | null {
  const cliError = cliCompilerEnvironmentError();
  if (cliError) return cliError;
  if (process.env['WARDEN_COMPILER_CLI']?.trim()) return null;
  const baseUrl = process.env['WARDEN_COMPILER_API']?.trim();
  if (!baseUrl) return null;
  try {
    validateRemoteCompiler({ baseUrl, apiKey: process.env['WARDEN_COMPILER_API_KEY']?.trim() ?? '', model: process.env['WARDEN_COMPILER_MODEL']?.trim() || 'default', timeoutMs: 60_000 });
    return null;
  } catch {
    return 'The compiler endpoint environment settings are incomplete or invalid. Check WARDEN_COMPILER_API and its API key, then restart Warden. HTTPS and a key are required except for a local endpoint.';
  }
}

function readyCompiler(local: QvacAdapter): QvacAdapter {
  const environmentError = compilerEnvironmentError();
  if (environmentError) throw new CompilerSetupRequiredError(environmentError);
  if (compilerSetupRequired()) throw new CompilerSetupRequiredError();
  return compilerAdapter(local);
}

/** The routing object stays stable, while each compiler call captures the
 * currently saved connection. Updating it never disposes the local guard. */
export function adapter(): QvacAdapter {
  if (!instance) {
    const choice = process.env['WARDEN_ADAPTER'];
    const local = localInstance = choice === 'mock' ? new MockQvacAdapter() : choice === 'llamacpp' ? new LlamaCppAdapter() : new RealQvacAdapter();
    instance = {
      complete: (req) => withModelRole(req.role, () => roleAdapter(local, req.role).complete(req)),
      completeJSON: <T>(req: CompleteRequest, schema: ZodType<T>, json: Record<string, unknown>) =>
        withModelRole(req.role, () => roleAdapter(local, req.role).completeJSON(req, schema, json)),
      embed: (texts) => withModelRole('embedder', () => local.embed(texts)),
      ocr: (path) => withModelRole('ocr', () => local.ocr(path)),
      stats: () => local.stats(),
      dispose: () => local.dispose()
    };
  }
  return instance;
}

export function refreshCompiler(): void { compilerInstance = null; compilerSignature = ''; }

/**
 * Where rule compilation runs, for the console and the measurement records.
 *
 * An administrator ratifying a draft should be able to see whether the model
 * that wrote it was theirs, and a recorded run should say the same. Returns
 * null when compilation is explicitly local or the mock demo is running.
 */
export function remoteCompiler(): string | null {
  adapter();
  const a = compilerAdapter(localInstance!);
  if (a instanceof CliCompilerAdapter) return a.describe();
  return a instanceof RemoteCompilerAdapter ? a.describe() : null;
}

export function isMock(): boolean {
  return process.env['WARDEN_ADAPTER'] === 'mock';
}

/**
 * Which engine is answering, as a name rather than a boolean.
 *
 * `isMock()` splits the world into mock and not-mock, which was enough while
 * there was one real runtime and is a trap now that there are two: a bench
 * cache keyed on "real" hands a `llamacpp` run the answers QVAC already gave,
 * and the paired comparison the second runtime exists for reports a perfect
 * tie without running a single generation. Anything caching or recording a
 * result must key on this, not on `isMock()`.
 */
export function adapterName(): 'mock' | 'llamacpp' | 'qvac' | 'kev' {
  const choice = process.env['WARDEN_ADAPTER'];
  const selected = loadAdjudicatorSettings();
  if (choice !== 'mock' && !process.env['WARDEN_MODEL_ADJUDICATOR']?.trim() && !selected.modelId && isKevChoice(selected.model)) return 'kev';
  return choice === 'mock' ? 'mock' : choice === 'llamacpp' ? 'llamacpp' : 'qvac';
}

export * from './types.js';
