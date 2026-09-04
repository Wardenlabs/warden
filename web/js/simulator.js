/**
 * The simulator: send a prompt as somebody on the team, and the two ways out of a refusal.
 */
import { passRow } from './activity.js';
import { $, api, attr, esc, state } from './core.js';
import { refreshAppeals } from './data.js';
import { say } from './draft.js';
import { personById, plural, ruleName, sendOnEnter } from './format.js';
import { disclosure, render } from './render.js';
import { go } from './router.js';
import { isExempt, sendAsOptions } from './rules.js';
import { VIEWS } from './views.js';

// ═══ SIMULATOR ═══════════════════════════════════════════════════════════════

export const backToRules = '<button type="button" class="btn quiet" data-go="policy">← Rules</button>';

VIEWS.simulator = {
  railParent: 'policy',
  flush: true,
  body: () => `<div class="chatwrap">
    <div class="chat" id="chat">
      <div class="sheet">
        <div class="toolbar" style="padding-top:0">
          ${backToRules}
          <span class="spacer"></span>
          <span class="label">Send as</span>
          <select class="inline" id="who" aria-label="Employee to send as">
            ${sendAsOptions()}
          </select>
        </div>
        ${state.chat.length
          ? state.chat.map(renderMessage).join('')
          : '<div class="empty"><b>See what Warden would do</b><span>Send a prompt as somebody on your team. It runs on their key and gets judged like anything else they send.</span></div>'}
      </div>
    </div>
    <div class="composer">
      <div class="sheet">
        <div class="hero-box">
          <textarea id="prompt" rows="2" placeholder="${state.sending ? 'Waiting for the verdict…' : 'Write a prompt as this employee…'}"${state.sending ? ' disabled' : ''}></textarea>
          <button type="button" class="btn primary send" id="send"${state.sending ? ' disabled' : ''}>${state.sending ? 'Judging…' : 'Send'}</button>
        </div>
      </div>
    </div>
  </div>`,
  bind: () => {
    const send = $('send');
    if (send) send.onclick = doSend;
    sendOnEnter($('prompt'), doSend);
    bindFollowUps();
  }
};

function renderMessage(m, i) {
  if (m.from === 'employee') {
    return `<div class="msg"><div class="who">${esc(m.who)}</div><div class="say">${esc(m.text)}</div></div>`;
  }
  // The pass list travels with the answer instead of living in a side panel —
  // same disclosure, same place in the hierarchy, as a decision in Activity.
  const slowest = Math.max(1, ...(m.passes ?? []).map((p) => p.ms ?? 0));
  const passes = (m.passes ?? []).length ? `<div class="folds">${disclosure(`s:${i}`, 'How it was decided', `
    <div>${m.passes.map((p) => passRow(p, slowest)).join('')}</div>
    <div class="note">${((m.totalMs ?? 0) / 1000).toFixed(1)}s${state.mock ? ' · demo mode' : ' · nothing left this machine'}</div>`)}</div>` : '';

  return `<div class="msg">
    <div class="who">Warden</div>
    <div class="verdict ${esc(m.verdict)}">${esc(m.label)}</div>
    ${m.why ? `<div class="why">${m.why}</div>` : ''}
    ${followUpControls(m, i)}
    ${passes}
  </div>`;
}

/**
 * Send one prompt and wait for its verdict, one at a time.
 *
 * The composer locks until the answer lands. Nothing stopped a second Enter
 * before, and the gap it opens is not theoretical: a decision costs seconds on
 * the 1.7B and was measured at 46 s on the larger adjudicator, which is a long
 * time to look at a screen that accepts more typing. Two prompts in flight
 * also arrive back in whatever order the model finishes them, so the answers
 * pair with the wrong questions in the transcript.
 */
