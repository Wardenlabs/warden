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
import { dirname } from 'node:path';

type Child = ReturnType<typeof utilityProcess.fork>;

export type ServerConfig = {
  /** Absolute path to dist/server/index.js inside the app bundle. */
  entry: string;
  /** The user's app-data folder — becomes the gateway's working directory. */
  cwd: string;
  port: number;
  host: '127.0.0.1' | '0.0.0.0';
  /** Where web/, integrations/ and data/seed/ live (the app bundle root). */
  assetsDir: string;
  modelsDir: string;
  adapter: 'real' | 'mock';
  logPath: string;
};

export type RunningServer = {
  port: number;
  /** Graceful stop: shutdown message, five seconds of patience, then kill. */
  stop: () => Promise<void>;
};

export type HealthInfo = {
  ok: boolean;
  mock: boolean;
  mode: string;
  models?: 'cold' | 'loading' | 'ready' | 'failed';
};

/** The preferred port if it is free on loopback, otherwise an ephemeral one. */
export async function pickPort(preferred: number, forceEphemeral = false): Promise<number> {
  if (!forceEphemeral && (await portFree(preferred))) return preferred;
  return ephemeralPort();
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
    WARDEN_HOST: config.host,
    WARDEN_PORT: String(config.port),
    WARDEN_ASSETS_DIR: config.assetsDir,
    WARDEN_MODELS_DIR: config.modelsDir
  };
  if (config.adapter === 'mock') env['WARDEN_ADAPTER'] = 'mock';
  else delete env['WARDEN_ADAPTER'];
  // The shell may itself have been started oddly; never leak this into the
  // child, where it would change how *its* own spawns behave.
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

  // The gateway talks back on the same channel `shutdown` goes out on. It is
  // how the web console asks for something only the shell can do — fetching the
  // models — without the console window needing a preload.
  if (onMessage) {
    child.on('message', (msg) => {
      const data = msg && typeof msg === 'object' && 'data' in msg ? (msg as { data: unknown }).data : msg;
      onMessage(data);
    });
  }

  let stopping = false;
  child.on('exit', (code) => {
    log.end();
    if (!stopping) onExit(code ?? 0);
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

  return { port: config.port, stop };
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
