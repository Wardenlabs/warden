/**
 * The audit entry for a desktop update, written by the version that came up.
 *
 * The version that went down cannot write it, because it is gone before the
 * gap it would describe has ended. So the desktop shell hands the new gateway
 * what the old one knew, through its environment and on this launch only:
 * which version it replaced, when that gateway stopped, and how many requests
 * the drain had to cut. This writes it once, beside the decisions, in the
 * same chain.
 *
 * `unknown` is a legitimate value for when it stopped and for how many
 * requests were cut. Squirrel.Mac installs on any exit, a crash included, and
 * a DMG copied over by hand leaves no marker at all. The shell still knows a
 * different version ran last, and a gap on the record with an honest
 * "unknown" beats no record.
 *
 * The actor is the desktop operator, not an administrator. The desktop window
 * has no identity, and an audit that names one it cannot know would be the
 * governance record making something up (docs/prd/desktop-auto-update.md).
 */
import { recordAdminAction } from '../audit/log.js';
import { installationVersion } from './installation.js';

const VERSION = /^\d+\.\d+\.\d+$/;

export const UPDATE_ACTOR = { id: 'desktop', role: 'operator' } as const;

/**
 * The action text, or null when the environment does not describe an update.
 *
 * Every field is checked before any of it reaches the chain, since the audit is
 * append-only and a malformed line stays forever. A partial description records
 * nothing and says so on stderr. That is a smaller loss than a false entry.
 */
export function updateAction(env: NodeJS.ProcessEnv, version: string, now: Date): string | null {
  const from = env['WARDEN_UPDATED_FROM'];
  if (from === undefined) return null;
  const stoppedAt = env['WARDEN_UPDATED_STOPPED_AT'] ?? '';
  const cutOffRaw = env['WARDEN_UPDATE_CUTOFF'] ?? '';
  const cutOff = Number(cutOffRaw);
  const stoppedOk = stoppedAt === 'unknown' || !Number.isNaN(Date.parse(stoppedAt));
  const cutOffOk = cutOffRaw === 'unknown' || (cutOffRaw !== '' && Number.isInteger(cutOff) && cutOff >= 0);
  if (!VERSION.test(from) || !stoppedOk || !cutOffOk) {
    console.error('  update    the shell described an update this gateway could not read; no audit entry written');
    return null;
  }
  const stopped = stoppedAt === 'unknown' ? 'unknown' : new Date(stoppedAt).toISOString();
  return `desktop update ${from} -> ${version}; offline ${stopped} -> ${now.toISOString()}; requests cut off ${cutOffRaw === 'unknown' ? 'unknown' : cutOff}`;
}

/** Called once, after the server is listening. */
export function recordUpdateIfAny(env: NodeJS.ProcessEnv = process.env): void {
  const action = updateAction(env, installationVersion(), new Date());
  if (action) recordAdminAction(UPDATE_ACTOR, action, 200);
}
