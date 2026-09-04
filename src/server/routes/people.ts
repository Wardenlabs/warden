/**
 * The directory and what hangs off it: people, roles, and the limits a role may
 * spend.
 *
 * The directory is what turns "add an employee" into something the guard acts
 * on: it decides the role a caller is judged under, the quota they consume, and
 * whether an `@id` rule binds them.
 */
import { Router } from 'express';
import { onboardingFor, supportedTools } from '../../onboarding/index.js';
import { activityFor, connectedCount } from '../../policy/activity.js';
import { bindsActor, describeAudience } from '../../policy/audience.js';
import {
  addRole,
  findEmployee,
  loadDirectory,
  normaliseRole,
  removeEmployee,
  removeRole,
  roles,
  rotateApiKey,
  upsertEmployee
} from '../../policy/people.js';
import { loadPolicy, rulesForActor, savePolicy } from '../../policy/store.js';
import { quotaSchema } from '../../policy/types.js';
import { asyncRoute, gatewayUrl } from '../http.js';

export const peopleRoutes = Router();

peopleRoutes.get('/api/people', (_req, res) => {
  const dir = loadDirectory();
  const policy = loadPolicy();
  res.json({
    ...dir,
    // Counting here rather than in the browser keeps one definition of "which
    // rules apply to this person" — the same one the guard uses.
    employees: dir.employees.map((e) => {
      // 'any': the admin is being shown what binds this person, which
      // includes the output-side rules no input decision will ever run.
      const applicable = rulesForActor(policy, e, 'any');
      return {
        ...e,
        ruleCount: applicable.length,
        personalRuleCount: applicable.filter((r) => r.appliesTo.includes(`@${e.id}`)).length,
        quota: policy.quotas.find((q) => q.role === e.role)?.maxRequestsPerDay ?? null,
        // What they were told to install is not what they installed. Every hook
        // call names its tool, so this is observed rather than asserted.
        connected: activityFor(e.id)
      };
    })
  });
});

/**
 * The setup for one person, filled in with their id, their key, and the address
 * this gateway is actually reachable at — which is the value most likely to be
 * copied wrong by hand, and the one whose mistakes are silent.
 */
peopleRoutes.get('/api/people/:id/onboarding', (req, res) => {
  const person = findEmployee(String(req.params['id']));
  if (!person) return res.status(404).json({ error: 'no such employee' });
  res.json(onboardingFor(person, gatewayUrl(req)));
});

/** What the gateway knows how to onboard, and which of it anyone has verified. */
peopleRoutes.get('/api/integrations', (_req, res) => {
  res.json({ tools: supportedTools(), connectedPeople: connectedCount() });
});

