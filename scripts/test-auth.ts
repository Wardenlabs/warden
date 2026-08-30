/**
 * Does the administrative check agree with the router it guards?
 *
 * `needsAdmin` decides from a path string, and Express decides from the same
 * string under its own normalisation rules. When the two disagree, the
 * disagreement is a bypass — and this one shipped: Express matches routes
 * case-insensitively unless told otherwise, so `GET /API/audit` reached the
 * handler registered for `/api/audit` while a case-sensitive `startsWith`
 * decided the path was not administrative. Measured against a running server:
 * `/api/audit` refused with 403, `/API/audit` answered 200 with the audit log.
 *
 * The check is a pure function, so this needs no server, no models and no
 * network, and it runs in milliseconds. Every case below is a way of writing a
 * path that Express will route somewhere administrative.
 *
 *   pnpm run test:auth
 */
import { needsAdmin } from '../src/server/admin-auth.js';

type Case = { path: string; admin: boolean; why: string };

/** A real install token: 32 lowercase hex characters. */
const TOKEN = 'a'.repeat(32);

const CASES: Case[] = [
  // The ordinary shapes.
  { path: '/api/audit', admin: true, why: 'the governance record' },
  { path: '/api/policy', admin: true, why: 'the rules themselves' },
  { path: '/api/events', admin: true, why: 'decisions streaming live' },
  { path: '/api/people/fede/key', admin: true, why: 'mints a credential' },
  { path: '/api/policy/rules/r-payroll', admin: true, why: 'deletes a rule' },

  // Case folding. Express routes these to the handlers above.
  { path: '/API/audit', admin: true, why: 'upper-case prefix still routes' },
  { path: '/api/AUDIT', admin: true, why: 'upper-case tail still routes' },
  { path: '/Api/Audit', admin: true, why: 'mixed case still routes' },
  { path: '/API/POLICY/RULES/R-PAYROLL', admin: true, why: 'all of it' },

  // Trailing slashes. Express is non-strict by default, so these route too.
  { path: '/api/audit/', admin: true, why: 'trailing slash still routes' },
  { path: '/API/AUDIT/', admin: true, why: 'both at once' },

  // The employee surface, which must stay reachable without an administrator.
  { path: '/api/guard/check', admin: false, why: 'the hook calls this' },
  { path: '/api/guard/rewrite', admin: false, why: 'the employee asks for this' },
  { path: '/api/guard/appeal', admin: false, why: 'the employee disputes with this' },
  { path: '/api/guard/check/', admin: false, why: 'same endpoint, trailing slash' },
  { path: '/API/GUARD/CHECK', admin: false, why: 'same endpoint, upper case' },

  // Anything under /api that is not on the employee list is administrative,
  // including a route nobody has written yet. That is the direction that keeps
  // this check from rotting.
  { path: '/api/some/route/added/next/month', admin: true, why: 'closed by default' },
  { path: '/api/guard/check/extra', admin: true, why: 'not the employee endpoint' },
  { path: '/api/guardcheck', admin: true, why: 'near-miss is not a match' },

  // Onboarding. The token form is the capability and is public; the employee-id
  // form hands out a key to whoever guesses a first name.
  { path: `/install/${TOKEN}`, admin: false, why: 'the token is the secret' },
  { path: '/install/fede', admin: true, why: 'ids are guessable' },
  { path: '/install/ana', admin: true, why: 'ids are guessable' },
  { path: '/install', admin: true, why: 'no credential at all' },
  { path: `/install/${TOKEN}x`, admin: true, why: 'wrong length is not a token' },
  { path: `/install/${'g'.repeat(32)}`, admin: true, why: 'not hex is not a token' },
  { path: `/install/${'A'.repeat(32)}`, admin: true, why: 'upper case is not a token this route mints' },

  // Public by design.
  { path: '/health', admin: false, why: 'liveness' },
  { path: '/', admin: false, why: 'the console itself' },
  { path: '/warden-hook.mjs', admin: false, why: 'employees download it' },
  { path: '/v1/chat/completions', admin: false, why: 'employee key checked in the route' }
];

let failed = 0;
for (const { path, admin, why } of CASES) {
  const got = needsAdmin(path);
  const ok = got === admin;
  if (!ok) failed++;
  const verdict = ok ? '  ok  ' : ' FAIL ';
  const expected = admin ? 'admin' : 'open ';
  console.log(`${verdict} ${expected}  ${path.padEnd(38)} ${why}`);
}

console.log(
  `\n${CASES.length - failed}/${CASES.length} paths classified as intended` +
    (failed > 0 ? `\n${failed} FAILED — an administrative route is reachable without one` : '')
);
// A non-zero exit so this can gate a release rather than be read.
process.exitCode = failed > 0 ? 1 : 0;

/**
 * Upper-case install tokens are deliberately administrative rather than public.
 *
 * `installToken` emits lower-case hex, so an upper-case one was never minted
 * here and `findByInstallToken` would refuse it anyway. Classifying it as
 * administrative rather than public keeps the two agreeing in the safe
 * direction: the worst case is an administrator being asked for their key.
 */
