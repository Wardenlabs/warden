/**
 * The administrator's side of a disputed or held decision: what employees have
 * reported as wrong, and what is waiting for a human answer.
 */
import { Router } from 'express';
import { findDecision } from '../../audit/log.js';
import { readAppeals } from '../../policy/appeals.js';
import { escalationQueue, recordReview, type ReviewOutcome } from '../../policy/escalations.js';
import { findEmployee } from '../../policy/people.js';
import { asyncRoute } from '../http.js';

export const reviewRoutes = Router();

/**
 * What employees have reported as wrong, newest first.
 *
 * Joined back to the rule that fired, because the rule is the object the admin
 * has to go and edit — an appeal that only said "block 3f2a was wrong" would
 * leave them looking it up by hand, and nobody does that twice.
 */
reviewRoutes.get('/api/appeals', (_req, res) => {
  res.json(
    readAppeals()
      /**
       * Notes on held prompts belong to the review queue, not here.
       *
       * Both write the same record — one endpoint, one place employee text is
       * kept — but the employee meant different things by them. On a block it
       * is "this was wrong"; on a held prompt it is context for a decision
       * nobody has made yet. Listing the second under "reported as wrong"
       * misrepresents what they said, to the one person who acts on it.
       */
      .filter((appeal) => findDecision(appeal.auditId)?.decision.verdict !== 'ESCALATE')
      .map((appeal) => {
        const entry = findDecision(appeal.auditId);
        const rule = entry?.decision.firedRules?.[0];
        return {
          ...appeal,
          employeeName: findEmployee(appeal.employeeId)?.name ?? appeal.employeeId,
          verdict: entry?.decision.verdict ?? null,
          ruleId: rule?.ruleId ?? null,
          ruleText: rule?.ruleText ?? null
        };
      })
  );
});

/**
 * What is held for review.
 *
 * These two routes existed as stubs — `[]` and an `ok: true` that recorded
 * nothing — while three different surfaces told employees their prompt was
 * queued for an administrator. They are real now, and they are deliberately
 * thin: the queue is derived from the audit log rather than stored a second
 * time, and this file only joins it to the answers.
 */
reviewRoutes.get('/api/escalations', asyncRoute(async (_req, res) => {
  const queue = await escalationQueue();
  res.json(
    queue.map((e) => ({
      ...e,
      employeeName: findEmployee(e.employeeId)?.name ?? e.employeeId
    }))
  );
}));

reviewRoutes.post('/api/escalations/:id', asyncRoute(async (req, res) => {
  const auditId = String(req.params['id']).trim();
  const outcome = req.body?.outcome;
  if (outcome !== 'approved' && outcome !== 'refused') {
    return res.status(400).json({ error: 'outcome must be "approved" or "refused"' });
  }

  // Only something actually held can be answered. Recording a review against an
  // id that was never escalated would put a decision in the queue that the
  // audit log has no matching entry for.
  const queue = await escalationQueue();
  if (!queue.some((e) => e.auditId === auditId)) {
    return res.status(404).json({ error: 'no decision is held for review under that audit id' });
  }

  const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
  const review = recordReview({ auditId, outcome: outcome as ReviewOutcome, ...(note ? { note } : {}) });
  if (!review) return res.status(409).json({ error: 'that escalation has already been answered' });

  res.json(review);
}));
