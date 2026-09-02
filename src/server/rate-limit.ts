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
 * In memory, so it resets when the process does — the same honest limitation
 * the quota counters carry. That matters for an attacker who can also make the
 * gateway restart, and not for the case this exists for.
 */

type Window = { count: number; resetAt: number };

export type Limiter = {
  /** Records one attempt. False means the caller is over its allowance. */
  take(key: string): boolean;
  /** Forget one key, for an attempt that turned out to be legitimate. */
  clear(key: string): void;
  /** Seconds until the current window ends, for `Retry-After`. */
  retryAfter(key: string): number;
};

/**
 * Windows are pruned on write rather than on a timer, which keeps this free of
 * anything the process has to remember to stop.
 */
const MAX_KEYS = 10_000;

export function limiter(windowMs: number, max: number): Limiter {
  const windows = new Map<string, Window>();

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
