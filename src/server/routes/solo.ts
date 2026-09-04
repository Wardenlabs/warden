/**
 * Warden Solo: a second, minimal surface over the same directory and the same
 * policy the other routes already use — see docs/specs/solo-mode.md. No
 * separate store, no separate guard path: "Mis reglas" is a filtered view of
 * the same rules, scoped by `appliesTo` rather than kept in a file of their own
 * (spec §2). Administrative by default, like every route not in `EMPLOYEE_PATHS`.
 */
import { execFile } from 'node:child_process';
import { Router } from 'express';
import { readAudit } from '../../audit/log.js';
import { evaluate } from '../../guard/pipeline.js';
import { compileRule, isDeclined, ratifyRule, removeRule } from '../../policy/compile.js';
import { addRole, loadDirectory, upsertEmployee, type Employee } from '../../policy/people.js';
import { isExempt, loadPolicy, rulesForActor } from '../../policy/store.js';
import type { Rule } from '../../policy/types.js';
import { adapter } from '../../qvac/index.js';
import { PORT, seedPath } from '../config.js';
import { asyncRoute, readJsonFile } from '../http.js';
import { buildInstallScript } from './install.js';

export const soloRoutes = Router();

/**
 * What "Stop these automatically" offers: the same catalogue the team console
 * draws its presets from, `data/seed/presets.json`, grouped by category.
 *
 * It used to be four hand-written files of its own under `solo-presets/`, in
 * Spanish under an English interface, and adding a fifth meant a file and a
 * code change. One catalogue, one language, one place to edit: a preset's id is
 * its category and position, so a rule ratified from it can be recognised as
 * "on" later, and the two surfaces cannot drift apart.
 */
type CatalogueRule = Omit<Rule, 'id' | 'embedding'>;
type Catalogue = { category: string; label?: string; rules: CatalogueRule[] }[];

function catalogue(): { id: string; category: string; label: string; rule: CatalogueRule }[] {
  const cats = readJsonFile<Catalogue>(seedPath('presets.json'), []);
  return cats.flatMap((cat) =>
    (cat.rules ?? []).map((rule, i) => ({
      id: `solo-${cat.category}-${i + 1}`,
      category: cat.category,
      label: cat.label ?? cat.category,
      rule
    }))
  );
}

/**
 * Who "Mis reglas" belongs to on this machine, resolved without a login.
 *
 * There is no session here, on purpose — the console is loopback-trusted and
 * has never needed to know which human is at the keyboard, and this does not
 * start needing one. So it asks a narrower question instead: is there already
 * exactly one exempt person in the directory — an admin who also wants
 * personal rules, coexistence, spec §3 Caso A — or is there nobody exempt yet,
 * a fresh solo install, Caso B? More than one exempt person is a real gap this
 * does not resolve; it picks the first, deterministically, rather than refuse
 * the whole feature over an edge case nothing here creates on its own.
 */
function resolveSoloIdentity(): Employee {
  const dir = loadDirectory();
  const policy = loadPolicy();
  const exempt = dir.employees
    .filter((e) => isExempt(policy, e.role))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (exempt.length > 0) return exempt[0]!;

  const existing = dir.employees.find((e) => e.role === 'solo');
  if (existing) return existing;

  addRole('solo');
  return upsertEmployee({ name: 'You', role: 'solo' });
}

soloRoutes.post('/api/solo/setup', (_req, res) => {
  res.json(resolveSoloIdentity());
});

soloRoutes.get('/api/solo/presets', (_req, res) => {
  const identity = resolveSoloIdentity();
  const active = new Set(
    loadPolicy()
      .rules.filter((r) => r.appliesTo.includes(`@${identity.id}`))
      .map((r) => r.id)
  );
  const presets = catalogue().map(({ id, category, label, rule }) => ({
    id,
    category,
    label,
    text: rule.text,
    severity: rule.severity,
    active: active.has(id)
  }));
  // Grouped for the screen and flat for anything older that reads `presets`.
  const groups = [...new Map(presets.map((p) => [p.category, p.label])).entries()].map(([category, label]) => ({
    category,
    label,
    presets: presets.filter((p) => p.category === category)
  }));
  res.json({ identity, presets, groups });
});

