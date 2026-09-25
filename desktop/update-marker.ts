/**
 * What one version of the app leaves on disk for the next.
 *
 * An update ends this process and starts another build, so anything the new
 * version must know (which version it replaced, which port the hooks were
 * using, whether the last attempt ever came up) has to survive in a file. All
 * of it lives under `userData/update/`, private to the user. No Electron import:
 * `scripts/test-desktop-update.ts` exercises every path against a temp dir.
 *
 * See docs/specs/desktop-auto-update.md §5.4, §5.5, §6.4 step 3, §6.5.
 */
import { cpSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { adoptionPlan, type PrefetchRecord } from './update-policy.js';

const VERSION = /^\d+\.\d+\.\d+$/;
const FILENAME = /^[A-Za-z0-9._-]+\.gguf$/;

export function updateDir(userData: string): string {
  return join(userData, 'update');
}

function ensureDir(userData: string): string {
  const dir = updateDir(userData);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/*
 * Write-then-rename, so a crash mid-write leaves the previous file or none,
 * never half of one. The marker especially: a torn marker read as "no update
 * pending" would hide a failed boot, which is the one thing it exists to show.
 */
function writePrivate(path: string, value: unknown): void {
  const partial = `${path}.partial`;
  writeFileSync(partial, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  chmodSync(partial, 0o600);
  renameSync(partial, path);
}

export type PendingUpdate = {
  schema: 1;
  from: string;
  to: string;
  requestedAt: string;
  /** Set once the gateway is confirmed stopped; the start of the coverage gap. */
  stoppedAt: string | null;
  /** The port hooks were configured for, to be reclaimed after the update. */
  port: number;
  tunnelWasOn: boolean;
  /** Decisions still in flight when the drain bound ran out. */
  cutOff: number;
  /** Relative to userData. */
  backup: string;
  /** Launches of the new version that began; one that never became healthy means a failed update. */
  bootAttempts: number;
};

function markerPath(userData: string): string {
  return join(updateDir(userData), 'pending.json');
}

function isIso(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/**
 * The pending update, or null.
 *
 * Unreadable counts as absent and is logged by the caller, not repaired. The
 * alternative, treating it as a failed update, would put the failure screen
 * in front of an administrator whose update in fact went fine, over a file
 * nobody asked them to understand.
 */
export function readMarker(userData: string): PendingUpdate | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(markerPath(userData), 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m['schema'] !== 1) return null;
  if (typeof m['from'] !== 'string' || !VERSION.test(m['from'])) return null;
  if (typeof m['to'] !== 'string' || !VERSION.test(m['to'])) return null;
  if (!isIso(m['requestedAt'])) return null;
  if (m['stoppedAt'] !== null && !isIso(m['stoppedAt'])) return null;
  const port = m['port'];
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof m['tunnelWasOn'] !== 'boolean') return null;
  const cutOff = m['cutOff'];
  if (typeof cutOff !== 'number' || !Number.isInteger(cutOff) || cutOff < 0) return null;
  if (typeof m['backup'] !== 'string') return null;
  const attempts = m['bootAttempts'];
  if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 0) return null;
  return {
    schema: 1,
    from: m['from'],
    to: m['to'],
    requestedAt: m['requestedAt'],
    stoppedAt: m['stoppedAt'],
    port,
    tunnelWasOn: m['tunnelWasOn'],
    cutOff,
    backup: m['backup'],
    bootAttempts: attempts
  };
}

export function writeMarker(userData: string, marker: PendingUpdate): void {
  ensureDir(userData);
  writePrivate(markerPath(userData), marker);
}

export function clearMarker(userData: string): void {
  rmSync(markerPath(userData), { force: true });
}

/**
 * Count a launch of the new version before anything else can go wrong.
 *
 * Written first, ahead of the gateway, so a crash anywhere later in boot still
 * leaves the count behind. The next launch then finds an attempt that never
 * reached healthy and shows the failed-update screen instead of looping.
 */
export function recordBootAttempt(userData: string, marker: PendingUpdate): PendingUpdate {
  const next = { ...marker, bootAttempts: marker.bootAttempts + 1 };
  writeMarker(userData, next);
  return next;
}

/*
 * Masked prompt text is held under a retention promise: seven days, expiry
 * checked on every read (CLAUDE.md, security posture). A copy in a backup
 * would sit outside that promise for as long as the backup does. It is also
 * the one file a migration going wrong costs nothing to lose.
 */
const NOT_BACKED_UP = /^prompts\.jsonl(\..*)?$/;

function lockDown(path: string): void {
  if (statSync(path).isDirectory()) {
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path)) lockDown(join(path, entry));
  } else {
    chmodSync(path, 0o600);
  }
}

/**
 * Copy `data/` aside before an update, and return where, relative to userData.
 *
 * Only `data/`. The models are large, are not touched by a data migration, and
 * can be downloaded again. Credentials live beside `data/`, not in it, and a
 * second copy of them has no reason to exist. One backup at a time: every
 * older `backup-*` is removed first. A backup chain nobody prunes becomes a
 * second audit store with no retention policy.
 */
export function backupData(userData: string, fromVersion: string): string {
  if (!VERSION.test(fromVersion)) throw new Error(`not a version: ${fromVersion}`);
  const dir = ensureDir(userData);
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('backup-')) rmSync(join(dir, entry), { recursive: true, force: true });
  }
  const relative = join('update', `backup-${fromVersion}`);
  const target = join(userData, relative, 'data');
  const source = join(userData, 'data');
  mkdirSync(target, { recursive: true, mode: 0o700 });
  if (existsSync(source)) {
    cpSync(source, target, {
      recursive: true,
      filter: (path) => !NOT_BACKED_UP.test(basename(path))
    });
  }
  lockDown(join(userData, relative));
  return relative;
}

function ledgerPath(userData: string): string {
  return join(updateDir(userData), 'prefetch.json');
}

export function readLedger(userData: string): PrefetchRecord[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(ledgerPath(userData), 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is PrefetchRecord =>
    !!r && typeof r === 'object' &&
    typeof r.filename === 'string' && FILENAME.test(r.filename) &&
    typeof r.url === 'string' &&
    typeof r.forVersion === 'string' && VERSION.test(r.forVersion));
}

/** Record a file the updater downloaded; replaces an earlier record of the same file. */
export function appendLedger(userData: string, record: PrefetchRecord): void {
  if (!FILENAME.test(record.filename)) throw new Error(`not a model filename: ${record.filename}`);
  ensureDir(userData);
  const rest = readLedger(userData).filter((r) => r.filename !== record.filename);
  writePrivate(ledgerPath(userData), [...rest, record]);
}

/**
 * On the first boot of a new version: keep the prefetched files its own
 * catalogue vouches for, delete the rest, and forget the ledger either way.
 *
 * Deletion only ever touches a filename that is in the ledger, passes the
 * filename pattern, and so cannot name a path outside `modelsDir`. Files the
 * administrator put there themselves are never in the ledger, because the
 * prefetch refuses to write over an existing file.
 */
export function adoptPrefetched(
  userData: string,
  modelsDir: string,
  catalog: readonly { filename: string; url: string | null }[]
): { keep: string[]; remove: string[] } {
  const plan = adoptionPlan(readLedger(userData), catalog);
  for (const filename of plan.remove) rmSync(join(modelsDir, filename), { force: true });
  rmSync(ledgerPath(userData), { force: true });
  return plan;
}
