/**
 * Everything that runs ahead of every route. `app.ts` decides the order and
 * says why; this file holds what each layer does.
 */
import type { Express, NextFunction, Request, Response } from 'express';
import { recordAdminAction } from '../audit/log.js';
import { actorForCredential } from '../policy/people.js';
import { isLoopback, needsAdmin, requireAdmin } from './admin-auth.js';
import { callerKey, limiter } from './rate-limit.js';

/**
 * The console is served by this same process, so same-origin needs no CORS at
 * all. The wildcard that used to sit here let any web page an admin happened to
 * visit read the directory and post policy changes cross-origin, with the
 * browser's origin check the only thing standing in the way. Serving web/ from
 * a separate dev port is the one case that needs an exception, and it is opt-in
 * and explicit.
 *
 * `admin-auth.ts` is now the thing standing in the way, and it is the one that
 * should be: an origin check only ever governed browsers, and the employee
 * typing the URL was never one. This stays narrow anyway — a second lock on a
 * door costs nothing, and a wildcard here would hand an attacker's page the
 * administrator's own loopback trust.
 */
export function corsIfConfigured(app: Express): void {
  const origin = process.env['WARDEN_CORS_ORIGIN'];
  if (!origin) return;
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Headers', 'content-type, authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    next();
  });
  app.options(/.*/, (_req, res) => res.sendStatus(204));
}

/*
 * Whether to refuse a proxied request whose proxy did not say `https`.
 *
 * A proxy that sets no `x-forwarded-proto` is not making a claim, and refusing
 * on an absent header would break working deployments to protect against a
 * guess — so by default that case is allowed. This flag is for an administrator
 * who knows their proxy sets it and wants the stricter reading.
 */
const REQUIRE_HTTPS = process.env['WARDEN_REQUIRE_HTTPS'] === '1';

/*
 * Headers a browser needs whether or not anybody exposes this gateway.
 *
 * Cheap, and none of them can break a caller that is not a browser. `nosniff`
 * because the console serves user-named content; `DENY` because nothing here
 * is meant to be framed and framing it is how an attacker's page borrows an
 * administrator's session; `no-referrer` because a gateway URL carrying an
 * install token must not travel to whatever a person clicks next.
 *
 * HSTS only when the request actually arrived over TLS. Sending it on plain
 * HTTP would pin a browser to https for a host that may only ever speak http
 * on a LAN, which locks somebody out of their own console.
 */
export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');

  const proto = req.header('x-forwarded-proto');
  if (proto === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');

  /*
   * Refuse a request a proxy has told us arrived over plain HTTP.
   *
   * Every employee request carries an API key in a header, and the install
   * link carries one in its path. Over http through a tunnel that is a
   * credential handed to every hop, and the credential is somebody's whole
   * identity here.
   *
   * Only when the proxy SAYS http, or when `WARDEN_REQUIRE_HTTPS=1` and the
   * proxy said nothing. A direct request on a LAN has no forwarded headers at
   * all and is untouched: this is about what happens once somebody puts the
   * gateway on the internet.
   */
  const proxied = req.header('x-forwarded-for') !== undefined || proto !== undefined;
  const insecure = proto === 'http' || (REQUIRE_HTTPS && proxied && proto !== 'https');
  if (insecure) {
    res.status(403).json({
      error: 'https required',
      detail:
        'This gateway is reachable through a proxy that is not terminating TLS. ' +
        'Every request here carries a credential, so plain HTTP is refused.'
    });
    return;
  }
  next();
}

/*
 * Whether to believe `x-forwarded-for` when counting requests.
 *
 * Behind a tunnel every request reports the proxy's own loopback address, so
 * without this the whole internet shares one bucket: the first flood locks out
 * every unauthenticated caller, which is a denial of service performed by the
 * rate limiter. With it, callers are counted by the address the proxy reports.
 *
 * Off by default and deliberately not inferred, because the header is written
 * by the caller when there is no proxy — believing it then would let anyone
 * evade the limit by rotating a string. Set it only when something you trust
 * is in front, which is the same condition under which it is true.
 *
 * It never affects authorisation. `isLoopback` still refuses a proxied request
 * regardless of this flag; this decides which bucket a request is counted in
 * and nothing else.
 */
const TRUSTED_PROXY = process.env['WARDEN_TRUSTED_PROXY'] === '1';

/*
 * A ceiling on how fast anybody can spend this machine.
 *
 * `/api/guard/check` and the OpenAI-shaped proxy each cost a model call, and
 * until now nothing bounded them: one loop from anyone holding a key — or from
 * anyone at all, since a rejected key still costs the round trip — pins the CPU
 * that every real decision is waiting on. On a laptop on a desk that was
 * somebody else's problem. Exposed, it is a one-line denial of service, and the
 * thing denied is the guard.
 *
 * Two windows. The decision limit is what a person cannot reach and a script
 * crosses immediately; the general one bounds everything else on `/api/` so a
 * flood of cheap reads cannot do by volume what the expensive routes cannot do
 * by cost. Both are per caller — per key where there is one, per address where
 * there is not — so one office behind a NAT does not spend everybody's
 * allowance, and one stranger cannot spend a whole company's.
 *
 * Raise them on the gateway if a deployment genuinely needs more. Lowering them
 * is always safe; raising them is a decision about how much of this machine a
 * single caller may take.
 */
