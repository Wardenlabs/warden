/**
 * Prompt text the console may still show, and the date it stops existing.
 *
 * The audit log keeps a hash of the prompt and never the text. That is the
 * promise the record makes and it does not move: `recordDecision` strips
 * `maskedPrompt` before writing, and nothing here is written into the chain
 * `verifyChain()` walks. What this file adds is a **second store, with a
 * different job and a shorter life** — so an administrator can read what
 * their team actually sent last Tuesday, and cannot read it next month.
 *
 * It replaces an in-memory Map capped at 300 entries that emptied on every
 * restart. That was not a retention policy, it was an accident of process
 * lifetime: it could lose an hour of context to a crash and keep nothing on
 * purpose. A deliberate window is both more useful and easier to describe to
 * the people being logged, which is the part that actually matters — "your
 * prompts are readable by an administrator for seven days" is a sentence a
 * company can put in writing. "Until the gateway restarts" is not.
 *
 * Three properties this has to keep, and each of them is load-bearing:
 *
 * 1. **Expiry is enforced on read, not only by a sweep.** A file that was not
 *    swept — the process died, the disk was restored from a backup, somebody
 *    copied it to another machine — must not be able to serve text past its
 *    date. Every read filters by the cutoff before returning anything, so the
 *    sweep is an optimisation and never the guarantee.
 *
 * 2. **Only the masked text is ever stored.** Secrets are masked before any
 *    model sees the prompt, and this store is downstream of that. A raw API
 *    key pasted into a prompt is `[REDACTED:OpenAI key]` here, exactly as it
 *    is everywhere else. There is no path from this file back to the raw value.
 *
 * 3. **Retention is one number, and zero turns it off.** A deployment that
 *    wants the old behaviour — nothing on disk, nothing surviving a restart —
 *    sets `WARDEN_PROMPT_RETENTION_DAYS=0` and gets exactly that, including
 *    deleting the file on the way past.
 *
 * The file is written `0600` and gitignored, like every other file in `data/`
 * that holds something worth not leaking.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { dirname } from 'node:path';

const STORE_PATH = process.env['WARDEN_PROMPT_PATH'] ?? 'data/prompts.jsonl';

/**
 * How long an administrator can read a prompt for.
 *
 * Seven days because the question this exists to answer is "what happened this
 * week" — an operations lead looking at a block, a person appealing one, a
 * manager asked what their team is sending. A month would answer the same
 * question and hold four times the material for someone who breaches the
 * gateway; a day would lose the weekend.
 *
 * `0` disables the store entirely and takes the file with it.
 */
const RETENTION_DAYS = numberFromEnv('WARDEN_PROMPT_RETENTION_DAYS', 7);

/**
 * Ceiling on entries held in memory and on disk.
 *
 * A bound rather than a policy: retention is what decides whether something is
 * readable, and this only stops a busy gateway from holding a week of a very
 * large team in one process. Oldest go first, so the cap can only ever make
 * the window shorter than the retention promises — never longer.
 */
const MAX_ENTRIES = numberFromEnv('WARDEN_PROMPT_MAX', 5000);

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  // A malformed value is not a licence to invent a retention period. The
  // documented default is the only other answer that can be given honestly.
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function retentionDays(): number {
  return RETENTION_DAYS;
}

export function promptsEnabled(): boolean {
  return RETENTION_DAYS > 0;
}

/**
 * Retention off means the file goes, and it has to go at import rather than on
 * first use.
 *
 * This was written inside `load()` first, which is lazy — and with retention
 * off nothing ever calls `load()`, because `remember()` and `textFor()` both
 * return before they reach it. So the one configuration whose whole purpose is
 * "keep nothing on disk" was the one configuration that left last week's
 * prompts sitting there readable, indefinitely. Caught by testing the setting
 * instead of trusting the comment above it.
 *
 * At import, so it happens once, on the boot that changed the setting, before
 * anything can be served from the file it is deleting.
 */
if (RETENTION_DAYS === 0) {
  try {
    if (existsSync(STORE_PATH)) rmSync(STORE_PATH);
  } catch {
    /* nothing depends on it, and a decision must not fail over it */
  }
}