async function doSend() {
  if (state.sending) return;
  const box = $('prompt');
  const text = box.value.trim();
  if (!text) return;
  const who = $('who').value || 'anon';
  const person = personById(who);
  box.value = '';

  state.chat.push({ from: 'employee', who: person ? `${person.name} · ${person.role}` : who, text });
  state.sending = true;
  render();

  try {
    await judge(text, person, who);
  } finally {
    state.sending = false;
    render();
  }
}

async function judge(text, person, who) {

  // The person's own API key, exactly as their laptop would send it. The
  // console deliberately has no privileged way to assert an identity — it
  // exercises the same path an employee's tool does, so a break here breaks
  // the demo too.
  const { j } = await api('/api/guard/check', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(person?.apiKey ? { authorization: `Bearer ${person.apiKey}` } : {})
    },
    body: JSON.stringify({ prompt: text, source: 'console' })
  });

  if (j?.error === 'unknown_api_key') {
    state.chat.push({ from: 'warden', verdict: 'BLOCK', label: 'Key not recognised', why: `<div>${esc(j.explanation)}</div>` });
    render();
    return;
  }

  const rule = j.firedRules?.[0];
  const exempt = person && isExempt(person.role);
  const label = exempt && j.verdict === 'ALLOW'
    ? 'Allowed without being judged'
    : ({ ALLOW: 'Allowed', BLOCK: 'Stopped', ESCALATE: 'Held for a person' }[j.verdict] ?? j.verdict);

  let why = '';
  if (exempt && j.verdict === 'ALLOW') {
    why += `<div><b>${esc(person.role)} is exempt</b>, so no rule was applied and nothing here tells you
      whether the prompt would pass. Send it as somebody the policy governs to find out.</div>`;
  }
  if (rule) {
    // A refusal that only names the rule leaves the person holding a question
    // with nowhere to take it. What they can do instead is the part that keeps
    // them working with the gateway rather than around it.
    why += `<div><b>${esc(ruleName(rule.ruleId))}:</b> ${esc(rule.ruleText)}</div>`;
    why += rule.guidance
      ? `<div><b>They are told:</b> ${esc(rule.guidance)}</div>`
      : `<div><b>Why:</b> ${esc(rule.reason)}</div>`;
    if (rule.allowedExamples?.length) {
      why += `<div><b>These would go through:</b>${rule.allowedExamples.map((x) => `<div>· ${esc(x)}</div>`).join('')}</div>`;
    }
  }
  if (j.maskedSpans?.length) why += `<div>${plural(j.maskedSpans.length, 'secret')} masked before checking.</div>`;
  if (j.quota?.limit) why += `<div>Used ${j.quota.used} of ${j.quota.limit} today.</div>`;
  if (j.auditId) why += `<div><button type="button" class="linkbtn" data-go="activity" data-sel="${attr(j.auditId)}">See the full record</button></div>`;

  // A refusal with nowhere to go is what makes people work around the gateway.
  // These two are the way out, and they belong to the employee: the console
  // shows them because the simulator is where it stands in for one.
  state.chat.push({
    from: 'warden', verdict: j.verdict, label, why,
    passes: j.passes, totalMs: j.totalMs,
    ...(j.verdict !== 'ALLOW' && j.auditId && person
      ? { followUp: { auditId: j.auditId, prompt: text, who: person.id } }
      : {})
  });
  render();
}

// ── the two ways out of a refusal ────────────────────────────────────────────

const REWRITE_REFUSAL = {
  'no-rule': 'No specific rule fired, so there is nothing to rewrite against.',
  'no-honest-rewrite': 'There is no honest rewrite of this one, because the phrasing reached for the assistant’s own instructions, and no version of that is inside the rules.',
  'too-long': 'Too long to restate. A rewrite has to be a request someone could have typed.',
  'model-unavailable': 'The model did not answer, so nothing was suggested. Nothing was spent, so you can ask again.',
  'nothing-left': 'Once the prohibited part is taken out there is no request left to make.',
  'still-blocked': 'The rewrite did not survive its own re-check, so it was not offered.',
  'already-rewritten': 'One rewrite per block, and you have used this one.'
};

