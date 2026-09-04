/**
 * The rules: reading them, drafting them with the compiler, previewing a draft
 * against real traffic, and ratifying or removing one.
 *
 * Drafting and ratifying are separate on purpose and stay separate: nothing a
 * model returns from here is policy until an administrator presses Activate.
 */
import { Router } from 'express';
import {
  compilePolicy,
  compileRule,
  isDeclined,
  previewRule,
  ratifyRule,
  removeRule
} from '../../policy/compile.js';
import { loadPolicy, savePolicy } from '../../policy/store.js';
import { resolvedModel } from '../../qvac/client.js';
import { adapter, isMock, remoteCompiler } from '../../qvac/index.js';
import { seedPath } from '../config.js';
import { asyncRoute, readJsonFile } from '../http.js';

export const policyRoutes = Router();

policyRoutes.get('/api/policy', (_req, res) => {
  res.json(loadPolicy());
});

policyRoutes.get('/api/policy/presets', (_req, res) => {
  // Served from the preset catalog once present; empty array until then so
  // the console renders an empty catalog rather than erroring.
  res.json(readJsonFile(seedPath('presets.json'), []));
});

/**
 * Who to credit for a draft.
 *
 * `resolvedModel('compiler')` names the model that *would* answer, which is the
 * wrong answer whenever the mock is the adapter: a draft compiled by the demo
 * stand-in came back to the console labelled "written by QWEN3_1_7B_INST_Q4",
 * with mock text in its examples. A person evaluating Warden with no models
 * downloaded was shown a nonsense rule attributed to a real model — which reads
 * as the model being nonsense, and is the single most expensive thing this
 * console could get wrong about itself.
 *
 * The mock is a test double and it says so here, in the one field whose whole
 * job is provenance.
 */
function draftedBy(remote: string | null): string {
  if (remote) return remote;
  return isMock() ? 'the demo stand-in, not a model' : resolvedModel('compiler');
}

/**
 * Today's limits, multiplied, for the administrator to look at.
 *
 * "Quiero reducir mi uso del mes 50%" is not nonsense and refusing it was the
 * wrong answer: it is a request Warden can satisfy, in the one currency it has
 * for spending. What it is not is a rule, so it produces numbers rather than a
 * prohibition, and the numbers come from here rather than from the model. The
 * model supplies the fraction and nothing else; multiplying seven quotas and
 * rounding them is arithmetic, and a model doing arithmetic on a policy is a
 * mistake nobody would notice until somebody hit a limit that was never agreed.
 *
 * Proposed, not applied. Same boundary as a rule: the administrator presses the
 * button, and until they do the policy is untouched.
 */
function proposedLimits(factor: number | undefined): {
  limits?: { role: string; from: number; to: number }[];
  factor?: number;
} {
  if (typeof factor !== 'number' || !(factor > 0) || !(factor < 1)) return {};
  const limits = loadPolicy()
    .quotas.map((q) => ({
      role: q.role,
      from: q.maxRequestsPerDay,
      // Never below one: a quota of zero is a role that cannot ask anything,
      // which is a suspension and not a reduction, and nobody typing "half"
      // means that.
      to: Math.max(1, Math.round(q.maxRequestsPerDay * factor))
    }))
    .filter((row) => row.to !== row.from);
  return limits.length ? { limits, factor } : {};
}

/** `lockTo` is set when the admin writes a rule from inside one person's page. */
function lockToOf(body: unknown): { lockTo: string[] } | Record<string, never> {
  const raw = (body as { lockTo?: unknown } | undefined)?.lockTo;
  return Array.isArray(raw) ? { lockTo: raw.map(String) } : {};
}

policyRoutes.post('/api/policy/draft', asyncRoute(async (req, res) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  const rule = await compileRule(adapter(), text, loadPolicy(), lockToOf(req.body));
  // The compiler declining is an answer, not a failure. It reaches the console
  // as its own shape so the console can send somebody to the limits editor
  // rather than handing them a prohibition built out of a budget sentence.
  if (isDeclined(rule)) {
    return res.json({ notARule: true, reason: rule.notARuleReason, ...proposedLimits(rule.usageFactor) });
  }
  // Who wrote the draft, so the administrator ratifying it can see whether it
  // came off their own machine. `null` means local, which is the default.
  const remote = remoteCompiler();
  res.json({ ...rule, draftedBy: draftedBy(remote), draftedRemotely: remote !== null });
}));

/**
 * The same compiler, given the sentence an administrator actually says.
 *
 * A separate route rather than a flag on `/api/policy/draft`, because that one
 * is the measured path and every prompt this repo ships has a note saying what
 * moving it cost. This adds a splitting pass in front of the compiler; a
 * specific sentence still yields exactly one rule, but paying for that extra
 * model call on every single-rule compile is a change nobody asked for. So the
 * console offers it as its own button and the old route is untouched.
 */
policyRoutes.post('/api/policy/draft-set', asyncRoute(async (req, res) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  const { statements, rules, declined, declinedFactors } = await compilePolicy(
    adapter(),
    text,
    loadPolicy(),
    lockToOf(req.body)
  );
  // Everything the compiler was given, it declined. Same answer the single-rule
  // route gives, in the same shape, so the console has one case to handle.
  if (rules.length === 0 && declined.length > 0) {
    return res.json({ notARule: true, reason: declined[0] ?? '', ...proposedLimits(declinedFactors[0]) });
  }
  const remote = remoteCompiler();
  res.json({
    statements,
    // Stamped per rule and not once for the set, because the administrator
    // ratifies them one at a time and the card in front of them has to be able
    // to say where that rule came from on its own.
    rules: rules.map((rule) => ({ ...rule, draftedBy: draftedBy(remote), draftedRemotely: remote !== null }))
  });
}));

policyRoutes.post('/api/policy/preview', asyncRoute(async (req, res) => {
  // `against` carries prompts the gateway already ruled on, so a candidate rule
  // can be checked for regressions against real traffic and not only against
  // the examples its own compiler invented. Capped: every case is a full
  // adjudication on the local model.
  const against = Array.isArray(req.body?.against)
    ? req.body.against
        .slice(0, 8)
        .map((c: { prompt?: unknown; expected?: unknown }) => ({
          prompt: String(c?.prompt ?? '').slice(0, 2000),
          expected: c?.expected === 'BLOCK' ? ('BLOCK' as const) : ('ALLOW' as const)
        }))
        .filter((c: { prompt: string }) => c.prompt.length > 0)
    : [];
  res.json(await previewRule(adapter(), req.body?.rule, loadPolicy(), against));
}));

policyRoutes.post('/api/policy/ratify', asyncRoute(async (req, res) => {
  res.json(await ratifyRule(req.body?.rule));
}));

/**
 * Delete every rule, because sometimes you want the slate and not the audit.
 *
 * Quotas stay: they are about spending, not about what anyone may ask, and
 * wiping somebody's daily limits because they wanted to rewrite their policy
 * would be a second thing they did not ask for. There is a confirm in front of
 * this in the console, and it goes through `savePolicy`, so the empty policy is
 * a ratified version like any other and the audit trail keeps the before.
 */
policyRoutes.delete('/api/policy/rules', asyncRoute(async (_req, res) => {
  const policy = loadPolicy();
  const removed = policy.rules.length;
  const saved = savePolicy([], policy.quotas);
  res.json({ removed, version: saved.version });
}));

policyRoutes.delete('/api/policy/rules/:id', asyncRoute(async (req, res) => {
  res.json(await removeRule(String(req.params['id'])));
}));
