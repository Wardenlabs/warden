/**
 * Fixed-window counters, for the two things that cost something once a gateway
 * is reachable from outside the building.
 *
 * No dependency: the runtime here is express, zod and the QVAC SDK, and a
 * counter keyed by a string does not earn a fourth. Fixed windows rather than a
 * sliding log because what this guards against is a flood, and the worst a
 * fixed window gives an attacker is twice the limit across a boundary — a
 * rounding error against "no limit at all", which is the state this replaces.
 *
 * Distinct from `guard/quota.ts`, which counts prompts per role per day because
 * an administrator wrote that down as policy. This counts requests per window
 * because a stranger found the URL. One is a rule; the other is a wall.
 *
 * The request counters live in memory and reset when the process does, the same
 * honest limitation the quota counters carry: losing one costs a caller a
 * minute of allowance. The administrative-failure counter does not get that
 * luxury and is persisted — see `persistentLimiter` for why a restart there is
 * the difference between a wall and a speed bump.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type Window = { count: number; resetAt: number };

export type Limiter = {
  /** Records one attempt. False means the caller is over its allowance. */
  take(key: string): boolean;
  /** Forget one key, for an attempt that turned out to be legitimate. */
  clear(key: string): void;
  /** Seconds until the current window ends, for `Retry-After`. */
  retryAfter(key: string): number;
  /** Live windows, for the persistent wrapper. */
  snapshot(): Record<string, Window>;
};

/**
 * Windows are pruned on write rather than on a timer, which keeps this free of
 * anything the process has to remember to stop.
 */
const MAX_KEYS = 10_000;

/**
 * A limiter that survives a restart.
 *
 * Only worth the disk for the administrative-failure counter, and there it is
 * the difference between a wall and a speed bump: without it, anybody guessing
 * at the admin key gets ten fresh attempts every time the process restarts, and
 * a gateway that restarts is not an exotic condition — it is what happens when
 * the desktop app is reopened. The decision counters stay in memory, where
 * losing a tally costs one caller a minute of allowance and nothing else.
 *
 * Written on every rejection rather than on every request: the file changes
 * only when somebody is failing, which is rare on a working deployment and
 * self-limiting on a hostile one, since the limiter itself caps how often that
 * can happen.
 *
 * 0600, beside the settings file and the directory, because it holds hashed
 * caller keys and the shape of who has been trying.
 */
export function persistentLimiter(windowMs: number, max: number, path: string): Limiter {
  const inner = limiter(windowMs, max, loadWindows(path));
  const save = (): void => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(inner.snapshot()));
      chmodSync(path, 0o600);
    } catch {
      // A limiter that cannot write must still limit. Losing persistence
      // degrades this to the in-memory version, which is where it started.
    }
  };
  return {
    take(key) {
      const allowed = inner.take(key);
      if (!allowed) save();
      return allowed;
    },
    clear(key) {
      inner.clear(key);
      save();
    },
    retryAfter: (key) => inner.retryAfter(key),
    snapshot: () => inner.snapshot()
  };
}

function loadWindows(path: string): Map<string, Window> {
  const windows = new Map<string, Window>();
  if (!existsSync(path)) return windows;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Window>;
    const now = Date.now();
    for (const [key, window] of Object.entries(raw)) {
      // Expired windows are not restored: a counter from last week must not
      // hold somebody out, and reading it back would make the file grow
      // forever.
      if (window && typeof window.count === 'number' && window.resetAt > now) {
        windows.set(key, window);
      }
    }
  } catch {
    // A corrupt file is an empty one. The alternative — refusing to start —
    // would let a bad write lock an administrator out of their own gateway.
  }
  return windows;
}

export function limiter(windowMs: number, max: number, initial?: Map<string, Window>): Limiter {
  const windows = initial ?? new Map<string, Window>();

  function sweep(now: number): void {
    if (windows.size < MAX_KEYS) return;
    for (const [key, window] of windows) {
      if (window.resetAt <= now) windows.delete(key);
    }
    // Still full of live windows: either a very large deployment or the flood
    // itself. Dropping the oldest quarter is the only bounded answer, and it
    // does let those callers start again — which is why it happens after the
    // expiry sweep and never before it.
    if (windows.size >= MAX_KEYS) {
      const oldest = [...windows.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
      for (const [key] of oldest.slice(0, Math.floor(MAX_KEYS / 4))) windows.delete(key);
    }
  }

  return {
    take(key) {
      const now = Date.now();
      sweep(now);
      const window = windows.get(key);
      if (!window || window.resetAt <= now) {
        windows.set(key, { count: 1, resetAt: now + windowMs });
        return true;
      }
      window.count += 1;
      return window.count <= max;
    },
    clear(key) {
      windows.delete(key);
    },
    retryAfter(key) {
      const window = windows.get(key);
      if (!window) return 0;
      return Math.max(1, Math.ceil((window.resetAt - Date.now()) / 1000));
    },
    snapshot() {
      const now = Date.now();
      const live: Record<string, Window> = {};
      for (const [key, window] of windows) {
        if (window.resetAt > now) live[key] = window;
      }
      return live;
    }
  };
}

/**
 * Who to count against, when the caller may or may not have said who they are.
 *
 * The API key when there is one, because identity here is the key and only the
 * key — and because counting by address would let one office behind a single
 * NAT exhaust the allowance of everybody in it. The socket address otherwise:
 * an unauthenticated flood has nothing else to be counted by, and that is
 * exactly the traffic a public gateway has to survive.
 *
 * The key is folded to a short hash rather than stored. This map outlives every
 * request in a process whose audit log was built specifically to avoid holding
 * secrets, and a credential sitting in it as a plain string would be the one
 * place they do. The hash is FNV-1a: not a password hash and not pretending to
 * be one — it exists so a heap dump does not hand over working keys.
 */
export function callerKey(credential: string | undefined, address: string | undefined): string {
  if (credential) {
    let hash = 2166136261;
    for (let i = 0; i < credential.length; i += 1) {
      hash ^= credential.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `k:${(hash >>> 0).toString(36)}`;
  }
  return `a:${address ?? 'unknown'}`;
}