const DECISIONS_PER_MINUTE = Number(process.env['WARDEN_RATE_DECISIONS'] ?? 60);
const REQUESTS_PER_MINUTE = Number(process.env['WARDEN_RATE_REQUESTS'] ?? 600);
const decisionLimit = limiter(60_000, DECISIONS_PER_MINUTE);
const generalLimit = limiter(60_000, REQUESTS_PER_MINUTE);
const DECISION_PATHS = new Set(['/api/guard/check', '/v1/chat/completions', '/api/guard/rewrite']);

export function throttle(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'OPTIONS') return next();
  const path = req.path;
  const decides = DECISION_PATHS.has(path);
  if (!decides && !path.startsWith('/api/')) return next();

  const forwarded = TRUSTED_PROXY ? req.header('x-forwarded-for')?.split(',')[0]?.trim() : undefined;
  const who = callerKey(req.header('authorization'), forwarded || req.socket.remoteAddress);
  const limit = decides ? decisionLimit : generalLimit;
  if (limit.take(who)) return next();

  // 429 with `Retry-After`, and no detail about which limit was hit or how
  // much of it is left: a counter that reports its own state is a counter an
  // attacker can tune against.
  res.setHeader('Retry-After', String(limit.retryAfter(who)));
  res.status(429).json({
    error: 'too many requests',
    detail: 'Slow down and try again shortly.'
  });
}

/*
 * Who changed what, and when.
 *
 * The audit chain covered every decision and none of the edits that produced
 * them: somebody could rewrite the policy, issue themselves a key or delete a
 * person and leave nothing behind but the effect. For a gateway on a laptop
 * that was a gap; for one an organisation points at as its control, it is the
 * half of the record a regulator would ask for first.
 *
 * A middleware rather than a call in each handler, for the same reason
 * `requireAdmin` is one: the per-handler version is silent when the route
 * somebody adds next month forgets it.
 *
 * The method and the path, and nothing else. A body here would put a
 * credential (`/api/people/:id/key`) and rule text into a log whose entire
 * promise is that it holds neither — what changed is recoverable from the
 * policy version hash, and who and when is what was missing.
 *
 * Written on the way out, keyed to the status, because an attempt that was
 * refused is as much a part of the record as one that worked.
 */
const AUDITED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function adminAudit(req: Request, res: Response, next: NextFunction): void {
  if (!AUDITED_METHODS.has(req.method) || !needsAdmin(req.path)) return next();

  const actor = actorForCredential(req.header('authorization'));
  res.on('finish', () => {
    // 429 is the rate limiter working, and recording it would let a flood
    // write the log: the throttle bounds the attempts, not the lines they
    // would produce. The refusal itself is still counted where it belongs.
    if (res.statusCode === 429) return;
    try {
      recordAdminAction(
        // Three different callers, and conflating them is how a log lies. A
        // credential names somebody. No credential from the machine itself is
        // the loopback administrator, and `local` is the honest amount this
        // gateway knows about them. No credential from anywhere else is a
        // stranger — labelling that one `local administrator`, which the first
        // version of this did, would have written an intruder into the record
        // as the person they were trying to impersonate.
        actor
          ? { id: actor.id, role: actor.role }
          : isLoopback(req)
            ? { id: 'local', role: 'administrator' }
            : { id: 'unknown', role: 'unauthenticated' },
        `${req.method} ${req.path}`,
        res.statusCode
      );
    } catch (err) {
      // An unwritable chain must not turn a completed change into a 500 the
      // caller retries: the response has already been sent. It is loud in the
      // log instead, and `verify-audit` is what notices a chain that stopped
      // growing.
      console.error(`  audit     could not record ${req.method} ${req.path}: ${String(err)}`);
    }
  });
  next();
}

/**
 * Authorisation, ahead of every route so no route can forget it.
 *
 * Mounted here rather than annotated per handler because the failure mode of
 * the per-handler version is silent: the route someone adds next month is
 * public until they remember. `needsAdmin` decides from the path, and its list
 * is of what stays open, so anything new is closed until it is named.
 *
 * `OPTIONS` is skipped because the browser is asking what it would be allowed
 * to do, not doing it. The real request that follows is still checked, so
 * nothing is granted by answering.
 *
 * See `admin-auth.ts` for what an administrator is and why loopback counts as
 * one. Before this, every policy write, key issue and audit read on this server
 * was reachable by anyone who could open the port.
 */
export function adminGate(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'OPTIONS' || !needsAdmin(req.path)) return next();
  requireAdmin(req, res, next);
}
