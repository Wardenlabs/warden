/**
 * Whether another machine can get to this gateway, and asking for that to
 * change.
 *
 * Two screens need it: Gateway, where it is a setting, and the first run of
 * Team, where it is the step everything after depends on. Both ask the same two
 * routes and then wait the same way, because both routes answer "asked" and
 * never "done" — the gateway restarts on the far side of the response, and the
 * only thing that knows how it went is `/health` once it is back.
 */
import { post, state } from './core.js';
import { refreshHealth } from './data.js';

/**
 * Worked out here and not sent by the server, on purpose: `/health` carries
 * the facts, and a `reachable` beside them would be a second copy that can
 * disagree with the first. Null `reach` is a gateway older than the field —
 * not known, which this reads as not reachable only because every caller is
 * about to offer the way to find out.
 */
export const reachable = () => Boolean(state.reach?.publicUrl || state.reach?.lanUrl);

/** The address a setup message will carry. The public one outranks the LAN, as it does on the server. */
export const teamAddress = () => state.reach?.publicUrl || state.reach?.lanUrl || '';

const ROUTES = { lan: '/api/gateway/lan', public: '/api/gateway/expose' };

/** Ask. `{ ok, error }`, where ok means the shell was asked, not that it happened. */
export async function askReach(kind, enabled) {
  const { ok, j } = await post(ROUTES[kind], { enabled }).catch(() => ({ ok: false, j: null }));
  return { ok, error: ok ? '' : j?.error ?? 'Warden could not be reached.' };
}

/**
 * Poll `/health` until `done()` holds or two minutes pass, then call `settle`
 * with whether it did.
 *
 * A failed poll is expected and ignored: changing the bind restarts the
 * gateway, so for a second or two there is nothing to answer. `refreshHealth`
 * leaves the previous answer alone when it cannot read a new one, which is what
 * keeps this from concluding anything from the silence. One watch at a time —
 * asking again replaces the wait rather than racing it.
 */
let timer = null;
export function watchReach(done, settle) {
  clearTimeout(timer);
  const started = Date.now();
  const tick = async () => {
    await refreshHealth();
    if (done()) { settle(true); return; }
    if (Date.now() - started > 120000) { settle(false); return; }
    timer = setTimeout(tick, 3000);
  };
  timer = setTimeout(tick, 3000);
}

export function stopWatchingReach() { clearTimeout(timer); }
