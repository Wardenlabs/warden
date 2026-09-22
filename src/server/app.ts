/**
 * The Warden server, assembled: the proxy, the admin API, and the live-decision
 * stream, on one port.
 *
 * Every route lives in `routes/`, grouped by what it is for. This file owns the
 * one thing that cannot live anywhere else — the order things run in — and the
 * reasons for that order are written beside the lines that set it.
 */
import { join } from 'node:path';
import express, { type Express, type ErrorRequestHandler } from 'express';
import { ASSETS } from './config.js';
import { adminAudit, adminGate, corsIfConfigured, securityHeaders, throttle } from './middleware.js';
import { auditRoutes } from './routes/audit.js';
import { companyRoutes } from './routes/company.js';
import { guardRoutes } from './routes/guard.js';
import { installRoutes } from './routes/install.js';
import { peopleRoutes } from './routes/people.js';
import { policyRoutes } from './routes/policy.js';
import { proxyRoutes } from './routes/proxy.js';
import { redteamRoutes } from './routes/redteam.js';
import { reviewRoutes } from './routes/review.js';
import { settingsRoutes } from './routes/settings.js';
import { soloRoutes } from './routes/solo.js';
import { systemRoutes } from './routes/system.js';
import { modelRoutes } from './routes/models.js';
import { promptRoutes } from './routes/prompts.js';

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');

  corsIfConfigured(app);
  app.use(securityHeaders);
  app.use(throttle);

  /*
   * The audit of administrative attempts goes BEFORE the authorisation check,
   * which is the opposite of where it started and the correction matters.
   * `requireAdmin` ends the response itself, so nothing downstream of it ever
   * runs for a refusal — and a stranger trying the administrative API and
   * being turned away is the entry an incident is looking for, more than any
   * successful edit. From here the status carries both outcomes.
   */
  app.use(adminAudit);

  /*
   * And the authorisation check goes AFTER the CORS block, not before it.
   * Mounted first, two things broke at once: an administrative 403 carried no
   * `Access-Control-Allow-Origin`, so a browser reported it as an opaque CORS
   * failure rather than as the refusal it is, and the preflight `OPTIONS` was
   * itself authenticated — a preflight carries no `Authorization` header by
   * definition, so with `WARDEN_ADMIN_REQUIRE_KEY=1` the documented
   * separate-dev-port setup could never complete a single request. Order is
   * part of the behaviour of middleware, and this is the order that lets a
   * refusal be read as one.
   */
  app.use(adminGate);

  // File-bearing requests have a separate bounded envelope. Authentication of
  // admin routes happens before parsing large input; model-weight uploads use
  // an octet stream and never become a multi-gigabyte JavaScript string.
  const ordinaryJson = express.json({ limit: '4mb' });
  const documentJson = express.json({ limit: '24mb' });
  app.use((req, res, next) => {
    const acceptsDocuments = req.path === '/api/guard/check' || req.path === '/v1/chat/completions';
    (acceptsDocuments ? documentJson : ordinaryJson)(req, res, next);
  });

  app.use(auditRoutes);
  app.use(policyRoutes);
  app.use(settingsRoutes);
  app.use(modelRoutes);
  app.use(promptRoutes);
  app.use(peopleRoutes);
  app.use(companyRoutes);
  app.use(guardRoutes);
  app.use(reviewRoutes);
  app.use(proxyRoutes);
  app.use(redteamRoutes);
  app.use(installRoutes);
  app.use(soloRoutes);

  // The console, after every API route so a file can never shadow one.
  app.use(express.static(join(ASSETS, 'web')));
  app.use(systemRoutes);

  // Keep unknown paths predictable and avoid Express' default HTML response,
  // which exposes framework-specific behavior to API clients.
  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  // A malformed or oversized request is a refusal, not a gateway outage. In
  // particular the standalone hook must receive JSON it can distinguish from
  // the network failures covered by the installation's availability policy.
  const inputError: ErrorRequestHandler = (err, _req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err?.type === 'entity.too.large' ? 413 : err?.type === 'entity.parse.failed' ? 400 : null;
    if (status === null) return next(err);
    res.status(status).json({
      verdict: 'BLOCK', auditId: 'invalid-request', firedRules: [],
      error: status === 413 ? 'request_too_large' : 'invalid_json',
      explanation: status === 413 ? 'The request exceeds the permitted upload size.' : 'The request is not valid JSON.'
    });
  };
  app.use(inputError);

  // No stack trace or internal exception message crosses the HTTP boundary.
  // Route handlers that intentionally expose actionable errors do so before
  // this final safety net.
  const unexpectedError: ErrorRequestHandler = (err, req, res, next) => {
    if (res.headersSent) return next(err);
    const name = err instanceof Error ? err.name : 'UnknownError';
    console.error(`unexpected route failure: ${req.method} ${req.path} (${name})`);
    res.status(500).json({ error: 'internal server error' });
  };
  app.use(unexpectedError);

  return app;
}
