/**
 * The record: decisions as they happen, decisions as they were stored, and the
 * administrative edits that changed what they were judged against.
 */
import { Router } from 'express';
import { readAdminActions, readAudit, verifyChain } from '../../audit/log.js';
import { openEventStream, withRememberedPrompts } from '../events.js';
import { asyncRoute } from '../http.js';

export const auditRoutes = Router();

auditRoutes.get('/api/events', openEventStream);

auditRoutes.get('/api/audit', asyncRoute(async (req, res) => {
  // `slice(-NaN)` is `slice(0)`, so an unparseable limit would dump the whole
  // chain. Clamp instead.
  const raw = Number(req.query['limit'] ?? 50);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 1), 500) : 50;
  res.json(withRememberedPrompts(await readAudit(limit)));
}));

// The chain is the product's whole evidence claim, and evidence nobody can see
// is not evidence. `pnpm run verify-audit` recomputes it from the terminal; this
// is the same check, so the console can show it too.
auditRoutes.get('/api/audit/verify', asyncRoute(async (_req, res) => {
  res.json(verifyChain());
}));

auditRoutes.get('/api/audit/admin', asyncRoute(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query['limit'] ?? 50), 1), 500);
  res.json(await readAdminActions(limit));
}));
