/**
 * The gateway describing itself: whether it is up, what it is running on, and
 * the two things it can ask the desktop shell to do.
 */
import { readFileSync } from 'node:fs';
import { Router } from 'express';
import { promptsEnabled, retentionSummary } from '../../audit/prompts.js';
import { cliCompilerConfig, cliToolLabel } from '../../qvac/cli-compiler.js';
import { modelInventory, probeRuntime, resolvedModel } from '../../qvac/client.js';
import { isMock, remoteCompiler } from '../../qvac/index.js';
import { shellAttached, tellShell } from '../desktop-bridge.js';
import { asyncRoute } from '../http.js';
import { modelState } from '../lifecycle.js';

export const systemRoutes = Router();

/**
 * The decision deadline this deployment hands to its hooks.
 *
 * 90 seconds by default, which is what `integrations/warden-hook.mjs` falls
 * back to when a gateway is too old to say. Raise it on the gateway when the
 * adjudicator is slower than the deadline — the optional 8B was measured at
 * 46 s on four CPU cores — and every hook picks it up on its next prompt
 * without anybody editing a shell profile.
 */
function hookDecisionDeadlineMs(): number {
  const raw = process.env['WARDEN_HOOK_TIMEOUT_MS'];
  if (raw === undefined) return 90_000;
  const value = Number(raw);
  // A deadline nobody can parse is not a reason to invent a shorter one: the
  // shorter it is, the sooner the hook stops checking.
  return Number.isFinite(value) && value > 0 ? value : 90_000;
}

// `mode` is surfaced for the same reason `mock` is: a gateway running with the
// guard switched off (`WARDEN_MODE=baseline`) must not present an identical
// green UI to one that is enforcing.
systemRoutes.get('/health', (_req, res) =>
  res.json({
    ok: true,
    mock: isMock(),
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
    deadlines: { decisionMs: hookDecisionDeadlineMs() },
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
 * The roles `ensureModels` will actually fetch: required, and with a URL.
 *
 * Kept beside the route rather than imported from the desktop catalog, because
 * the gateway is also the thing a checkout runs and it must not depend on the
 * Electron half to describe itself.
 */
const FETCHABLE_ROLES = new Set(['adjudicator', 'compiler', 'embedder', 'detector']);

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
  res.json({
    mock: isMock(),
    state: modelState(),
    runtime,
    // `fetchable` is what the first-run downloader would actually go and get:
    // `required` and carrying an HTTPS url. OCR_LATIN has neither (`url: null`,
    // it resolves only over the P2P registry) and the assistant is optional, so
    // the panel offered to download two models that the download step skips by
    // design, and pressing the button changed nothing about either. Saying
    // which is which is the difference between a broken button and a fact.
    models: modelInventory().map((m) => ({
      ...m,
      fetchable: FETCHABLE_ROLES.has(m.role),
      optional: !FETCHABLE_ROLES.has(m.role)
    })),
    // Two seats, one of which never leaves. Named separately because conflating
    // them is the misunderstanding this route exists to end.
    judging: { where: 'this machine', model: resolvedModel('adjudicator') },
    drafting: cli
      ? { where: cliToolLabel(cli.tool), model: cli.model || 'its default' }
      : remote
        ? { where: 'a configured endpoint', model: remote }
        : { where: 'this machine', model: resolvedModel('compiler') }
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
