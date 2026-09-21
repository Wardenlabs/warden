/**
 * Which Warden this is.
 *
 * Two installations on one machine is the ordinary case, not an exotic one. The
 * desktop app keeps its writable state in the user's application-support folder
 * and a checkout keeps it next to the repo — `config.ts` explains why that is
 * deliberate — and both of them want port 8080. Every install has its own
 * people and its own keys, because the keys live in that writable state.
 *
 * Until this existed, nothing either of them said named which one was
 * answering. A key minted by the app was refused by the checkout with "your key
 * is not recognised", the sentence read as "your key is wrong" rather than "you
 * are talking to the other Warden", and the only remedy anybody ever found was
 * to uninstall Warden. So: the gateway states its own name and version wherever
 * the answer would otherwise be ambiguous, and refuses to start on a port
 * another one is already holding instead of failing with Node's bind error.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, join } from 'node:path';
import { ASSETS } from './config.js';

/**
 * Where this process keeps what it writes.
 *
 * Derived the same way the stores derive it — cwd-relative — rather than
 * configured here, so it cannot drift from where the data actually lands.
 */
export function dataDir(): string {
  return join(process.cwd(), 'data');
}

/**
 * The short name for this installation.
 *
 * The basename of the data directory itself is the word "data" in every install
 * ever made, which distinguishes nothing. What tells two gateways apart is the
 * folder holding it: "Warden" for the desktop app's data folder, the checkout's
 * own directory name for a repo. That is also the name a person recognises when
 * a refusal names it back at them.
 *
 * It travels to anyone who can reach `/health`, including through a tunnel, so
 * it must stay non-sensitive: a directory name, never a path.
 */
export function installationLabel(): string {
  return basename(process.cwd()) || 'warden';
}

/**
 * Read once. `package.json` does not change while a process runs, and this is
 * on the answer to every unrecognised key.
 */
let cachedVersion: string | undefined;

export function installationVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const parsed = JSON.parse(readFileSync(join(ASSETS, 'package.json'), 'utf8')) as { version?: unknown };
    cachedVersion = typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    // A version nobody can read is not a reason to refuse to answer. The label
    // is the half that identifies the install; the version only dates it.
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

export type Installation = { label: string; version: string; dataDir?: string; intent?: 'solo' | 'team' };

/**
 * What this gateway says about itself, trimmed to what the asker may know.
 *
 * `dataDir` is a path inside somebody's home directory, and `/health` is
 * reachable from outside the moment an administrator opens a tunnel
 * (`POST /api/gateway/expose`). So the full path goes only to a caller on the
 * machine itself; the label and version travel to everyone, because neither
 * says anything that is not already safe to say out loud.
 */
export function installationReport(loopback: boolean): Installation {
  const report: Installation = { label: installationLabel(), version: installationVersion() };
  // What the desktop splash was told, when it was asked. The console reads it
  // to tell a team install with nobody in it yet from a solo one, which the
  // directory alone cannot. It decides what is drawn and authorises nothing.
  const intent = process.env['WARDEN_INSTALL_INTENT'];
  if (intent === 'solo' || intent === 'team') report.intent = intent;
  return loopback ? { ...report, dataDir: dataDir() } : report;
}

/**
 * Can this process have the port, or is somebody on it?
 *
 * A throwaway bind rather than a connection attempt, because the question is
 * the one the real listener is about to ask the kernel, and only a bind asks it
 * the same way: a port held by a listener bound to a single interface, or by
 * something that never accepts, answers a connect differently than it answers a
 * bind.
 *
 * Anything other than `EADDRINUSE` is reported as available, so a permission
 * error or an address this machine does not have still fails where it failed
 * before, with its own message, rather than being renamed "port in use" here.
 */
export function portAvailable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', (error: NodeJS.ErrnoException) => resolve(error.code !== 'EADDRINUSE'));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

/**
 * Safe to print in somebody's terminal.
 *
 * Whatever answered that port wrote these strings, and the only thing the boot
 * message does with them is `console.error`. A terminal reads control bytes as
 * instructions — an escape sequence can repaint the line above it, so a field
 * saying "Warden" could sit on top of a message that had said something else.
 * Nothing legitimate needs a control character in a directory name, so the
 * whole class goes, and the length is bounded because the other end chose it.
 */
function printable(value: string): string {
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 120);
  return clean || 'unnamed';
}

/**
 * Ask whatever is already on this port whether it is a Warden, and which one.
 *
 * Null covers every way the answer can fail to be a Warden gateway — nothing
 * listening any more, a different service, a version too old to carry
 * `installation` — because the caller does the same thing in all of them: say
 * the port is held by something that is not this product.
 */
export async function portHolder(port: number): Promise<Installation | null> {
  try {
    const answer = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
    if (!answer.ok) return null;
    const body = (await answer.json()) as { ok?: unknown; installation?: Partial<Installation> };
    const held = body?.installation;
    if (body?.ok !== true || typeof held?.label !== 'string') return null;
    return {
      label: printable(held.label),
      version: typeof held.version === 'string' ? printable(held.version) : 'unknown',
      ...(typeof held.dataDir === 'string' ? { dataDir: printable(held.dataDir) } : {})
    };
  } catch {
    return null;
  }
}
