/**
 * The corpus, run from the console.
 *
 * The last run is kept on disk so the console can show results without
 * re-running a suite that takes minutes against a real model.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { isMock } from '../../qvac/index.js';
import { seedPath } from '../config.js';
import { asyncRoute, readJsonFile } from '../http.js';

export const redteamRoutes = Router();

const RT_RESULT = isMock() ? 'data/redteam-last.mock.json' : 'data/redteam-last.json';

redteamRoutes.get('/api/redteam/report', (_req, res) => {
  const last = readJsonFile<unknown | null>(RT_RESULT, null);
  if (!last) return res.status(404).json({ error: 'no run yet — pnpm run redteam' });
  res.json(last);
});

let redteamRunning = false;

redteamRoutes.post('/api/redteam/run', asyncRoute(async (_req, res) => {
  // One at a time: overlapping runners race on REPORT.md and the result file,
  // and each spawn is a full corpus of model calls. The flag follows the child
  // process, not this request — a run that outlives the 120s response window
  // still holds the slot until it exits.
  if (redteamRunning) {
    return res.status(409).json({ error: 'a run is already in progress — use Load last report' });
  }
  redteamRunning = true;
  // A compiled build (pnpm start, the desktop app) carries the runner as plain
  // JS next to this file; a source checkout runs the TS through the repo's
  // installed tsx instead. Either is invoked through this exact runtime,
  // because shell launchers (`npx`, `npm.cmd`) differ across platforms and can
  // emit ENOENT/EINVAL on Windows when spawned without a shell.
  const compiledRunner = fileURLToPath(new URL('../../redteam/runner.js', import.meta.url));
  const tsx = resolve(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const runnerArgs = existsSync(compiledRunner)
    ? [compiledRunner]
    : existsSync(tsx)
      ? [tsx, 'src/redteam/runner.ts']
      : null;
  if (!runnerArgs) {
    redteamRunning = false;
    return res.status(501).json({ error: 'the red-team runner is not part of this build' });
  }
  const child = spawn(process.execPath, runnerArgs, {
    cwd: process.cwd(),
    // The runner is a second process; sharing the server's audit file would
    // interleave two hash chains and "break" the log from ordinary use.
    // ELECTRON_RUN_AS_NODE is inert under plain Node and makes the Electron
    // binary behave as Node when the gateway runs inside the desktop app.
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      WARDEN_AUDIT_PATH: 'data/audit-redteam.jsonl',
      WARDEN_BENCHMARK_POLICY: process.env['WARDEN_BENCHMARK_POLICY'] ?? seedPath('benchmark-policy.json')
    },
    stdio: 'ignore',
    detached: false,
    windowsHide: true
  });
  // The slot is released by the child ending, not by this request returning, so
  // a run that outlives the response window still holds it. Registered once,
  // before the race, because an 'error' with no listener at all — a missing
  // runtime — would take down the whole gateway rather than failing this one
  // request.
  child.once('error', () => { redteamRunning = false; });
  child.once('exit', () => { redteamRunning = false; });

  // Long enough that a mock run finishes inline; a real-model run keeps going
  // and the console picks it up from disk on the next "Load last report".
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    new Promise<{ finished: true; error?: string }>((done) => {
      child.once('error', (err) => done({ finished: true, error: err.message }));
      child.once('exit', (code) => done({
        finished: true,
        error: code === 0 ? undefined : `runner exited with code ${code ?? 'unknown'}`
      }));
    }),
    new Promise<{ finished: false }>((done) => {
      timer = setTimeout(() => done({ finished: false }), 120_000);
    })
  ]);
  if (timer) clearTimeout(timer);
  if (outcome.finished && outcome.error) {
    return res.status(500).json({ error: `red-team run failed: ${outcome.error}` });
  }
  const last = readJsonFile<unknown | null>(RT_RESULT, null);
  if (!last) {
    return res.status(outcome.finished ? 500 : 202).json({
      error: outcome.finished ? 'run produced no result' : 'still running — use Load last report in a minute'
    });
  }
  res.json(last);
}));
