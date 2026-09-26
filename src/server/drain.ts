/**
 * Stop taking work, and let the work already taken finish.
 *
 * Used before a desktop update restarts the gateway. The plain `shutdown` path
 * gives the process four seconds and exits, which is right for quitting and
 * wrong here: an adjudication on a local model can take far longer than four
 * seconds, and a hook whose request is cut mid-decision fails open. That
 * prompt reaches the assistant unchecked, although it arrived while Warden was
 * up. Draining turns that into the unavoidable case only, where a prompt
 * arrives while Warden is down.
 *
 * What a refused request looks like matters as much as refusing it. The hook
 * treats a transport failure, or an error with no JSON body, as "Warden
 * unreachable". A JSON error body is handed back to it as an answer, and that
 * path was never verified for a 503. So a draining gateway does not answer
 * new requests at all: the listening socket is closed, idle keep-alive sockets
 * are dropped, and a new request arriving on a socket that was already open
 * (the tunnel's `cloudflared` holds one) has its socket destroyed.
 *
 * See docs/specs/desktop-auto-update.md §6.4.
 */
import type { Server } from 'node:http';
import type { RequestHandler } from 'express';

let draining = false;
let inFlight = 0;

/*
 * The live-decision stream never finishes by design. Counting it would make
 * every drain wait out its whole bound for a console tab that is merely open.
 */
const neverFinishes = (method: string, path: string): boolean => method === 'GET' && path === '/api/events';

/**
 * First in the middleware chain, so a draining gateway spends nothing on a
 * request: no CORS, no audit line for an attempt that was never handled, no
 * body parsing.
 */
export const drainGate: RequestHandler = (req, res, next) => {
  if (draining) {
    req.socket.destroy();
    return;
  }
  if (neverFinishes(req.method, req.path)) {
    next();
    return;
  }
  inFlight++;
  let settled = false;
  // `close` fires for a completed response and for a client that went away,
  // so every counted request is uncounted exactly once.
  res.once('close', () => {
    if (settled) return;
    settled = true;
    inFlight--;
  });
  next();
};

export function inFlightRequests(): number {
  return inFlight;
}

export function isDraining(): boolean {
  return draining;
}

/**
 * Refuse new work, then wait up to `boundMs` for what is in flight.
 *
 * `cutOff` is how many requests were still running when the bound ran out.
 * The updater writes it into the audit entry the new version records, so a
 * decision the restart cut short is on the record rather than inferred.
 * Irreversible within this process: the next thing after a drain is a
 * shutdown.
 */
export async function drain(server: Server, boundMs: number): Promise<{ cutOff: number; waitedMs: number }> {
  const started = Date.now();
  draining = true;
  server.close();
  server.closeIdleConnections();
  while (inFlight > 0 && Date.now() - started < boundMs) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { cutOff: inFlight, waitedMs: Date.now() - started };
}

/** Tests only: a drained module is otherwise final for the process. */
export function resetDrainForTests(): void {
  draining = false;
  inFlight = 0;
}
