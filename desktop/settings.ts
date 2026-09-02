/**
 * Desktop-only preferences, stored next to the gateway's data in the user's
 * app-data folder. Everything the gateway itself needs still travels as
 * WARDEN_* environment variables — this file only remembers what the shell
 * should set them to on the next launch.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type DesktopSettings = {
  /** Last port the gateway ran on; re-probed before every launch. */
  port?: number;
  /** false → 127.0.0.1 only. true → 0.0.0.0, the team-facing LAN mode. */
  lanEnabled: boolean;
  /** Whether a public tunnel should come up with the gateway. */
  exposeEnabled: boolean;
  /** 'mock' is the no-models demo mode the first-run screen can fall back to. */
  adapter: 'real' | 'mock';
};

const DEFAULTS: DesktopSettings = { lanEnabled: false, exposeEnabled: false, adapter: 'real' };

export function settingsPath(userData: string): string {
  return join(userData, 'desktop-settings.json');
}

export function readSettings(userData: string): DesktopSettings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(userData), 'utf8')) as Partial<DesktopSettings>;
    const port =
      typeof raw.port === 'number' && Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536
        ? raw.port
        : undefined;
    return {
      ...(port !== undefined ? { port } : {}),
      lanEnabled: raw.lanEnabled === true,
      exposeEnabled: raw.exposeEnabled === true,
      adapter: raw.adapter === 'mock' ? 'mock' : 'real'
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeSettings(userData: string, settings: DesktopSettings): void {
  mkdirSync(dirname(settingsPath(userData)), { recursive: true });
  writeFileSync(settingsPath(userData), JSON.stringify(settings, null, 2) + '\n');
}
