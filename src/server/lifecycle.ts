/**
 * Boot and exit: warming the models before anyone asks, and leaving without
 * orphaning the inference worker.
 */
import type { Server } from 'node:http';
import { probeRuntime, shutdown, warmup } from '../qvac/client.js';
import { isMock } from '../qvac/index.js';
import { onShellMessage } from './desktop-bridge.js';

export type ModelState = 'cold' | 'loading' | 'ready' | 'failed';

/**
 * Warmth of the models `preloadModels` owns. `cold` covers mock mode and
 * WARDEN_WARMUP=0 as well as "not started yet" — the desktop splash treats
 * anything other than `loading` as "stop waiting and open the console".
 */
let state: ModelState = 'cold';

export function modelState(): ModelState {
  return state;
}

/**
 * Load the models the hot path needs, at boot, before anyone asks.
 *
 * Until now nothing called `warmup()`, so the first employee prompt of the day
 * paid for loading a GGUF inside the decision it was waiting on. Measured on
 * the 2026-08-23 verification run: a cold decision took 25-27s against 7s hot,
 * and a cold Codex evaluation reached 36s — past the hook's 30s deadline, so
 * the hook failed open and the prompt reached the model while Warden was still
 * deciding. That is the guard being bypassed by a stopwatch, and the load it
 * was waiting for had no reason to happen then rather than at boot.
 *
 * Deliberately not awaited: the console and the API come up immediately, and a
 * request that arrives mid-load joins the same in-flight promise rather than
 * starting a second one. A failure is logged and left alone — `modelFor` drops
 * a rejected load so the next request retries it, and a gateway that refuses to
 * start because a model is missing is worse than one that is slow.
 *
 * `adjudicator` and `embedder` are what every decision touches. `ocr` is only
 * for attachments and costs a load nobody may need.
 */
export function preloadModels(): void {
  if (isMock() || process.env['WARDEN_WARMUP'] === '0') return;

  const started = Date.now();
  state = 'loading';
  console.log('  models    preloading adjudicator + embedder…');
  // Probed before the warmup, so the first load failure of the boot already
  // carries the answer. The whole point of the probe is to be in the message
  // somebody screenshots, and the first message is the one they screenshot.
  void probeRuntime()
    .then((probe) => {
      console.log(
        probe.ok
          ? `  runtime   ${probe.path} ok (${probe.detail})`
          : `  runtime   WILL NOT RUN: ${probe.path ?? 'not found'} — ${probe.detail}`
      );
    })
    .then(() => warmup(['adjudicator', 'embedder']))
    .then(() => {
      state = 'ready';
      console.log(`  models    ready in ${((Date.now() - started) / 1000).toFixed(1)}s — decisions are warm\n`);
    })
    .catch((err: unknown) => {
      state = 'failed';
      console.error(
        `  models    preload failed (${err instanceof Error ? err.message : String(err)}).` +
        ' The first request will load them instead, and will be slow.\n'
      );
    });
}

/**
 * Exit paths. The QVAC worker is a separate OS process the SDK spawns; exiting
 * without `shutdown()` leaves it orphaned — which is exactly what a plain
 * Ctrl-C did until now. The desktop app depends on this handler too: it asks
 * for a graceful stop (message or SIGTERM), waits a few seconds, then
 * force-kills whatever is left.
 */
export function installExitHandlers(server: Server): void {
  let exiting = false;
  const gracefulExit = (): void => {
    if (exiting) return;
    exiting = true;
    server.close();
    const finish = (): void => process.exit(0);
    // A wedged model unload must not outlive the desktop app's five-second
    // patience — leaving cleanly at four beats being force-killed at five.
    setTimeout(finish, 4000).unref();
    if (isMock()) {
      finish();
      return;
    }
    void shutdown().catch(() => undefined).then(finish);
  };
  process.on('SIGTERM', gracefulExit);
  process.on('SIGINT', gracefulExit);
  onShellMessage((data) => {
    if (data === 'shutdown') gracefulExit();
  });
}
