/**
 * Who may reach the administrative surface.
 *
 * Until this existed, nothing could. Every route that writes policy, mints
 * credentials or reads the governance record was open to anyone who could
 * reach the port, and `WARDEN_HOST` defaults to `0.0.0.0` so that teammates
 * can reach the gateway. The comment above the CORS block said it plainly —
 * "the admin API has no authentication, so the browser's origin check was the
 * only thing standing in the way" — which is a statement about cross-origin
 * pages and not about the employee who simply types the URL.
 *
 * That is a hole straight through the product's central claim. Warden exists so
 * an employee cannot route around the policy. An employee who can reach the
 * console's port could:
 *
 *   DELETE /api/policy/rules/r-payroll     delete the rule judging them
 *   POST   /api/policy/ratify              install a rule of their own
 *   POST   /api/roles                      create a role, then be exempt
 *   POST   /api/people/:id/key             rotate anyone's key and read it back
 *   GET    /install/:employeeId            read anyone's key without rotating
 *   GET    /api/audit                      read every prompt hash and verdict
 *   GET    /api/events                     watch decisions stream by, live
 *
 * The guard could be flawless and none of it would matter.
 *
 * ## What counts as an administrator
 *
 * Two answers, and the second is the one that does the work.
 *
 * **A key belonging to an exempt role.** `exemptRoles` already lives inside the
 * ratified policy, inside the version hash, because — as `types.ts` puts it —
 * "who is exempt" is the most security-relevant sentence in the spec. The
 * people it names are the ones who author the rules rather than live under
 * them, which is the same set that may edit them. Reusing it means there is no
 * second, unaudited notion of "admin" to keep in sync.
 *
 * **The loopback interface.** A request from the machine the gateway runs on is
 * treated as the administrator, because on that machine the API is not the
 * weakest way in: anyone with a shell there can edit `data/policies.json`
 * directly and skip every check in this file. Refusing them at the HTTP layer
 * would buy nothing and would break the console, which is served by this same
 * process and holds no credential.
 *
 * That trust is exactly as strong as the deployment. Where the gateway runs on
 * a machine the employee controls, they were already the administrator of their
 * own policy file and no HTTP check changes that. Where it runs on a shared
 * host that employees can log into, loopback stops meaning "the admin" — set
 * `WARDEN_ADMIN_REQUIRE_KEY=1` and every administrative call must present an
 * exempt key, from anywhere.
 */
import type { NextFunction, Request, Response } from 'express';
import { actorForCredential } from '../policy/people.js';
import { isExempt, loadPolicy } from '../policy/store.js';

/** The shape `installToken` produces: 128 bits, hex. */
const INSTALL_TOKEN = /^[0-9a-f]{32}$/;

/**
 * Routes an employee is supposed to call.
 *
 * The list is of what stays open rather than of what is closed, so a route
 * added later is protected by default. Getting that the wrong way round is how
 * this kind of check rots: every new endpoint would be public until somebody
 * remembered to name it.
 */
const EMPLOYEE_PATHS: ReadonlySet<string> = new Set([
  '/api/guard/check',
  '/api/guard/rewrite',
  '/api/guard/appeal'
]);

/**
 * The path as Express will route it, not as it was typed.
 *
 * **This function is the whole check.** Express matches routes
 * case-insensitively and non-strictly unless told otherwise, and this server
 * does not tell it otherwise. So `GET /API/audit` reaches the handler
 * registered for `/api/audit` — and a case-sensitive `startsWith('/api/')` here
 * returned false for it, decided the path was not administrative, and waved it
 * through. Measured against a running server before this existed:
 * `/api/audit` refused with 403 and `/API/audit` answered 200 with the log.
 *
 * A guard that normalises differently from the router it guards is not a guard.
 * Anything added here has to be checked against what Express actually matches,
 * which is why the two normalisations applied below are the two Express
 * applies: case-folding, and a tolerated trailing slash. Where a route resolves
 * something case-sensitively of its own — the install token does — the check
 * for it reads the unfolded path, so that it agrees with that route too.
 */
function withoutTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/** Does this path require an administrator? */
export function needsAdmin(rawPath: string): boolean {
  const raw = withoutTrailingSlash(rawPath);
  const path = raw.toLowerCase();

  // Hands out an employee's API key in a shell script, so the URL is itself a
  // credential. It cannot simply be closed: the employee runs it from their own
  // machine before they have a key, which is what it is for. So the address
  // carries the secret — an install token, unguessable and derived from the key
  // it delivers — and that form is public. Addressed by employee id, where the
  // id is somebody's first name, it stays administrative.
  //
  // Matched against the path as sent rather than the folded one, which is the
  // opposite of the rule below it and for the same reason: agreement with what
  // resolves the request. `installToken` mints lower-case hex and
  // `findByInstallToken` accepts nothing else, so folding here would classify a
  // token this server could never have issued as public and then hand it to a
  // route that refuses it. Both answers are safe; only one of them is the same
  // answer.
  if (path.startsWith('/install/')) return !INSTALL_TOKEN.test(raw.slice('/install/'.length));
  if (path === '/install') return true;
  if (!path.startsWith('/api/') && path !== '/api') return false;
  return !EMPLOYEE_PATHS.has(path);
}

/** Loopback trust, unless the deployment has switched it off. */
const REQUIRE_KEY = process.env['WARDEN_ADMIN_REQUIRE_KEY'] === '1';

/**
 * Is this request from the machine the gateway runs on?
 *
 * Read from the socket, never from a header. `X-Forwarded-For` is written by
 * whoever is in front of the server — including, behind no proxy at all, the
 * caller — so trusting it here would turn loopback recognition into a header
 * an attacker sets. Express only populates `req.ips` when `trust proxy` is
 * enabled, and this server deliberately does not enable it.
 *
 * IPv6-mapped IPv4 (`::ffff:127.0.0.1`) is what a dual-stack listener actually
 * reports for a v4 loopback connection, so it has to be matched too — and the
 * whole 127/8 block, since `127.0.0.2` is just as local as `127.0.0.1`.
 */
export function isLoopback(req: Request): boolean {
  const address = req.socket.remoteAddress;
  if (!address) return false;
  const bare = address.startsWith('::ffff:') ? address.slice(7) : address;
  return bare === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/** Does this request carry a key belonging to a role the policy exempts? */
export function hasAdminKey(req: Request): boolean {
  const employee = actorForCredential(req.header('authorization'));
  if (!employee) return false;
  try {
    return isExempt(loadPolicy(), employee.role);
  } catch {
    // A policy that will not load is not a policy that exempts anybody. This is
    // the one place where failing closed costs the administrator their own
    // console, which is the correct direction: a gateway that cannot read its
    // own rules should not be taking instructions about them.
    return false;
  }
}

/**
 * Refuse anyone who is neither.
 *
 * 403 rather than 401: there is no challenge to issue and no login flow to
 * point at, and a `WWW-Authenticate` header would invite a browser password
 * box that nothing here would ever accept. The body names the two ways in,
 * because the person hitting this is usually the administrator on the wrong
 * interface rather than an attacker.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if ((!REQUIRE_KEY && isLoopback(req)) || hasAdminKey(req)) return next();

  // The onboarding route's whole output is piped into `sh`. A JSON body sent
  // there is a syntax error arriving inside a shell, which reads to the
  // employee as their machine breaking rather than as a link they should not
  // have. The route already answers an unknown employee this way; a refusal
  // deserves the same shape.
  if (req.path.toLowerCase().startsWith('/install')) {
    return void res
      .status(403)
      .type('text/plain')
      .send(
        [
          '# This install link is not the one to use. Ask your admin for the link',
          '# shown in the console, which carries a token rather than your name.',
          'exit 1',
          ''
        ].join('\n')
      );
  }

  res.status(403).json({
    error: 'administrative endpoint',
    detail:
      'Reach it from the machine running the gateway, or send the API key of a ' +
      'person whose role the policy exempts as `Authorization: Bearer <key>`.'
  });
}
