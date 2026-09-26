/**
 * The message channel to the desktop shell, when there is one.
 *
 * Under Electron's utilityProcess the desktop shell owns a message channel to
 * this process. Plain Node has no `parentPort`, so it is feature-detected, and
 * Electron wraps each message in a MessageEvent while a bare value is accepted
 * too in case that wrapper ever changes.
 *
 * The console window deliberately has no preload — it is the same console a
 * browser gets, and giving it Electron powers would end that. So anything the
 * console needs the shell to do (download models, open a tunnel) goes to the
 * gateway, and the gateway relays it here. A browser pointed at the gateway
 * reaches the same routes and gets the same thing, which is correct: it is the
 * machine holding the models that acts.
 */
type ParentPort = {
  on: (ev: 'message', fn: (msg: unknown) => void) => void;
  postMessage: (msg: unknown) => void;
};

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;

/** Whether a desktop shell is listening at all. */
export function shellAttached(): boolean {
  return parentPort !== undefined;
}

/** Ask the shell to do something. False when there is no shell to ask. */
export function tellShell(message: 'expose-on' | 'expose-off' | 'lan-on' | 'lan-off' | 'leave-demo'): boolean {
  if (!parentPort) return false;
  parentPort.postMessage(message);
  return true;
}

/** Run `fn` for every message the shell sends, unwrapped from its MessageEvent. */
export function onShellMessage(fn: (data: unknown) => void): void {
  parentPort?.on('message', (msg) => {
    const data = msg && typeof msg === 'object' && 'data' in msg ? (msg as { data: unknown }).data : msg;
    fn(data);
  });
}

/*
 * Questions the shell asks and waits for an answer to, as opposed to the
 * one-way strings above. Only the desktop updater uses them (spec
 * docs/specs/desktop-auto-update.md §5.2). `id` pairs an answer with its
 * question, so a reply that arrives after the shell gave up cannot be read
 * as the answer to the next one.
 */
export type ShellRequest =
  | { type: 'readiness?'; id: string }
  | { type: 'drain'; id: string; boundMs: number };

export type ShellReply =
  | { type: 'readiness'; id: string; busy: string[] }
  | { type: 'drained'; id: string; cutOff: number; waitedMs: number };

/** The longest drain the shell may ask for. Above the hook's 90 s decision
 * deadline there is nothing left to wait for: the hook has already failed open. */
export const MAX_DRAIN_MS = 95_000;

export function isShellRequest(data: unknown): data is ShellRequest {
  if (!data || typeof data !== 'object') return false;
  const m = data as Record<string, unknown>;
  if (typeof m['id'] !== 'string' || m['id'].length === 0 || m['id'].length > 64) return false;
  if (m['type'] === 'readiness?') return true;
  return m['type'] === 'drain' && typeof m['boundMs'] === 'number' && Number.isFinite(m['boundMs']) &&
    m['boundMs'] >= 0 && m['boundMs'] <= MAX_DRAIN_MS;
}

/** Answer a shell request. False when there is no shell to answer. */
export function replyShell(reply: ShellReply): boolean {
  if (!parentPort) return false;
  parentPort.postMessage(reply);
  return true;
}
