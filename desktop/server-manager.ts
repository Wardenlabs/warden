/**
 * Lifecycle of the gateway child process.
 *
 * The child is the exact dist/server/index.js that `pnpm start` runs — the
 * desktop app configures it entirely through environment variables and its
 * working directory. Pointing cwd at the user's app-data folder is what makes
 * every cwd-relative write (data/*.json, audit chains, red-team results) land
 * there instead of inside the read-only application bundle.
 */
import { utilityProcess } from 'electron';
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { credentialEnvironment } from './credentials.js';

type Child = ReturnType<typeof utilityProcess.fork>;

export type ServerConfig = {
  /** Absolute path to dist/server/index.js inside the app bundle. */
  entry: string;
  /** The user's app-data folder — becomes the gateway's working directory. */
  cwd: string;
  /** The public URL this gateway is reachable at, when a tunnel is up. */
  publicUrl?: string | null;
  port: number;
  host: '127.0.0.1' | '0.0.0.0';
  /** Where web/, integrations/ and data/seed/ live (the app bundle root). */
  assetsDir: string;
  modelsDir: string;
  adapter: 'real' | 'mock';
  logPath: string;
  /** The splash's answer, when there is one. See `DesktopSettings.intent`. */
  intent?: 'solo' | 'team';
  /**
   * Set on the first launch after a desktop update, and on no other. The new
   * gateway writes the audit entry for the update from it
   * (`src/server/boot-audit.ts`).
   */
  update?: { from: string; stoppedAt: string | 'unknown'; cutOff: number | 'unknown' };
};

export type RunningServer = {
  port: number;
  /** Graceful stop: shutdown message, five seconds of patience, then kill. */
  stop: () => Promise<void>;
  /**
   * Send a question the gateway answers (`src/server/desktop-bridge.ts`
   * `ShellRequest`) and wait for the reply with the same `id`. Rejects on
   * timeout or if the gateway exits first. The caller decides what silence
   * means, and for the updater it always means "do not restart".
   */
  request: (message: { type: string; id: string } & Record<string, unknown>, timeoutMs: number) => Promise<Record<string, unknown>>;
};

export type HealthInfo = {
  ok: boolean;
  mock: boolean;
  mode: string;
  models?: 'cold' | 'loading' | 'ready' | 'failed';
};

/**
 * The preferred port if it is free on loopback, otherwise an ephemeral one.
 *
 * `waitMs` is for the launch right after a desktop update, and only that one.
 * There, "busy" usually means the previous process has not let go of the port
 * yet, and settling for another port would bring the gateway back at an
 * address no hook knows. Every hook would fail open against it without a word
 * (docs/specs/desktop-auto-update.md §6.5). An ordinary launch keeps taking a
 * free port at once, as `docs/DESKTOP.md` promises.
 */
export async function pickPort(preferred: number, forceEphemeral = false, waitMs = 0): Promise<number> {
  if (forceEphemeral) return ephemeralPort();
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (await portFree(preferred)) return preferred;
    if (Date.now() >= deadline) return ephemeralPort();
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const probe = createServer();
    probe.once('error', () => resolvePort(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolvePort(true)));
  });
}

function ephemeralPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      probe.close(() => (port > 0 ? resolvePort(port) : reject(new Error('no ephemeral port'))));
    });
  });
}

