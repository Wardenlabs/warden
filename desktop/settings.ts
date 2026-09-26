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
  /**
   * What the splash was told: Warden for me, or for a team.
   *
   * It used to be asked, acted on once, and forgotten, and the directory stood
   * in as the record — somebody in it meant the question had been answered.
   * That holds for "just me", which creates an identity on the spot. It does
   * not hold for a team: nobody is in the directory until the administrator
   * adds them, so until then the console took the install for a solo one, drew
   * the solo navigation with no Team item in it, and the splash asked again on
   * every launch. Absent means never asked, which is every install older than
   * this field and is handled as it always was.
   */
  intent?: 'solo' | 'team';
  /**
   * Check for updates on a schedule. Absent means yes (PRD decision 3): only an
   * explicit false turns it off, and a managed preference or
   * WARDEN_AUTO_UPDATE overrides it either way (`update-policy.ts`).
   */
  autoUpdate?: boolean;
  /**
   * The version that last came up healthy here. A launch of a newer one with no
   * update marker was still an update (a crash while one was staged, or a DMG
   * copied over by hand), and it goes on the record as one.
   */
  lastRunVersion?: string;
  /** The last update notification shown, as `kind:version`, so each is said
   * once across relaunches. */
  lastNotified?: string;
  /** "Move Warden to Applications" is said once per installation. */
  blockedLocationNotified?: boolean;
};

const DEFAULTS: DesktopSettings = { lanEnabled: false, exposeEnabled: false, adapter: 'real', autoUpdate: true };
const VERSION = /^\d+\.\d+\.\d+$/;

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
      adapter: raw.adapter === 'mock' ? 'mock' : 'real',
      ...(raw.intent === 'solo' || raw.intent === 'team' ? { intent: raw.intent } : {}),
      autoUpdate: raw.autoUpdate !== false,
      ...(typeof raw.lastRunVersion === 'string' && VERSION.test(raw.lastRunVersion) ? { lastRunVersion: raw.lastRunVersion } : {}),
      ...(typeof raw.lastNotified === 'string' && /^[a-z-]+:\d+\.\d+\.\d+$/.test(raw.lastNotified) ? { lastNotified: raw.lastNotified } : {}),
      ...(raw.blockedLocationNotified === true ? { blockedLocationNotified: true } : {})
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeSettings(userData: string, settings: DesktopSettings): void {
  mkdirSync(dirname(settingsPath(userData)), { recursive: true });
  writeFileSync(settingsPath(userData), JSON.stringify(settings, null, 2) + '\n');
}
