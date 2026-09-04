/**
 * What the gateway reads from its environment at boot and more than one module
 * needs. A flag only one route reads stays beside that route; this file is for
 * the three values the whole server is built around.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PORT = Number(process.env['WARDEN_PORT'] ?? 8080);

/**
 * Bind every interface by default.
 *
 * Warden's deployment model is one machine holding the models with the rest of
 * the team's tools pointing at it, so localhost-only would make the product
 * undemonstrable. Set WARDEN_HOST=127.0.0.1 to keep it private — this is a
 * plaintext service with API-key auth, meant for a trusted LAN, not the open
 * internet.
 */
export const HOST = process.env['WARDEN_HOST'] ?? '0.0.0.0';

/**
 * Where the read-only pieces that ship with Warden live: web/, integrations/,
 * data/seed/. In a checkout that is the repo root, resolved from this file's
 * own location so `pnpm run dev` (src/server) and `pnpm start` (dist/server)
 * both land on it whatever the working directory. The desktop app runs the
 * server with its working directory pointed at a per-user data folder and
 * passes the bundle's location here explicitly. Writable state (data/*.json,
 * warden.local.json) deliberately stays cwd-relative — that is what lets the
 * same code write next to the repo in dev and into the user's data folder in
 * the app.
 */
export const ASSETS = process.env['WARDEN_ASSETS_DIR'] ?? fileURLToPath(new URL('../..', import.meta.url));

/** A file under the shipped seed directory. */
export function seedPath(...parts: string[]): string {
  return join(ASSETS, 'data', 'seed', ...parts);
}

/*
 * Children this process spawns must run as Node, not as a second Electron app.
 *
 * Under the desktop app the gateway is an Electron `utilityProcess`, so
 * `process.execPath` is the Electron binary. The QVAC SDK spawns its inference
 * worker from that path, and without this the worker comes up as a whole
 * Electron app that never speaks the RPC protocol the SDK is waiting on: after
 * 30 seconds the SDK reports "RPC initialization timed out, the worker process
 * may have failed to start" and every rule and every judgement fails on a
 * machine whose models are sitting right there on disk.
 *
 * Set here rather than on the env `server-manager.ts` hands to
 * `utilityProcess.fork`, because that is read when the utility process starts
 * and with it set the gateway never becomes healthy at all. Set after boot it
 * is inert for this process (Electron read it long ago) and inherited by
 * everything spawned from here, which is the only place it was ever needed.
 * The red-team spawn sets the same variable for the same reason and predates
 * this; that one can stay, it is explicit and it costs nothing.
 *
 * NOT VERIFIED as the cure for the reported timeout. It explains the symptom
 * and nothing else in the packaged app explains it as well, but confirming it
 * needs a build with the models downloaded, which has not been run. What is
 * verified is that it does not stop the gateway starting: that is what the
 * linux smoke job checks, and it is what the first attempt at this failed.
 */
if (process.versions.electron) process.env['ELECTRON_RUN_AS_NODE'] = '1';