type Held = { auditId: string; at: number; text: string };

/** Insertion-ordered, so deleting the first key evicts the oldest. */
let held: Map<string, Held> | null = null;

function cutoff(): number {
  return Date.now() - RETENTION_DAYS * 86_400_000;
}

function load(): Map<string, Held> {
  if (held) return held;
  held = new Map();

  if (!promptsEnabled()) return held;

  const since = cutoff();
  try {
    for (const line of readFileSync(STORE_PATH, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        // One unreadable line loses one prompt, not the store. This file is
        // a convenience; refusing to start over a torn append would make it
        // an availability risk, which it is emphatically not worth being.
        continue;
      }
      const entry = row as Partial<Held>;
      if (typeof entry.auditId !== 'string' || typeof entry.text !== 'string') continue;
      const at = typeof entry.at === 'number' ? entry.at : 0;
      if (at < since) continue;
      held.set(entry.auditId, { auditId: entry.auditId, at, text: entry.text });
    }
  } catch {
    /* no file yet, which is the normal first-boot case */
  }

  trim();
  // Rewritten on load, so an expired entry is gone from disk within one
  // restart even if the process is never asked for anything.
  compact();
  return held;
}

function trim(): void {
  if (!held) return;
  while (held.size > MAX_ENTRIES) {
    const oldest = held.keys().next().value;
    if (oldest === undefined) break;
    held.delete(oldest);
  }
}

function compact(): void {
  if (!held || !promptsEnabled()) return;
  try {
    mkdirSync(dirname(STORE_PATH), { recursive: true });
    const body = [...held.values()].map((entry) => JSON.stringify(entry)).join('\n');
    writeFileSync(STORE_PATH, body ? body + '\n' : '', { mode: 0o600 });
  } catch {
    /* the store is a convenience; a read-only disk must not break decisions */
  }
}

/** Appends since the last compaction, so compaction is not run on every write. */
let appended = 0;

/**
 * Remember one decision's prompt, if retention allows it.
 *
 * Takes the masked text, never the raw prompt — the caller has already been
 * through `sanitize`, and there is no overload of this that accepts the other
 * one.
 */
export function remember(auditId: string, maskedPrompt: string): void {
  if (!promptsEnabled() || !auditId || !maskedPrompt) return;
  const store = load();

  const entry: Held = { auditId, at: Date.now(), text: maskedPrompt };
  store.delete(auditId);
  store.set(auditId, entry);
  trim();

  try {
    mkdirSync(dirname(STORE_PATH), { recursive: true });
    appendFileSync(STORE_PATH, JSON.stringify(entry) + '\n', { mode: 0o600 });
    appended++;
    // Rewrite once the tail is comparable to the live set, which bounds the
    // file at roughly twice what it holds instead of letting it grow forever.
    if (appended > Math.max(200, store.size)) {
      compact();
      appended = 0;
    }
  } catch {
    /* held in memory regardless; the disk copy is what survives a restart */
  }
}

/**
 * The text for one decision, or `undefined` once it has expired.
 *
 * The cutoff is applied here and not only at load, which is the whole point:
 * a long-running gateway would otherwise serve a prompt for as many days as
 * it stayed up.
 */
export function textFor(auditId: string): string | undefined {
  if (!promptsEnabled()) return undefined;
  const entry = load().get(auditId);
  if (!entry) return undefined;
  if (entry.at < cutoff()) {
    load().delete(auditId);
    return undefined;
  }
  return entry.text;
}

/** What the console says out loud about how long any of this lasts. */
export function retentionSummary(): { days: number; held: number; max: number } {
  return { days: RETENTION_DAYS, held: promptsEnabled() ? load().size : 0, max: MAX_ENTRIES };
}

/** Forget everything, on disk and in memory. Used by the company reset. */
export function forgetAll(): void {
  held = new Map();
  appended = 0;
  try {
    if (existsSync(STORE_PATH)) rmSync(STORE_PATH);
  } catch {
    /* nothing depends on it */
  }
}
