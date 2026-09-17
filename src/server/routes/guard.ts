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
import { z } from 'zod';
import { DocumentInputError, documentCapabilities, withoutDocumentText } from '../../documents/index.js';
import { findDecision } from '../../audit/log.js';
import { checkQuota } from '../../guard/quota.js';
import { rewriteGate, suggestRewrite } from '../../guard/rewrite.js';
import { recordActivity } from '../../policy/activity.js';
import { recordAppeal } from '../../policy/appeals.js';
import { recordMachineSeen, recordWiringReport, toolReportSchema } from '../../policy/devices.js';
import { actorForCredential, activePause } from '../../policy/people.js';
import { loadPolicy } from '../../policy/store.js';
import { recordVerified } from '../../policy/verification.js';
import { adapter } from '../../qvac/index.js';
import { hookDecisionDeadlineMs } from '../config.js';
import { emitDecision } from '../events.js';
import { asyncRoute } from '../http.js';
import { evaluateRequest, extractPrompt, resolveActor, unknownKey } from '../identity.js';

export const guardRoutes = Router();

guardRoutes.get('/api/documents/capabilities', (_req, res) => { res.json(documentCapabilities()); });

/**
 * "Does this gateway know me?" — the smallest oracle that answers it.
 *
 * Until this existed the only way to find out was to submit a prompt and read
 * the refusal, which is a strange thing to have to do to check a credential,
 * and useless in a script. It judges nothing, writes nothing, and says nothing
 * the owner of the key does not already know about themselves: their own id,
 * their own name, and the role their administrator gave them.
 *
 * Deliberately not here: whether the role is exempt, and anything about anyone
 * else. Exemption is a property of the policy, `exemptRoles` is the most
 * security-relevant sentence in the spec, and an employee-callable route that
 * reports on it turns a credential check into a probe of the policy's shape.
 *
 * `paused` is always false today. The pause axis is F4 of
 * `docs/specs/wiring-and-unwiring.md`; the field is here now so that the hook
 * released with F2 already reads the shape F4 will fill, rather than needing a
 * second rollout to every laptop to learn about a feature the gateway grew.
 */
guardRoutes.get('/api/identity', (req, res) => {
  const employee = actorForCredential(req.header('authorization'));
  if (!employee) return res.status(401).json(unknownKey(req));
  // Real since F4. The hook shows it in --status, so somebody wondering why
  // nothing is being checked reads the answer instead of guessing at it.
  const paused = activePause(employee);
  res.json({
    id: employee.id,
    name: employee.name,
    role: employee.role,
    paused: paused !== null,
    ...(paused ? { pausedUntil: paused.until } : {})
  });
});

/**
 * Everything an employee's machine sends about itself, cleaned before it is
 * believed.
 *
 * It arrives from a laptop, so it is read the way every other client claim is:
 * shapes checked, lengths bounded, anything unrecognised dropped. The id is
 * required to look like the salted hash the hook makes — 16 hex characters —
 * because it is a map key that an administrator will see grouped under a
 * person's name, and a machine that can choose an arbitrary one can make that
 * list unreadable.
 *
 * `name` is `os.hostname()` and is personal data. Control and format
 * characters come out for the same reason they come out of an employee's name
 * in `people.ts`: it is interpolated into a console the administrator reads,
 * and nothing legitimate is lost by removing them.
 */
function readMachine(value: unknown): { id: string; name: string } | null {
  const raw = value as { id?: unknown; name?: unknown } | undefined;
  const id = typeof raw?.id === 'string' ? raw.id.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{16}$/.test(id)) return null;
  const name = typeof raw?.name === 'string' ? raw.name.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 200) : '';
  return { id, name };
}

/**
 * What this machine found when it looked at its own configuration.
 *
 * The gateway cannot read an employee's home directory, so wiring is the one
 * fact here it can never check for itself. It does not infer it either: a
 * machine that has not reported leaves wiring unknown, which is a different
 * sentence in the console from "not wired", and getting those two confused
 * costs somebody an afternoon fixing what was never broken.
 *
 * Called after `--fix`, after `--unfix`, and piggybacked on an ordinary check
 * at most once an hour — never as a heartbeat. A background process that phones
 * home on its own schedule is a different product from a hook that runs when
 * somebody presses Enter.
 */
guardRoutes.post('/api/devices/report', (req, res) => {
  const actor = resolveActor(req);
  if (!actor) return res.status(401).json(unknownKey(req));

  const machine = readMachine(req.body?.machine);
  if (!machine) return res.status(400).json({ error: 'machine.id must be 16 hex characters' });

  const parsed = z.array(toolReportSchema).max(32).safeParse(req.body?.tools);
  if (!parsed.success) return res.status(400).json({ error: 'tools must be a list of { id, wired }' });

  const hookVersion = typeof req.body?.hookVersion === 'string' ? req.body.hookVersion.slice(0, 64) : undefined;
  recordWiringReport(actor.id, machine, parsed.data, hookVersion);
  res.json({ ok: true });
});

guardRoutes.post('/api/guard/check', asyncRoute(async (req, res) => {
  const actor = resolveActor(req);
  if (!actor) return res.status(401).json(unknownKey(req));

  const controller = new AbortController();
  const abort = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', abort);
  let decision;
  try { decision = await evaluateRequest(req, actor, controller.signal); }
  catch (error) {
    if (error instanceof DocumentInputError) return res.status(error.status).json({ error: error.message, code: 'invalid_attachment' });
    throw error;
  } finally { res.off('close', abort); }
  // The hook names the tool it came from; that sighting is what the console's
  // "connected" badges are built from. `actor.id` comes from the key the
  // gateway issued, so it is an employee by construction — the id no longer
  // arrives on a header that could inflate the count with strangers.
  recordActivity(actor.id, typeof req.body?.source === 'string' ? req.body.source : undefined);
  // The same sighting, kept per machine and across restarts. It answers the two
  // questions the in-memory view cannot — whether this machine ever connected,
  // and how long it has been quiet — and it is the only thing that clears a
  // rotation's "pending" mark, because a check arriving under the current key
  // is the proof that this machine picked the new one up. Traffic only: what is
  // wired is reported separately and never inferred from a request.
  const machine = readMachine(req.body?.machine);
  if (machine) recordMachineSeen(actor.id, machine);
  // The durable half of the same sighting, and a much narrower claim than the
  // two above: not "this tool spoke to us" but "this tool's request was
  // decided by a rule". `recordVerified` refuses everything short of that —
  // see its header for the three conditions and why each one is there. This is
  // the only thing the first-run flow will accept as proof.
  const source = typeof req.body?.source === 'string' ? req.body.source : undefined;
  recordVerified(actor.id, {
    tool: source,
    auditId: decision.auditId,
    verdict: decision.verdict,
    ruleIds: decision.firedRules.map((rule) => rule.ruleId),
    policyVersion: decision.policyVersion
  });
  // A decision slower than the hook's own deadline arrived after the hook had
  // already released the prompt. The verdict stands and is recorded; what is
  // no longer true is that the prompt it describes was checked before it went
  // out. The gateway cannot see a client-side timeout, but it can see this,
  // and it is the same event from the other end.
  emitDecision(decision, { source, late: decision.totalMs > hookDecisionDeadlineMs() });
  res.json(withoutDocumentText(decision));
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
  if (!actor) return res.status(401).json(unknownKey(req));

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
  if (!actor) return res.status(401).json(unknownKey(req));

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
