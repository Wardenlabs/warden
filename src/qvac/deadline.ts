/**
 * A hard bound on any SDK call, because none of them come with one.
 *
 * The guard is allowed to be wrong and is allowed to be slow. It is not allowed
 * to never answer: the hook waits 30s and then fails open by design, so a pass
 * that parks is a pass that has been skipped, and "make the request expensive
 * enough to judge" becomes a way through. Two full corpus runs died exactly that
 * way — one on an embedding of an oversized prompt, one on a model download over
 * the P2P registry — each with the worker pinned and no progress for a quarter
 * of an hour.
 *
 * Every caller resolves a rejection here to something stricter: retrieval
 * degrades to adjudicating every applicable rule, an unreadable attachment
 * escalates, a failed adjudication escalates. Stricter, never stuck.
 */

/**
 * Reject once `ms` has passed, whatever the underlying call is still doing.
 *
 * This frees the caller, not the worker. `embed()`, `ocr()` and `loadModel()`
 * take no request id, so there is nothing to cancel and the abandoned work keeps
 * a core busy until it finishes on its own. That is the cost of bounding the
 * guard's latency, and it is worth paying — a pass that never returns has no
 * verdict at all.
 */
export async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not return within ${ms}ms`)), ms);
  });

  // If the deadline wins, the abandoned work may still settle later; swallow
  // that so it cannot surface as an unhandled rejection and take the process
  // down long after nobody was waiting for it.
  work.catch(() => {});

  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}