/** Renders under a refusal in the simulator, on the message that owns it. */
function followUpControls(m, i) {
  if (!m.followUp) return '';
  const s = m.rewrite;
  return `<div class="group" data-follow="${i}">
    ${s?.suggestion ? `
      <div class="label">Warden suggests asking it this way</div>
      <div class="banner">${esc(s.suggestion)}</div>
      <button type="button" class="btn" data-use-rewrite="${i}">Put this in the box</button>` : ''}
    ${s?.reason ? `<div class="note">${esc(REWRITE_REFUSAL[s.reason] ?? s.reason)}</div>` : ''}
    ${m.appealed
      ? '<div class="note good">Reported. An administrator sees it in their Inbox, next to the rule that stopped you.</div>'
      : `<div class="chips">
          ${s ? '' : `<button type="button" class="btn" data-rewrite="${i}"${m.busy ? ' disabled' : ''}>${m.busy === 'rewrite' ? 'Asking…' : 'Suggest a rewrite'}</button>`}
          <button type="button" class="btn" data-appeal="${i}"${m.busy ? ' disabled' : ''}>This block was wrong</button>
        </div>
        ${m.appealOpen ? `
          <textarea id="appealNote" rows="2" placeholder="What were you actually trying to do? (optional)"></textarea>
          <button type="button" class="btn primary" data-send-appeal="${i}"${m.busy ? ' disabled' : ''}>${m.busy === 'appeal' ? 'Sending…' : 'Send the report'}</button>` : ''}
        ${m.error ? `<div class="note bad">${esc(m.error)}</div>` : ''}`}
  </div>`;
}

function bindFollowUps() {
  const at = (el) => state.chat[Number(el.dataset.rewrite ?? el.dataset.appeal ?? el.dataset.sendAppeal ?? el.dataset.useRewrite)];
  const keyOf = (m) => personById(m.followUp.who)?.apiKey;

  document.querySelectorAll('[data-rewrite]').forEach((b) => { b.onclick = () => void askRewrite(at(b)); });
  document.querySelectorAll('[data-appeal]').forEach((b) => {
    b.onclick = () => { const m = at(b); m.appealOpen = !m.appealOpen; m.error = null; render(); };
  });
  document.querySelectorAll('[data-send-appeal]').forEach((b) => { b.onclick = () => void sendAppeal(at(b)); });
  document.querySelectorAll('[data-use-rewrite]').forEach((b) => {
    b.onclick = () => { const box = $('prompt'); if (box) { box.value = at(b).rewrite.suggestion; box.focus(); } };
  });

  async function askRewrite(m) {
    m.busy = 'rewrite'; m.error = null; render();
    const { ok, j } = await api('/api/guard/rewrite', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${keyOf(m)}` },
      body: JSON.stringify({ auditId: m.followUp.auditId, prompt: m.followUp.prompt })
    });
    m.busy = null;
    // A refusal comes back as a reason rather than an error, and both 200 and
    // 409 carry one; only a shapeless failure is worth showing as an error.
    if (j?.suggestion || j?.reason) m.rewrite = { suggestion: j.suggestion ?? null, reason: j.reason ?? null };
    else if (!ok) m.error = j?.error ?? 'could not ask for a rewrite';
    render();
  }

  async function sendAppeal(m) {
    m.busy = 'appeal'; m.error = null; render();
    const note = $('appealNote')?.value.trim();
    const { ok, j } = await api('/api/guard/appeal', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${keyOf(m)}` },
      body: JSON.stringify({ auditId: m.followUp.auditId, ...(note ? { note } : {}) })
    });
    m.busy = null;
    if (!ok) { m.error = j?.error ?? 'could not send that'; render(); return; }
    m.appealed = true;
    m.appealOpen = false;
    await refreshAppeals();
    render();
  }
}
