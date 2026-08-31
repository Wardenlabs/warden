/**
 * Adapter selection. Everything downstream imports `adapter()` and never the
 * concrete classes, so switching to the mock is a matter of one env var.
 */
import { MockQvacAdapter } from './mock.js';
import { LlamaCppAdapter } from './llamacpp.js';
import { RealQvacAdapter } from './real.js';
import { RemoteCompilerAdapter, remoteCompilerConfig } from './remote.js';
import type { QvacAdapter } from './types.js';

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
export function adapter(): QvacAdapter {
  if (!instance) {
    const choice = process.env['WARDEN_ADAPTER'];
    let local: QvacAdapter;
    if (choice === 'mock') local = new MockQvacAdapter();
    else if (choice === 'llamacpp') local = new LlamaCppAdapter();
    else local = new RealQvacAdapter();

    // The wrap is additive and role-scoped: everything the guard does still
    // runs on `local`, and only the rule compiler is routed off-machine. When
    // the feature is unconfigured this returns the local adapter untouched, so
    // a default install has no network path from any model call.
    const remote = remoteCompilerConfig();
    instance = remote ? new RemoteCompilerAdapter(local, remote) : local;
  }
  return instance;
}

/**
 * Where rule compilation runs, for the console and the measurement records.
 *
 * An administrator ratifying a draft should be able to see whether the model
 * that wrote it was theirs, and a recorded run should say the same. Returns
 * null when compilation is local, which is the default.
 */
export function remoteCompiler(): string | null {
  const a = adapter();
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
export function adapterName(): 'mock' | 'llamacpp' | 'qvac' {
  const choice = process.env['WARDEN_ADAPTER'];
  return choice === 'mock' ? 'mock' : choice === 'llamacpp' ? 'llamacpp' : 'qvac';
}

export * from './types.js';
