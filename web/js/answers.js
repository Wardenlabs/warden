/**
 * What the compiler's answers say on screen when they are not a rule.
 *
 * A decline, a spending target with the limits it proposes, a failure, and
 * the readable form of an error the gateway produced. All of them are turns
 * in the rule conversation, and the solo screen and the engine page reuse
 * two of them, which is why they live apart from either.
 */
import { $, api, esc, state } from './core.js';

/**
 * An error a person can read, out of whatever the gateway sent.
 *
 * A zod failure arrives as a JSON array of issue objects, and the console
 * printed the whole thing: forty lines of `"code": "invalid_type"` in the
 * middle of a conversation, about a schema the reader has never heard of. The
 * messages inside it are the only part with any meaning, and even those are
 * ours rather than theirs, so they are capped.
 */
export function readable(err) {
  if (!err) return 'unknown error';
  const text = String(err);
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      const fields = parsed.map((i) => (Array.isArray(i?.path) ? i.path.join('.') : '')).filter(Boolean);
      return fields.length
        ? `the draft was missing ${fields.slice(0, 6).join(', ')}`
        : 'the draft did not match the expected shape';
    }
  } catch {
    /* not JSON, which is the ordinary case */
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * What to say when the compiler did not write a rule, which is two answers.
 *
 * "Quiero reducir mi uso del mes 50%" is not the same kind of thing as "juan".
 * One is a request Warden can satisfy in the only currency it has for spending,
 * and refusing it flat was wrong: the point of typing a sentence is that
 * something comes back. So the gateway multiplies the limits it already has by
 * the fraction the compiler read, and this puts the arithmetic on screen with
 * a button. The other really is nothing to act on, and says so in one line.
 */
export function notARuleAnswer(j) {
  const reason = esc(j.reason || 'There is no prohibition in it.');
  if (typeof j.factor !== 'number') {
    return `<b>Nothing to enforce there.</b> ${reason}`;
  }
  return `<b>That is a spending target, not a rule.</b> ${reason}${limitsPlan(j)}`;
}

/**
 * The limits the compiler's fraction proposes, with the button that applies
 * them — or, when no role has a limit yet, the reason there is nothing to cut.
 *
 * The second case was invisible: a fresh policy has no quotas, "quiero
 * ahorrar 50%" produced an empty plan, and the screen said "Nothing to
 * enforce there", which reads as Warden not understanding the sentence. It
 * understood it; there was no number to halve. Now it says that, and points at
 * where the numbers are set.
 */
export function limitsPlan(j) {
  const pct = Math.round((1 - j.factor) * 100);
  if (!Array.isArray(j.limits) || j.limits.length === 0) {
    return `<div>Cutting ${pct}% needs a limit to cut. No role has a daily limit yet, so set one per role on
      <button type="button" class="linkish" data-go="people">Team</button> and say this again.</div>`;
  }
  state.pendingLimits = j.limits;
  return `<div>Cutting every daily limit by ${pct}%:</div>
    <div class="limit-plan">${j.limits.map((row) => `
      <div class="r"><span class="k">${esc(row.role)}</span>
        <span class="v num">${row.from} → ${row.to} a day</span></div>`).join('')}</div>
    <div><button type="button" class="btn --primary" id="applyLimits">Apply these limits</button></div>`;
}

/**
 * What to say when a compile fails, which depends entirely on why.
 *
 * There used to be one line for both cases and it ended "Try saying it more
 * plainly." That is fine advice for a sentence the 1.7B could not turn into a
 * rule, and it is useless when the gateway reports that its RPC never came up
 * after 30 seconds: the sentence was never the problem, and somebody rewriting
 * "no filtrar datos de clientes" for the fourth time is being sent in a circle
 * by their own tool. The server tags which kind it is.
 *
 * The infra case gets the two things that actually move it: where the log is,
 * and the fact that a signed-in Claude Code or Codex compiles rules without the
 * local model running at all.
 */
export function compileFailure(j) {
  const why = esc(j?.error ?? 'the model did not answer');
  if (j?.kind === 'compiler-setup-required') {
    return `<b>Choose what writes your rules first.</b> ${why}<div><button type="button" class="btn --primary" data-go="models" data-q="setup=compiler">Set up the rule writer</button></div>`;
  }
  if (j?.kind !== 'model-down') {
    return `I could not compile that: ${why}. Try saying it more plainly.`;
  }
  return `<b>The local model is not running.</b> ${why}.
    <div>Rewording will not help. <button type="button" class="linkish" id="showLog">Show me the gateway log</button>, which is where the reason is.</div>
    <div>If you have Claude Code or Codex signed in, <button type="button" class="linkish" data-go="compiler">point the compiler at it</button> and rules compile without the local model.</div>`;
}

/**
 * Pull the log into the page rather than sending somebody to a menu.
 *
 * 200 lines, in a scroll box, selectable, because the next thing that happens
 * is that they paste it to whoever is going to read it.
 */
export function bindLogPeek() {
  const btn = $('showLog');
  if (!btn) return;
  btn.onclick = async () => {
    btn.disabled = true;
    const { ok, j } = await api('/api/gateway/log');
    btn.replaceWith(Object.assign(document.createElement('div'), {
      className: 'code',
      textContent: ok ? (j.lines ?? []).join('\n') : (j.error ?? 'could not read the log')
    }));
  };
}