export function startServer(
  config: ServerConfig,
  onExit: (code: number) => void,
  onMessage?: (msg: unknown) => void
): RunningServer {
  mkdirSync(config.cwd, { recursive: true });
  mkdirSync(dirname(config.logPath), { recursive: true });
  rotateLog(config.logPath);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...credentialEnvironment(config.cwd),
    WARDEN_HOST: config.host,
    WARDEN_PORT: String(config.port),
    WARDEN_ASSETS_DIR: config.assetsDir,
    WARDEN_MODELS_DIR: config.modelsDir,
    // So the console can show the tail of this file when a model will not load.
    // The log is where the reason is, and "Gateway -> View gateway log" is two
    // menus away from the screen that just failed.
    WARDEN_LOG_PATH: config.logPath
  };
  // A preference about which console to draw, and nothing else: it authorises
  // nothing and is not a second notion of administrator.
  if (config.intent) env['WARDEN_INSTALL_INTENT'] = config.intent;
  // Only ever from `config.update`. Inherited from a shell they would record an
  // update that never happened on every launch.
  for (const key of ['WARDEN_UPDATED_FROM', 'WARDEN_UPDATED_STOPPED_AT', 'WARDEN_UPDATE_CUTOFF']) delete env[key];
  if (config.update) {
    env['WARDEN_UPDATED_FROM'] = config.update.from;
    env['WARDEN_UPDATED_STOPPED_AT'] = config.update.stoppedAt;
    env['WARDEN_UPDATE_CUTOFF'] = String(config.update.cutOff);
  }

  /*
   * The posture a gateway on the internet has to run in, set here rather than
   * asked of the administrator.
   *
   * `WARDEN_PUBLIC_URL` is what the onboarding pack hands employees — without
   * it the pack derives an address from the Host header, so an administrator
   * copying instructions while a tunnel is up would send everyone a LAN URL
   * they cannot reach.
   *
   * `WARDEN_TRUSTED_PROXY` because behind a tunnel every request reports the
   * tunnel's own loopback address, and without it the whole internet shares one
   * rate-limit bucket: the first flood locks out every real employee.
   *
   * `WARDEN_REQUIRE_HTTPS` because a tunnel terminates TLS and states it, so
   * anything arriving marked http is either misconfigured or not from the
   * tunnel at all — and every request here carries a credential.
   *
   * Deliberately NOT `WARDEN_ADMIN_REQUIRE_KEY`. It is on the checklist in
   * SECURITY.md and it belongs there, but the app already binds loopback only
   * and `isLoopback` already refuses anything carrying a proxy header, so
   * forcing it would demand a key from the administrator sitting at the machine
   * and buy nothing the two of those do not already cover. An operator running
   * the gateway some other way should still set it.
   */
  if (config.publicUrl) {
    env['WARDEN_PUBLIC_URL'] = config.publicUrl;
    env['WARDEN_TRUSTED_PROXY'] = '1';
    env['WARDEN_REQUIRE_HTTPS'] = '1';
  }

  /*
   * Tell the SDK where its worker is, because it cannot work that out from here.
   *
   * This is the reason on-device inference never ran in the packaged app, and
   * the symptom was "RPC initialization timed out after 30000ms, the worker
   * process may have failed to start" on a machine whose weights were all
   * present. `resolveWorkerPath` in @qvac/sdk tries, in order:
   * `QVAC_WORKER_PATH`; then `process.resourcesPath`, which is a main-process
   * property and is not defined in a `utilityProcess`; then a walk up from
   * `process.cwd()` looking for a package.json, and the gateway's cwd is the
   * user's data folder, which has no package.json above it; then a default
   * inside node_modules that `bare` cannot read out of app.asar.
   *
   * Every path after the first fails for a packaged Warden specifically. The
   * first is an env var, and the main process is the one place that knows
   * `resourcesPath` and the app root, so it sets it.
   *
   * Nothing is set when no candidate exists, which is the checkout case: there
   * cwd is the repo, the package.json walk works, and the SDK finds it alone.
   */
  const workerEntry = [
    ...(typeof process.resourcesPath === 'string'
      ? [
          join(process.resourcesPath, 'app.asar.unpacked', 'qvac', 'worker.entry.mjs'),
          join(process.resourcesPath, 'app', 'qvac', 'worker.entry.mjs'),
          join(process.resourcesPath, 'qvac', 'worker.entry.mjs')
        ]
      : []),
    // `bare` reads the worker off the filesystem and cannot read it out of an
    // asar, so the unpacked sibling comes before the archive path itself.
    join(config.assetsDir.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked'), 'qvac', 'worker.entry.mjs'),
    join(config.assetsDir, 'qvac', 'worker.entry.mjs')
  ].find((candidate) => existsSync(candidate));
  /*
   * The bundled entry is the default, not an override. An operator who set
   * `QVAC_WORKER_PATH` before launching meant it, and until now the spread of
   * `process.env` above carried their value in and this line threw it away four
   * lines later — silently, which is the part that cost an afternoon. It
   * mattered because the entry inside a shipped bundle was itself broken
   * (`qvac bundle sdk` writes the SDK imports as absolute paths under the build
   * machine's tree, so the worker dies on its first import anywhere else), and
   * the one repair available to somebody who already had the app installed —
   * point it at a fixed copy outside the bundle — could not work, because the
   * app overwrote the variable with the file that was broken.
   *
   * The bundled entry is correct again as of 0.1.17. This stays, because a
   * signed bundle is the one thing a user cannot edit, so the escape hatch has
   * to live outside it.
   */
  if (workerEntry && !env['QVAC_WORKER_PATH']) env['QVAC_WORKER_PATH'] = workerEntry;
  if (config.adapter === 'mock') env['WARDEN_ADAPTER'] = 'mock';
  else delete env['WARDEN_ADAPTER'];
  /*
   * Deleted here, and set again inside the gateway once it is running. Both
   * halves are needed and they are not interchangeable.
   *
   * The gateway is an Electron `utilityProcess`, so its `process.execPath` is
   * the Electron binary. Anything it spawns from that path comes up as a whole
   * Electron app unless this variable says otherwise, and a whole Electron app
   * does not speak the QVAC worker's RPC protocol; it sits there until the SDK
   * gives up with "RPC initialization timed out after 30000ms". That is the
   * error reported from a packaged install with its models downloaded.
   *
   * Setting it here looked like the fix and is not: `utilityProcess.fork` reads
   * this variable when it starts the child, and with it set the gateway never
   * answers its health check at all. The linux smoke job caught that within
   * four minutes, which is the entire reason that job exists.
   *
   * So the variable stays off the utility process's own startup env, and
   * `server/index.ts` puts it into `process.env` after boot, where nothing
   * rereads it for this process and every child the SDK spawns inherits it.
   */
  delete env['ELECTRON_RUN_AS_NODE'];

  const child: Child = utilityProcess.fork(config.entry, [], {
    cwd: config.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    serviceName: 'warden-gateway',
    env
  });

  const log = createWriteStream(config.logPath, { flags: 'a' });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });

  // Replies to `request()`, by id. Anything else is a doorbell for `onMessage`.
  const pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();

  // The gateway talks back on the same channel `shutdown` goes out on. It is
  // how the web console asks for something only the shell can do — fetching the
  // models — without the console window needing a preload.
  child.on('message', (msg) => {
    const data = msg && typeof msg === 'object' && 'data' in msg ? (msg as { data: unknown }).data : msg;
    const id = data && typeof data === 'object' ? (data as { id?: unknown }).id : undefined;
    const waiter = typeof id === 'string' ? pending.get(id) : undefined;
    if (waiter) {
      pending.delete(id as string);
      clearTimeout(waiter.timer);
      waiter.resolve(data as Record<string, unknown>);
      return;
    }
    onMessage?.(data);
  });

  let stopping = false;
  child.on('exit', (code) => {
    log.end();
    for (const [id, waiter] of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('the gateway exited before answering'));
      pending.delete(id);
    }
    if (!stopping) onExit(code ?? 0);
  });

  const request: RunningServer['request'] = (message, timeoutMs) =>
    new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(message.id);
        rejectRequest(new Error(`no answer to ${message.type} within ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(message.id, { resolve: resolveRequest, reject: rejectRequest, timer });
      try {
        child.postMessage(message);
      } catch (err) {
        clearTimeout(timer);
        pending.delete(message.id);
        rejectRequest(err instanceof Error ? err : new Error(String(err)));
      }
    });

  const stop = (): Promise<void> =>
    new Promise((resolveStop) => {
      stopping = true;
      let settled = false;
      const finish = (): void => {
        if (!settled) {
          settled = true;
          resolveStop();
        }
      };
      child.once('exit', finish);
      try {
        child.postMessage('shutdown');
      } catch {
        finish();
        return;
      }
      // The server exits by itself at 4s; kill() (SIGTERM-ish) is the backstop
      // and the extra second after it covers a hard-stuck child on Windows,
      // where nothing softer exists.
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        setTimeout(finish, 1000);
      }, 5000);
    });

  return { port: config.port, stop, request };
}

/** Poll /health until the gateway answers or the budget runs out. */
export async function waitHealthy(port: number, timeoutMs: number): Promise<HealthInfo | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await fetchHealth(port);
    if (health) return health;
    await sleep(400);
  }
  return null;
}

export async function fetchHealth(port: number): Promise<HealthInfo | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return (await res.json()) as HealthInfo;
  } catch {
    return null;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** Keep the previous run's log readable without letting the file grow forever. */
function rotateLog(logPath: string): void {
  try {
    if (existsSync(logPath) && statSync(logPath).size > 2_000_000) {
      renameSync(logPath, `${logPath}.old`);
    }
  } catch {
    /* a broken rotation must not block the gateway from starting */
  }
}
