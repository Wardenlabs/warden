/**
 * What an employee's tools call: the check itself, and the two ways to follow
 * up on a refusal.
 *
 * Everything after the check runs *after* a decision exists, never during one.
 * A verdict is still decided by `aggregate()` in ordinary code from the
 * ratified rule, and nothing here can change one that has already been made.
 */
import { createHash } from 'node:crypto';
import { Router } from 'express';
import { findDecision } from '../../audit/log.js';
import { checkQuota } from '../../guard/quota.js';
import { rewriteGate, suggestRewrite } from '../../guard/rewrite.js';
import { recordActivity } from '../../policy/activity.js';
import { recordAppeal } from '../../policy/appeals.js';
import { loadPolicy } from '../../policy/store.js';
import { adapter } from '../../qvac/index.js';
import { emitDecision } from '../events.js';
import { asyncRoute } from '../http.js';
import { evaluateRequest, extractPrompt, resolveActor, UNKNOWN_KEY } from '../identity.js';

export const guardRoutes = Router();

guardRoutes.post('/api/guard/check', asyncRoute(async (req, res) => {
  const actor = resolveActor(req);
  if (!actor) return res.status(401).json(UNKNOWN_KEY);

  const decision = await evaluateRequest(req, actor);
  // The hook names the tool it came from; that sighting is what the console's
  // "connected" badges are built from. `actor.id` comes from the key the
  // gateway issued, so it is an employee by construction — the id no longer
  // arrives on a header that could inflate the count with strangers.
  recordActivity(actor.id, typeof req.body?.source === 'string' ? req.body.source : undefined);
  emitDecision(decision);
  res.json(decision);
}));

/**
 * Decisions that have already been rewritten once.
 *
 * The single most important limit on this endpoint. A rewrite you can ask for
 * repeatedly is a search for a phrasing that passes, run on the attacker's
 * behalf and paid for by us; one per block is a suggestion.
 *
 * In memory, resetting with the process, like the quota counters and the
 * activity sightings. Honest about what it is: a restart returns one rewrite
 * per past block, which is a real hole and a small one next to a durable store
 * this gateway does not otherwise need. The audit log is the record.
 */
const rewritten = new Set<string>();

/**
 * Propose a version of a blocked prompt that would go through.
 *
 * The employee asks for this; it is never offered on the decision path, and a
 * refusal that nobody follows up on costs exactly what it costs today.
 *
 * The prompt has to be sent again rather than read back from the log, and that
 * is the point: the log stores its SHA-256 and not its text, so matching the
 * two proves this is the request that was actually blocked without the
 * governance record ever having held what anybody typed.
 */
guardRoutes.post('/api/guard/rewrite', asyncRoute(async (req, res) => {
  const actor = resolveActor(req);
  if (!actor) return res.status(401).json(UNKNOWN_KEY);

  const auditId = typeof req.body?.auditId === 'string' ? req.body.auditId.trim() : '';
  const prompt = extractPrompt(req.body);
  if (!auditId || !prompt) {
    return res.status(400).json({ error: 'auditId and prompt are both required' });
  }

  const entry = findDecision(auditId);
  // One body for "no such decision" and "not yours", deliberately. Which of the
  // two it is, is not something a caller gets to probe for.
  if (!entry || entry.actor.id !== actor.id) {
    return res.status(403).json({ error: 'that decision is not yours to rewrite' });
  }
  if (createHash('sha256').update(prompt).digest('hex') !== entry.promptHash) {
    return res.status(400).json({ error: 'that is not the prompt this decision was made about' });
  }
  if (entry.decision.verdict === 'ALLOW') {
    return res.status(400).json({ error: 'that prompt was allowed — there is nothing to rewrite' });
  }
  const policy = loadPolicy();

  // Asked and answered for free. A refusal decided here ran nothing, so it
  // charges nothing and spends nothing — the answer is deterministic and asking
  // again returns it again.
  const gated = rewriteGate({ prompt, decision: entry.decision, policy });
  if (gated) return res.json({ suggestion: null, reason: gated });

  if (rewritten.has(auditId)) {
    return res.status(409).json({
      error: 'this block has already been rewritten once',
      suggestion: null,
      reason: 'already-rewritten'
    });
  }

  // Writing a rewrite is a model call this person caused, so it is charged like
  // one. The re-check inside `suggestRewrite` charges its own: a rewrite costs
  // two units because it is two passes of the model.
  const quota = checkQuota(policy, actor);
  if (!quota.allowed) {
    return res.status(429).json({
      error: `daily limit reached for role "${actor.role}" (${quota.used}/${quota.limit})`,
      suggestion: null,
      reason: 'quota'
    });
  }

  // Burned before the call, not after: a rewrite that is only spent on success
  // is a rewrite you can retry until it succeeds. The one exception is below.
  rewritten.add(auditId);

  const result = await suggestRewrite(adapter(), {
    actor,
    prompt,
    decision: entry.decision,
    policy,
    onRecheck: emitDecision
  });

  // A generation that never produced text leaked nothing, so it does not cost
  // the attempt. Everything else did produce one, and that is where the
  // information an attacker would iterate on lives.
  if (result.reason === 'model-unavailable') rewritten.delete(auditId);

  res.json(result);
}));

/**
 * "This block was wrong."
 *
 * The other half of the same problem. A refusal already tells people to quote
 * their audit id if they disagree, and until now there was nowhere to quote it.
 * No model runs and no quota is charged: this is a person disagreeing, which
 * costs nothing and is worth more than most of what does.
 */
guardRoutes.post('/api/guard/appeal', asyncRoute(async (req, res) => {
  const actor = resolveActor(req);
  if (!actor) return res.status(401).json(UNKNOWN_KEY);

  const auditId = typeof req.body?.auditId === 'string' ? req.body.auditId.trim() : '';
  const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
  if (!auditId) return res.status(400).json({ error: 'auditId is required' });

  const entry = findDecision(auditId);
  if (!entry || entry.actor.id !== actor.id) {
    return res.status(403).json({ error: 'that decision is not yours to appeal' });
  }

  const appeal = recordAppeal({ auditId, employeeId: actor.id, ...(note ? { note } : {}) });
  if (!appeal) return res.status(409).json({ error: 'you have already reported this decision' });
  res.json(appeal);
}));
