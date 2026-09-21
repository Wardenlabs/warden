/**
 * The gateway describing itself: whether it is up, what it is running on, and
 * the two things it can ask the desktop shell to do.
 */
import { readFileSync } from 'node:fs';
import { Router } from 'express';
import { promptsEnabled, retentionSummary } from '../../audit/prompts.js';
import { cliCompilerConfig, cliToolLabel } from '../../qvac/cli-compiler.js';
import { activeLocalModel, configuredModel, modelInventory, probeRuntime, resolvedModel } from '../../qvac/client.js';
import { selections } from '../../models/manager.js';
import { findModel } from '../../models/store.js';
import { setupModelDownloads } from '../../setup/catalog.js';
import { isMock, remoteCompiler } from '../../qvac/index.js';
import { isLoopback, isRelayed } from '../admin-auth.js';
import { hookDecisionDeadlineMs } from '../config.js';
import { shellAttached, tellShell } from '../desktop-bridge.js';
import { asyncRoute, reachFor } from '../http.js';
import { installationReport } from '../installation.js';
import { modelState } from '../lifecycle.js';

export const systemRoutes = Router();

/**
 * The decision deadline this deployment hands to its hooks.
 *
 * It moved to `server/config.ts` when the guard started comparing decisions
 * against it too — see `hookDecisionDeadlineMs` there, and
 * docs/specs/first-run-and-theme.md §4.4.
 */

// `mode` is surfaced for the same reason `mock` is: a gateway running with the
// guard switched off (`WARDEN_MODE=baseline`) must not present an identical
// green UI to one that is enforcing.
systemRoutes.get('/health', (req, res) =>
  res.json({
    ok: true,
    mock: isMock(),
    /*
     * Which Warden answered.
     *
     * The one fact that was missing everywhere it mattered. Two installations
     * on one machine — the desktop app and a checkout — each hold their own
     * people and their own keys, and nothing they said named which of them a
     * hook, a console or a `curl` had just reached. `installation.ts` has the
     * whole account. `dataDir` rides along only for a caller on this machine,
     * because it is a path inside somebody's home and this route answers
     * through the tunnel too.
     */
    installation: installationReport(isLoopback(req)),
    // How long an administrator can read a prompt for. On /health because it
    // is a property of this deployment, and the console has to be able to say
    // it out loud on the screen where the text is shown.
    prompts: promptsEnabled() ? retentionSummary() : null,
    mode: process.env['WARDEN_MODE'] === 'baseline' ? 'baseline' : 'warden',
    models: modelState(),
    // Whether there is a desktop shell listening that could actually fetch the
    // models. In a browser against a checkout there is not, and the console has
    // to offer the command instead of a button that would do nothing.
    canLeaveDemo: shellAttached(),
    // Where the team reaches this gateway, so the console can say it on the
    // screen where somebody is handing out addresses rather than leaving them
    // to guess whether the tunnel came up.
    publicUrl: process.env['WARDEN_PUBLIC_URL'] ?? null,
    // What is bound, the LAN address if any, the public one, and whether a
    // shell could change it. `publicUrl` above only ever knew about the tunnel;
    // this is what lets the console notice a gateway only this machine can
    // open. `reachFor` has the account, including what a relayed caller is not
    // told.
    reach: reachFor(isRelayed(req), shellAttached()),
    /*
     * How long this gateway asks a hook to wait for a decision.
     *
     * It is here because it is the gateway's number, not the employee's. The
     * onboarding pack used to hand every employee an `export
     * WARDEN_TIMEOUT_MS=...` line, which meant each laptop chose its own
     * deadline — and the direction that matters is down: a hook that gives up
     * early fails OPEN, so an employee who shortened it, or who kept an old
     * value from a pack written two releases ago, quietly stopped being
     * checked. Nobody would see it. The administrator who raised the deadline
     * for a slower model would not see it either.
     *
     * So the gateway states it and the hook takes it. What an employee still
     * needs on their machine is a URL and a key, which is the whole point of
     * identity being the key and only the key.
     */
    // 45 s extraction + 180 s analysis + 5 s cancellation grace, with 10 s
    // left to deliver and validate the response. Text retains its own budget.
    deadlines: { decisionMs: hookDecisionDeadlineMs(), documentMs: 240_000 },
    /*
     * Whether a hook that cannot reach this gateway may let the prompt through.
     *
     * Open by default and under protest, which is the trade SECURITY.md has
     * always named: a crashed gateway bricking every developer's CLI at once
     * gets Warden uninstalled the first morning it happens, and a guard nobody
     * runs stops nothing. That reasoning is about a laptop on a desk.
     *
     * It stops being obviously right the moment a gateway is the control an
     * organisation says it has. `WARDEN_FAIL_CLOSED=1` refuses instead, and
     * like the deadline it is stated here rather than set per machine — an
     * employee who can choose whether their own guard is optional does not
     * have one.
     */
    failClosed: process.env['WARDEN_FAIL_CLOSED'] === '1'
  })
);

/**
 * What Warden is actually running on, said plainly enough to act on.
 *
 * The console could name the adjudicator and could not say whether its weights
 * exist, so "the model is installed" and "the model is a filename in a config"
 * looked identical, and somebody with neither spent an evening wondering why
 * every rule came back unevaluated. It also never said the thing people ask
 * first: whether the Claude or Codex subscription they just configured is doing
 * the judging. It is not, it never will be, and the reason belongs on screen
 * next to the setting rather than in SECURITY.md.
 */
