/**
 * Whether this gateway is in the middle of something a restart would break.
 *
 * Asked by the desktop updater before it offers "Restart to update", over the
 * shell channel and never over HTTP: nothing outside the desktop process can
 * ask, and there is no route that could restart anything.
 *
 * Two kinds of work have their own rollback and must not be cut:
 *
 * - A model transfer. The lock in `setup/transfer-lock.ts` is taken by every
 *   writer of the models directory (Library downloads, custom imports, terminal
 *   setup, the desktop first run, and the updater's own prefetch), so asking
 *   the lock covers them all at once rather than one registry each.
 * - A model swap, test or activation, which holds a role lease so a decision
 *   never runs on half-changed weights (`qvac/coordination.ts`,
 *   docs/MODEL-MANAGEMENT.md).
 *
 * Decisions in flight are not a reason to refuse. They are what the drain waits
 * for, and refusing on them would mean a busy gateway could never be updated.
 */
import { currentTransfer } from '../setup/transfer-lock.js';
import { modelManagementPending } from '../models/manager.js';
import { modelsRoot } from '../models/store.js';
import { roleChangePending } from '../qvac/coordination.js';

export type BusyReason = 'model-download' | 'model-change';

export function busyReasons(): BusyReason[] {
  const reasons: BusyReason[] = [];
  let transferring: boolean;
  try {
    transferring = currentTransfer(modelsRoot()) !== null;
  } catch {
    // An ownership file nobody can read is what an interrupted transfer
    // leaves behind. Busy is the direction that withholds a restart.
    transferring = true;
  }
  if (transferring) reasons.push('model-download');
  if (roleChangePending() || modelManagementPending()) reasons.push('model-change');
  return reasons;
}
