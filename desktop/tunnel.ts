/**
 * A public HTTPS address for a gateway that only listens on loopback.
 *
 * Exposing Warden used to be a runbook: install a tunnel, launch the app from a
 * terminal with three environment variables, open the tunnel in a second
 * terminal, copy a URL that changes every time it restarts, and hand every
 * employee a new one. Every step is something an administrator can get subtly
 * wrong, and the one that matters most — that a proxied request must not be
 * trusted as local — is invisible until somebody is already exposed.
 *
 * So the app does it. What this file owns is one child process and the URL it
 * prints.
 *
 * `cloudflared` is NOT bundled. It is tens of megabytes and somebody else's
 * binary shipped inside a security product, which is a supply chain nobody
 * asked for; if it is missing the app says how to install it rather than
 * fetching it. That is also why this is a quick tunnel and not a named one: a
 * named tunnel needs a Cloudflare account and a login, which is a conversation
 * the product cannot have on the administrator's behalf.
 *
 * The quick tunnel's honest limitations, surfaced rather than hidden: the URL
 * is public to anyone who has it, and it changes on every restart.
 */
import { spawn, type ChildProcess } from 'node:child_process';

export type TunnelState =
  | { status: 'off' }
  | { status: 'starting' }
  | { status: 'on'; url: string }
  | { status: 'failed'; reason: string };

/** Where the quick tunnel prints its address, in the banner it draws on stderr. */
const URL_PATTERN = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;

/**
 * How long to wait for that banner.
 *
 * Cloudflare is being asked for a hostname, so this is a network round trip on
 * somebody's wifi rather than a local spawn. Long enough not to give up on a
 * slow morning, short enough that a silent failure does not look like a hang.
 */
const READY_TIMEOUT_MS = 30_000;

let child: ChildProcess | null = null;

export function isRunning(): boolean {
  return child !== null;
}

/**
 * Start a tunnel to a local port and resolve once it has an address.
 *
 * Rejects rather than resolving to a failed state, so the caller's error path
 * and its success path are the same shape as everywhere else. Anything already
 * running is stopped first: two tunnels to one port is two public URLs, one of
 * which nobody is tracking.
 */
export async function start(port: number): Promise<string> {
  await stop();

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let output = '';

    const proc = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child = proc;

    const finish = (err: Error | null, url?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        // The process may be alive and simply not talking. Leaving it running
        // would leak a tunnel nobody has the URL for, which is the worst of
        // both: exposed and unmanaged.
        proc.kill();
        if (child === proc) child = null;
        reject(err);
      } else {
        resolve(url as string);
      }
    };

    const timer = setTimeout(
      () => finish(new Error(`cloudflared did not report a URL within ${READY_TIMEOUT_MS / 1000}s`)),
      READY_TIMEOUT_MS
    );

    // The banner goes to stderr, but read both: which stream carries it is a
    // detail of a program this file does not own.
    const read = (chunk: Buffer): void => {
      output += chunk.toString();
      const found = URL_PATTERN.exec(output);
      if (found) finish(null, found[0]);
    };
    proc.stdout?.on('data', read);
    proc.stderr?.on('data', read);

    proc.on('error', (err: NodeJS.ErrnoException) => {
      finish(
        new Error(
          err.code === 'ENOENT'
            ? 'cloudflared is not installed. Install it with `brew install cloudflared`, then try again.'
            : `could not start cloudflared: ${err.message}`
        )
      );
    });

    proc.on('exit', (code) => {
      if (child === proc) child = null;
      // An exit before the URL is the ordinary failure — a port nothing is
      // listening on, no network. The tail of its own output says more than
      // any sentence written here could.
      finish(new Error(`cloudflared exited (${code}). ${output.trim().split('\n').slice(-2).join(' ')}`));
    });
  });
}

/**
 * Stop the tunnel, and wait for it to actually be gone.
 *
 * Awaited rather than fired and forgotten because the caller's next move is
 * usually to start another one on the same port, and a half-dead predecessor
 * makes that fail in a way that looks like the new tunnel is broken.
 */
export async function stop(): Promise<void> {
  const proc = child;
  child = null;
  if (!proc || proc.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const done = setTimeout(() => {
      // It ignored SIGTERM. Nothing left to be polite about: this process holds
      // a public address open.
      proc.kill('SIGKILL');
      resolve();
    }, 3000);
    proc.once('exit', () => {
      clearTimeout(done);
      resolve();
    });
    proc.kill();
  });
}
