/**
 * The small HTTP vocabulary every route file shares: wrapping an async handler,
 * reading an optional JSON file, and working out which address to hand an
 * employee. Nothing here knows about policy or the guard.
 */
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import type { Request, Response } from 'express';
import { HOST, PORT } from './config.js';
import { CompilerSetupRequiredError } from '../qvac/types.js';

/**
 * Is this failure the model not running, rather than the model not answering?
 *
 * They read identically in a stack trace and they need opposite advice from the
 * person in front of the console. A prompt the model could not turn into a rule
 * is worth rephrasing; a worker process that never started is not, and telling
 * somebody to "try saying it more plainly" when the SDK's RPC timed out after
 * 30 seconds sends them to rewrite a sentence that was never the problem.
 *
 * Matched on the SDK's own wording plus our load timeout and cooldown, because
 * neither carries a code. It is a heuristic and it errs toward the infra
 * reading: a false positive costs one line of unnecessary advice about the
 * gateway log, a false negative sends somebody in a circle.
 */
export function looksLikeModelDown(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('rpc initialization') ||
    m.includes('worker process') ||
    m.includes('failed to load') ||
    m.includes('not being retried') ||
    m.includes('plugin not found') ||
    m.includes('loading the') ||
    m.includes('model not found')
  );
}

/** Wrap an async route so a rejected promise becomes a 500 instead of a hang. */
export function asyncRoute(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response): void => {
    fn(req, res).catch((err: unknown) => {
      console.error('route error:', err);
      // The message alone, not `String(err)`: this text is rendered straight
      // into the console, and "Error: audience names nobody…" reads as a crash
      // where "audience names nobody…" reads as the instruction it is.
      if (!res.headersSent) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof CompilerSetupRequiredError) {
          res.status(409).json({ error: message, kind: 'compiler-setup-required' });
          return;
        }
        res.status(500).json({
          error: message,
          // The console renders different advice for each, so the classification
          // happens here where the error is, not by matching strings in the UI.
          kind: looksLikeModelDown(message) ? 'model-down' : 'other'
        });
      }
    });
  };
}

/**
 * Read an optional JSON file, falling back when it is absent.
 *
 * Several files here are authored by the team rather than generated, so a
 * missing one is a normal state during a build-out, not an error worth failing
 * a request over.
 */
export function readJsonFile<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Non-internal IPv4 addresses, so the banner tells teammates where to point. */
export function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap((ifaces) => ifaces ?? [])
    .filter((i) => i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

/**
 * Whether this process accepts connections from another machine at all.
 *
 * `HOST` is what was bound, so it is the fact; the interface list only says
 * what the machine has. The desktop app binds `127.0.0.1` until the
 * administrator allows LAN access, and on that gateway a LAN address is a
 * number nobody is listening on.
 */
export function listeningOn(host: string = HOST): 'loopback' | 'network' {
  return /^(127\.|localhost$|::1$)/.test(host) ? 'loopback' : 'network';
}

/** Where a teammate on this network would point, or null when nobody could. */
export function lanUrl(host: string = HOST): string | null {
  if (listeningOn(host) === 'loopback') return null;
  const lan = lanAddresses()[0];
  return lan ? `http://${lan}:${PORT}` : null;
}

export type Reach = {
  listening: 'loopback' | 'network';
  lanUrl: string | null;
  publicUrl: string | null;
  canChange: boolean;
};

/**
 * How another machine gets here, as facts and not as a verdict.
 *
 * "Reachable" is left for the reader to work out — either URL being set —
 * because a computed field would be a second copy of these two, and second
 * copies drift. `canChange` is whether a desktop shell is attached to ask;
 * without one this is set by `WARDEN_HOST` and a restart.
 *
 * `relayed` withholds the LAN address. `/health` answers without a credential
 * and through a tunnel, and the inside of somebody's network is not something
 * to tell a caller from the internet. A direct caller already had an address
 * for this machine; a relayed one is told the public address, which is theirs.
 */
export function reachFor(relayed: boolean, canChange: boolean, bound: string = HOST): Reach {
  return {
    listening: listeningOn(bound),
    lanUrl: relayed ? null : lanUrl(bound),
    publicUrl: process.env['WARDEN_PUBLIC_URL'] ?? null,
    canChange
  };
}

/**
 * The address to hand an employee, or null when there is none to hand.
 *
 * Taken from the request the console made, because that is by construction an
 * address that reached this server. Guessing from the interface list gets it
 * wrong on a machine with several, and an onboarding pack with the wrong host
 * fails in the least helpful way possible: silently, on someone else's laptop.
 *
 * It used to always answer, and that was the same failure by another road. A
 * console open on `localhost` fell through to the first LAN address without
 * asking whether the process was bound there, so a desktop install with LAN
 * access off — the default — issued setup messages pointing at a port that
 * refused every connection. Null is the honest answer there, and the caller
 * decides what to say about it. docs/prd/teams-onboarding.md §0.
 */
export function gatewayUrl(req: Request, bound: string = HOST): string | null {
  const configured = process.env['WARDEN_PUBLIC_URL'];
  if (configured) return configured.replace(/\/$/, '');
  // The Host header is written by the caller, and this URL is interpolated into
  // shell scripts and generated configs — so only a plain host[:port] shape is
  // accepted here. Anything else falls through to an interface address rather
  // than reaching a file somebody runs.
  const rawHost = req.header('host');
  const host = rawHost && /^[A-Za-z0-9.-]+(:\d+)?$/.test(rawHost) ? rawHost : undefined;
  if (host && !/^(localhost|127\.0\.0\.1)/.test(host)) {
    /**
     * Behind a tunnel — Cloudflare, Tailscale Funnel, ngrok — the edge
     * terminates TLS and forwards plain HTTP, so the scheme this process sees
     * is not the scheme the employee needs. Hardcoding `http://` there produces
     * an install command that fails on every machine except the one that
     * generated it, which is the worst kind of wrong: it looks right in the
     * console.
     *
     * `x-forwarded-proto` is set by the tunnel, not by the client, and it is
     * only read to build a URL — nothing is authorised on it — so trusting it
     * here costs nothing even if something else sets it.
     */
    const proto = req.header('x-forwarded-proto')?.split(',')[0]?.trim() ?? 'http';
    return `${proto === 'https' ? 'https' : 'http'}://${host}`;
  }

  // The console is open on the gateway machine itself, so localhost is what it
  // sees — but localhost is useless to everyone else. A LAN address, if this
  // process is bound to one; otherwise nothing, rather than a guess.
  return lanUrl(bound);
}
