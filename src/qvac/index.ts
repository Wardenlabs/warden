/**
 * Adapter selection. Everything downstream imports `adapter()` and never the
 * concrete classes, so switching to the mock is a matter of one env var.
 */
import { MockQvacAdapter } from './mock.js';
import { RealQvacAdapter } from './real.js';
import type { QvacAdapter } from './types.js';

let instance: QvacAdapter | null = null;

/** `WARDEN_ADAPTER=mock` runs the whole app with no model present. */
export function adapter(): QvacAdapter {
  if (!instance) {
    instance = process.env['WARDEN_ADAPTER'] === 'mock'
      ? new MockQvacAdapter()
      : new RealQvacAdapter();
  }
  return instance;
}

export function isMock(): boolean {
  return process.env['WARDEN_ADAPTER'] === 'mock';
}

export * from './types.js';