peopleRoutes.post('/api/people', asyncRoute(async (req, res) => {
  try {
    const employee = upsertEmployee({
      id: req.body?.id ? String(req.body.id) : undefined,
      name: String(req.body?.name ?? ''),
      role: String(req.body?.role ?? '')
    });
    res.json(employee);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
}));

peopleRoutes.post('/api/people/:id/key', asyncRoute(async (req, res) => {
  const rotated = rotateApiKey(String(req.params['id']));
  if (!rotated) return res.status(404).json({ error: 'no such employee' });
  res.json(rotated);
}));

peopleRoutes.delete('/api/people/:id', asyncRoute(async (req, res) => {
  const { removed, orphanedRules } = removeEmployee(String(req.params['id']), loadPolicy().rules);
  if (!removed) return res.status(404).json({ error: 'no such employee' });
  res.json({ removed, orphanedRules });
}));

/** Every rule that binds one person, split by why it binds them. */
peopleRoutes.get('/api/people/:id/rules', (req, res) => {
  const person = findEmployee(String(req.params['id']));
  if (!person) return res.status(404).json({ error: 'no such employee' });
  const policy = loadPolicy();
  const rules = policy.rules.filter((r) => bindsActor(r.appliesTo, person));
  res.json({
    person,
    rules: rules.map((r) => ({
      id: r.id,
      text: r.text,
      severity: r.severity,
      appliesTo: r.appliesTo,
      audience: describeAudience(r.appliesTo, loadDirectory().employees),
      binding: r.appliesTo.includes(`@${person.id}`)
        ? 'personal'
        : r.appliesTo.includes(person.role)
          ? 'role'
          : 'company'
    }))
  });
});

peopleRoutes.post('/api/roles', asyncRoute(async (req, res) => {
  try {
    const { directory, role } = addRole(String(req.body?.role ?? ''));
    // A role with no quota is unmetered. The console always sends one, so the
    // common path leaves no unlimited role behind by accident.
    const perDay = Number(req.body?.maxRequestsPerDay ?? 0);
    if (perDay > 0) {
      const policy = loadPolicy();
      const quotas = policy.quotas
        .filter((q) => q.role !== role)
        .concat({ role, maxRequestsPerDay: Math.floor(perDay) });
      savePolicy(policy.rules, quotas);
    }
    res.json(directory);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
}));

peopleRoutes.delete('/api/roles/:role', asyncRoute(async (req, res) => {
  try {
    const role = String(req.params['role']);
    const dir = removeRole(role);
    const policy = loadPolicy();
    savePolicy(policy.rules, policy.quotas.filter((q) => q.role !== role));
    res.json(dir);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
}));

/**
 * Apply a set of proposed limits, all at once.
 *
 * The compiler proposes and the administrator applies, which is the same
 * boundary a rule crosses at Activate and for the same reason: a model that
 * could change what people may spend without anybody agreeing is a model
 * setting policy. One `savePolicy`, so the whole reduction is one ratified
 * version in the audit trail rather than seven.
 */
peopleRoutes.post('/api/quotas/apply', asyncRoute(async (req, res) => {
  const rows = Array.isArray(req.body?.limits) ? req.body.limits : [];
  const policy = loadPolicy();
  const wanted = new Map<string, number>();
  for (const row of rows) {
    const role = normaliseRole(String((row as { role?: unknown }).role ?? ''));
    const to = Math.floor(Number((row as { to?: unknown }).to));
    if (role && Number.isFinite(to) && to > 0) wanted.set(role, to);
  }
  if (wanted.size === 0) return res.status(400).json({ error: 'no limits to apply' });

  const quotas = policy.quotas.map((q) =>
    wanted.has(q.role) ? { ...q, maxRequestsPerDay: wanted.get(q.role)! } : q
  );
  const saved = savePolicy(policy.rules, quotas);
  res.json({ applied: wanted.size, version: saved.version });
}));

/**
 * Change what a role is allowed to spend.
 *
 * There was no way to do this. A quota could be set once, at the moment the
 * role was created, and after that the console rendered it as a fact — six
 * cards of numbers with no way in. An administrator who typed 20/day for
 * interns and meant 200 had to delete the role, which deletes the people in it.
 *
 * Written as an upsert on the role rather than a patch on the quota, because a
 * role with no quota row is the unmetered case and that has to be reachable
 * from here too: send nothing and the row goes, which is the same sentence as
 * "this role has no limit". Zero and blank both mean that; the schema refuses
 * a zero quota precisely so that "no limit" has exactly one representation.
 *
 * It goes through `savePolicy`, so a limit change re-hashes the policy and
 * lands in the audit trail like any other ratified change. Quotas are inside
 * the policy hash — an admin quietly raising a ceiling is a governance event.
 */
peopleRoutes.put('/api/quotas/:role', asyncRoute(async (req, res) => {
  const role = normaliseRole(String(req.params['role'] ?? ''));
  if (!role) return res.status(400).json({ error: 'role is required' });
  if (!roles().includes(role)) return res.status(404).json({ error: 'no such role' });

  const positive = (v: unknown): number | undefined => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };

  const perDay = positive(req.body?.maxRequestsPerDay);
  const policy = loadPolicy();
  const rest = policy.quotas.filter((q) => q.role !== role);

  // No daily limit means no row at all, and the token ceilings go with it: a
  // quota that meters tokens but not requests is a shape the rest of the guard
  // has never seen, and inventing it here to preserve two numbers would put an
  // untested state into the policy of record.
  if (perDay === undefined) {
    const saved = savePolicy(policy.rules, rest);
    return res.json({ role, quota: null, version: saved.version });
  }

  const quota = {
    role,
    maxRequestsPerDay: perDay,
    ...(positive(req.body?.maxSessionOutputTokens) !== undefined
      ? { maxSessionOutputTokens: positive(req.body?.maxSessionOutputTokens) }
      : {}),
    ...(positive(req.body?.maxContextTokens) !== undefined
      ? { maxContextTokens: positive(req.body?.maxContextTokens) }
      : {})
  };

  const parsed = quotaSchema.safeParse(quota);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid limit' });

  const saved = savePolicy(policy.rules, rest.concat(parsed.data));
  res.json({ role, quota: parsed.data, version: saved.version });
}));