soloRoutes.post('/api/solo/presets/:id/toggle', asyncRoute(async (req, res) => {
  const presetId = String(req.params['id']);
  const entry = catalogue().find((p) => p.id === presetId);
  if (!entry) return res.status(404).json({ error: 'no such preset' });

  const wantActive = Boolean(req.body?.active);
  if (!wantActive) return res.json(await removeRule(presetId));

  const identity = resolveSoloIdentity();
  // The catalogue's own audience is replaced: on this screen a rule binds the
  // person at the keyboard and nobody else, which is the whole point of it.
  res.json(await ratifyRule({ ...entry.rule, id: presetId, appliesTo: [`@${identity.id}`] } as Rule));
}));

soloRoutes.get('/api/solo/rules', asyncRoute(async (_req, res) => {
  const identity = resolveSoloIdentity();
  const rules = rulesForActor(loadPolicy(), { id: identity.id, role: identity.role }, 'any');

  // "Qué bloqueó y cuándo" (PRD §3.5) — the audit chain already has this per
  // actor, so this reads it rather than keeping a second history nobody else
  // needs. Never the prompt itself: the chain stores a hash, not the text
  // (CLAUDE.md — "the governance record" — this is that record, read, not a
  // new one), so `recentBlocks` says which rule fired and when, not what was
  // sent. Capped small: this is a glance, not the audit view.
  //
  // `readAudit` already returns newest-first (`chain()` reverses the file),
  // so the first 10 matches are the 10 most recent — not the last 10, which
  // would be the oldest matches inside the 200-entry window.
  const recent = await readAudit(200);
  const recentBlocks = recent
    .filter((e) => e.actor.id === identity.id && e.decision.verdict !== 'ALLOW')
    .slice(0, 10)
    .map((e) => ({ ts: e.ts, verdict: e.decision.verdict, firedRules: e.decision.firedRules }));

  res.json({ identity, rules, recentBlocks });
}));

soloRoutes.post('/api/solo/rules', asyncRoute(async (req, res) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  const identity = resolveSoloIdentity();
  const rule = await compileRule(adapter(), text, loadPolicy(), { lockTo: [`@${identity.id}`] });
  if (isDeclined(rule)) return res.json({ notARule: true, reason: rule.notARuleReason });
  res.json(await ratifyRule(rule));
}));

soloRoutes.post('/api/solo/protect', asyncRoute(async (_req, res) => {
  const identity = resolveSoloIdentity();
  // Always `localhost`, never `gatewayUrl(req)` — that prefers a LAN address
  // so a link shown to a teammate resolves off-machine, which is exactly the
  // exposure Warden Solo does not have (PRD §2: nothing leaves 127.0.0.1).
  // This script also runs from this same process rather than a browser, so
  // there is no `Host` header to read it from in the first place.
  const script = buildInstallScript(identity, `http://localhost:${PORT}`);
  await new Promise<void>((done, fail) => {
    const child = execFile('/bin/sh', [], (err) => (err ? fail(err) : done()));
    child.stdin?.end(script);
  });
  res.json({ identity, ok: true });
}));

soloRoutes.post('/api/solo/test', asyncRoute(async (req, res) => {
  const identity = resolveSoloIdentity();
  const policy = loadPolicy();
  const rules = rulesForActor(policy, { id: identity.id, role: identity.role });
  // No rule to demonstrate yet is a real state, not an error — a fresh solo
  // install with nothing switched on has nothing to show blocking.
  const sample = rules[0]?.examples.violating[0];
  const prompt = String(req.body?.prompt ?? sample ?? '');
  if (!prompt) return res.json({ verdict: null, reason: 'no active rule to test against yet' });

  const decision = await evaluate(adapter(), { actor: { id: identity.id, role: identity.role }, prompt }, policy);
  res.json(decision);
}));
