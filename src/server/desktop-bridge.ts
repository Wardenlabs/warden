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
export function tellShell(message: 'expose-on' | 'expose-off' | 'leave-demo'): boolean {
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