systemRoutes.get('/api/models', asyncRoute(async (_req, res) => {
  const cli = cliCompilerConfig();
  const remote = remoteCompiler();
  // Cheap, and it is the one question nothing else on this machine can answer.
  const runtime = isMock() ? null : await probeRuntime();
  const selected = selections();
  const customJudge = selected.adjudicator && !process.env['WARDEN_MODEL_ADJUDICATOR'] ? findModel(selected.adjudicator) : null;
  const customCompiler = selected.compiler && !process.env['WARDEN_COMPILER_API'] && !process.env['WARDEN_COMPILER_CLI'] && !process.env['WARDEN_MODEL_COMPILER'] ? findModel(selected.compiler) : null;
  const fetchableRoles = new Set(setupModelDownloads().map((spec) => spec.role));
  res.json({
    mock: isMock(),
    state: modelState(),
    runtime,
    // Match the downloader: a Claude compiler does not need bundled weights;
    // selecting local makes those weights actionable on the next refresh.
    models: modelInventory().map((m) => ({
      ...m,
      fetchable: fetchableRoles.has(m.role),
      optional: !fetchableRoles.has(m.role)
    })),
    // Two seats, one of which never leaves. Named separately because conflating
    // them is the misunderstanding this route exists to end.
    judging: { where: 'this machine', model: customJudge?.name ?? resolvedModel('adjudicator'),
      modelId: customJudge?.id ?? null, configuredModel: configuredModel('adjudicator'), inForce: activeLocalModel('adjudicator') },
    drafting: cli
      ? { where: cliToolLabel(cli.tool), model: cli.model || 'its default' }
      : remote
        ? { where: 'a configured endpoint', model: customCompiler?.name ?? remote, modelId: customCompiler?.id ?? null, inForce: remote }
        : { where: 'this machine', model: customCompiler?.name ?? resolvedModel('compiler'), modelId: customCompiler?.id ?? null,
          configuredModel: configuredModel('compiler'), inForce: activeLocalModel('compiler') }
  });
}));

/**
 * The last lines the gateway wrote, for the screen that just failed.
 *
 * When a model will not load, the reason is in this file and nowhere else, and
 * the file is behind `Gateway -> View gateway log` in the menu bar, which is
 * the same place the download button was hiding and just as hard to find. The
 * console shows the tail instead.
 *
 * Administrative, and it is worth saying why that is enough: the log holds the
 * gateway's own stdout, which carries decisions as verdict plus rule id plus
 * timing, never prompt text. Same promise the audit chain makes.
 */
systemRoutes.get('/api/gateway/log', (_req, res) => {
  const path = process.env['WARDEN_LOG_PATH'];
  if (!path) return res.status(404).json({ error: 'this gateway does not write to a log file' });
  try {
    const lines = readFileSync(path, 'utf8').split('\n');
    res.json({ path, lines: lines.slice(-200) });
  } catch (err) {
    res.status(404).json({ error: err instanceof Error ? err.message : 'log unreadable' });
  }
});

/**
 * Put this gateway on the internet, or take it off, from the console.
 *
 * It existed only in the macOS menu bar before, which is a place you find if
 * you already know it is there — and the person who needs it is the
 * administrator handing out URLs on the Team screen, not somebody browsing
 * menus.
 *
 * 202 rather than 200: the tunnel takes seconds and the gateway restarts on the
 * far side of it, so this answers "asked", never "done". The console learns the
 * outcome from `/health` once the gateway is back.
 */
systemRoutes.post('/api/gateway/expose', (req, res) => {
  const enabled = (req.body as { enabled?: unknown })?.enabled === true;
  if (!tellShell(enabled ? 'expose-on' : 'expose-off')) {
    return res.status(409).json({
      error: 'This gateway is not running inside the desktop app, so it cannot open a tunnel for you.'
    });
  }
  res.status(202).json({ ok: true });
});

/**
 * Let this network in, or keep it out: the desktop menu's "Allow LAN access".
 *
 * It existed only as a checkbox in that menu, and an administrator adding their
 * first teammate is looking at the console. Until they found it the gateway
 * listened on loopback and every setup message it issued was dead on arrival.
 *
 * The same shape as the tunnel above, for the same reason: changing the bind
 * means a restart, the restart happens on the far side of this response, and so
 * this answers "asked" and `/health` says when it is done. Administrative like
 * everything off the employee allowlist, with exactly the power of the menu
 * item — which is on this machine.
 *
 * Turning it on widens who can connect. It does not widen who is trusted:
 * a caller from the network is not loopback, so the administrative surface
 * still asks them for an administrator's key.
 */
systemRoutes.post('/api/gateway/lan', (req, res) => {
  const enabled = (req.body as { enabled?: unknown })?.enabled === true;
  if (!tellShell(enabled ? 'lan-on' : 'lan-off')) {
    return res.status(409).json({
      error: 'This gateway is not running inside the desktop app. Set WARDEN_HOST instead, and restart it.'
    });
  }
  res.status(202).json({ ok: true });
});

/**
 * Leave demo mode: fetch the models and restart into real inference.
 *
 * This existed only as `Gateway → Download models & leave demo mode…` in the
 * desktop menu bar. The banner on every screen told people where that was and
 * they did not find it, which is a fair outcome for a menu three levels into a
 * submenu nobody opens — "I can't see where to download the models" is the
 * report, and the answer is a button where the sentence about it already is.
 *
 * Administrative like everything not on the employee allowlist. It has exactly
 * the power the menu item has, and the menu item is on the same machine.
 */
systemRoutes.post('/api/gateway/leave-demo', (_req, res) => {
  if (!tellShell('leave-demo')) {
    return res.status(409).json({ error: 'No desktop app here. Run `pnpm run setup` instead.' });
  }
  res.status(202).json({ ok: true });
});
