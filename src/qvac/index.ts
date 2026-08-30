/**
 * Adapter selection. Everything downstream imports `adapter()` and never the
 * concrete classes, so switching to the mock is a matter of one env var.
 */
import { MockQvacAdapter } from './mock.js';
import { LlamaCppAdapter } from './llamacpp.js';
import { RealQvacAdapter } from './real.js';
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
    if (choice === 'mock') instance = new MockQvacAdapter();
    else if (choice === 'llamacpp') instance = new LlamaCppAdapter();
    else instance = new RealQvacAdapter();
  }
  return instance;
}

export function isMock(): boolean {
  return process.env['WARDEN_ADAPTER'] === 'mock';
}

export * from './types.js';
