/**
 * Test: send a request against the active rules as somebody on the team, or against one draft before it is saved.
 */
import { passRow } from './activity.js';
import { readable } from './answers.js';
import { $, attr, esc, post, state } from './core.js';
import { refreshAppeals } from './data.js';
import {
  bindDocuments, clearDocuments, documentAnalysisNotice, documentAttachButton, documentChips, documentFeedback,
  documentMetadataMarkup, documentReviewPendingMarkup, documentsBusy, loadDocumentCapabilities, selectedAttachments, selectedMetadata
} from './documents.js';
import { audienceLabel, fileSize, personById, plural, ruleName, sendOnEnter } from './format.js';
import { disclosure, render } from './render.js';
import { isExempt, sendAsOptions } from './rules.js';
import { button, fileChip, listState, pageHead, turn } from './ui.js';
import { VIEWS } from './views.js';

// ═══ TEST ════════════════════════════════════════════════════════════════════

/**
 * Two things are called testing here, and they are different questions.
 *
 * "Test rules →" asks what the gateway does with a request: it is sent with a
 * person's own key through `/api/guard/check`, the same path their tool takes,
 * against every active rule, documents included, and it is recorded like any
 * other request. That is the engine this module has always had.
 *
 * "Test rule" from an edit or a draft asks what one unsaved rule would do.
 * The gateway has no way to judge a request against a rule that is not in the
 * policy except `/api/policy/preview`, which takes text and no files and runs
 * the rule's own examples beside it. So a draft is tested on text, the file
 * button is not offered, and nothing is recorded. The frames drew one screen
 * for both; the API decides which one is true
 * (docs/specs/console-redesign-v2-api-gaps.md).
 */
const draftMode = () => state.query?.draft === '1' && Boolean(state.testDraft);

VIEWS.simulator = {
  railParent: 'policy',
  onEnter: loadDocumentCapabilities,
  flush: true,
  body: () => (draftMode() ? draftBody() : policyBody()),
  bind: () => {
    if (draftMode()) bindDraft(); else bindPolicyTest();
    bindThread();
  }
};

// ── shared pieces ────────────────────────────────────────────────────────────

const seconds = (ms) => `${(Math.max(0, ms ?? 0) / 1000).toFixed(1)} s`;
const where = () => (state.mock ? 'demo mode' : 'nothing left this machine');

function verdictCard({ tone, glyph, title, meta, line, kicker, reason, extra = '', foot = '', muted = false }) {
  return `<div class="warden-label">Warden</div>
    <article class="turn --warden verdict-card${muted ? ' --previous' : ''}">
      <div class="verdict-head"><h3 class="verdict-title --${tone}">${glyph ? `<span aria-hidden="true">${glyph}</span> ` : ''}${esc(title)}</h3><span class="verdict-meta">${esc(meta)}</span></div>
      <p class="verdict-line">${line}</p>
      ${kicker ? `<span class="kicker">${esc(kicker)}</span><div class="verdict-reason">${reason}</div>` : ''}
      ${extra}
      ${foot ? `<div class="verdict-foot">${foot}</div>` : ''}
    </article>`;
}

function personTurn(m) {
  const files = (m.documents ?? []).map((d) => fileChip(d.name, fileSize(d.bytes ?? 0))).join('');
  return turn('person', { who: m.who ? esc(m.who) : '', body: `${m.text ? `<div>${esc(m.text)}</div>` : ''}${files ? `<div class="labels">${files}</div>` : ''}`, end: true });
}

function emptyLine(text) {
  return `<div class="thread-empty">${esc(text)}</div>`;
}

function tries(items) {
  return items.length ? `<div class="suggestions">${items.map(([label, value, file]) => `<button type="button" class="suggestion" data-try="${esc(value)}"${file ? ' data-try-file="1"' : ''}>Try: ${esc(label)}</button>`).join('')}</div>` : '';
}

function bindThread() {
  for (const t of document.querySelectorAll('[data-try]')) t.onclick = () => {
    const box = $('prompt');
    if (!box || box.disabled) return;
    box.value = t.dataset.try;
    box.dispatchEvent(new Event('input'));
    box.focus();
    if (t.dataset.tryFile) $('documentFiles')?.click();
  };
  const box = $('prompt');
  const send = $('send');
  if (box && send) {
    const sync = () => { if (!box.disabled && !send.classList.contains('--busy')) send.disabled = (!box.value.trim() && !selectedAttachments().length) || documentsBusy() || send.dataset.blocked === '1'; };
    box.addEventListener('input', sync);
    sync();
  }
}

// ── the active rules, as a person ────────────────────────────────────────────

let sendAs = '';

function policyBody() {
  const people = state.company.employees;
  if (!people.some((p) => p.id === sendAs)) {
    sendAs = [...people].sort((a, b) => Number(isExempt(a.role)) - Number(isExempt(b.role)))[0]?.id ?? '';
  }
  const who = personById(sendAs);
  const rules = state.policy.rules.length;
  const head = `${pageHead({ title: 'Test rules', crumbs: [{ label: 'Rules', go: 'policy' }] })}
    <div class="test-subject">
      <p class="test-meta">${people.length
        ? `<label for="who">Send as</label><select id="who" class="select-inline" aria-label="Send as">${sendAsOptions(sendAs)}</select><span>${plural(rules, 'active rule')}</span>`
        : 'Nobody to send as yet'}</p>
    </div>`;

  if (!people.length) {
    return `<div class="chatwrap --centred"><div class="sheet flush-head">${head}</div><div class="chat"><div class="thread">
      ${listState({ title: 'Set up an identity to check requests', body: 'Choose who Warden should check as. Protect this device to create your own identity, or add people to your team.', action: button('Set up this device', { kind: 'primary', attrs: 'data-go="soloRules"' }) + button('Add people', { attrs: 'data-go="people"' }) })}
    </div></div></div>`;
  }

  const thread = state.chat.length
    ? state.chat.map(renderMessage).join('') + documentReviewPendingMarkup(state.chat.at(-1)?.documents, state.sending && state.chat.at(-1)?.from === 'employee')
    : emptyLine('No tests yet.');

  return `<div class="chatwrap --centred${state.chat.length ? '' : ' --test-empty'}">
    <div class="sheet flush-head">${head}</div>
    <div class="chat" id="chat"><div class="thread">${thread}${who && isExempt(who.role) ? `<p class="thread-note">${esc(who.name)} is ${esc(who.role)}, exempt from company-wide rules: only rules that name them are applied.</p>` : ''}</div></div>
    <div class="chat-foot"><div class="thread">
      <div class="composer --files" id="documentDropzone">
        <textarea id="prompt" rows="1" aria-label="Request to test" placeholder="${state.sending ? 'Waiting for the verdict…' : 'Write or paste a request to test…'}"${state.sending ? ' disabled' : ''}></textarea>
        ${documentChips()}
        <div class="composer-row">${documentAttachButton()}<span class="composer-fill"></span>
          <button type="button" class="btn --primary${state.sending ? ' --busy' : ''}" id="send"${state.sending || documentsBusy() ? ' disabled' : ''}>${state.sending ? 'Checking…' : 'Run test'}</button></div>
      </div>
      ${documentFeedback()}
    </div></div>
  </div>`;
}

function bindPolicyTest() {
  const who = $('who');
  if (who) who.onchange = () => { sendAs = who.value; render(); };
  const send = $('send');
  if (send) send.onclick = doSend;
  sendOnEnter($('prompt'), doSend);
  bindDocuments();
  bindFollowUps();
}

const LABEL = { ALLOW: ['allow', '✓', 'Allowed'], BLOCK: ['block', '⊘', 'Blocked'], ESCALATE: ['attention', '↗', 'Held for review'] };

export function resultTitle(message, fallback) {
  if (message.exemptAllow) return 'Allowed without being judged';
  if (message.warningCount) return 'Allowed with warnings';
  return fallback;
}

function renderMessage(m, i) {
  if (m.from === 'employee') return personTurn(m);
  if (m.verdict === 'error') {
    return verdictCard({
      tone: 'block', glyph: '⚠', title: 'The test did not finish', meta: 'not checked',
      line: esc(m.error ?? 'The gateway could not check this request.'),
      kicker: 'What to do', reason: `Your request${m.hadFiles ? ' and files are' : ' is'} back in the box below. Try again after other checks finish.`,
      foot: `<span></span>${button('Check the analyzer in Models →', { attrs: 'data-go="models"' })}`
    });
  }
  const [tone, glyph, word] = LABEL[m.verdict] ?? ['muted', '', m.verdict];
  const docs = m.documents ?? [];
  const read = docs.filter((d) => d.status === 'read').length;
  const masked = (m.maskedSpans ?? 0) + docs.reduce((n, d) => n + (d.redactions ?? 0), 0);
  const docSummary = docs.length ? [read === docs.length ? 'Read completely' : `${read} of ${docs.length} read`, docs.reduce((n, d) => n + (d.pages ?? 0), 0) ? plural(docs.reduce((n, d) => n + (d.pages ?? 0), 0), 'page') : '', masked ? plural(masked, 'secret') + ' masked' : ''].filter(Boolean).join(' · ') : '';
  const passes = (m.passes ?? []).length
    ? disclosure(`s:${i}`, 'How it was decided', `<div class="passes">${m.passes.map((p) => passRow(p, Math.max(1, ...m.passes.map((x) => x.ms ?? 0)))).join('')}</div>`, `${plural(m.passes.length, 'pass', 'passes')} · ${seconds(m.totalMs)} · ${where()}`)
    : '';
  return verdictCard({
    tone, glyph,
    title: resultTitle(m, word),
    meta: `${seconds(m.totalMs)} · ${where()}`,
    line: m.line,
    kicker: m.kicker, reason: m.why,
    extra: `${m.notice ?? ''}${m.extraFacts ?? ''}${followUpControls(m, i)}${m.showReport ? `<div class="extraction-report">${documentMetadataMarkup(docs)}</div>` : ''}${passes ? `<div class="disclosures">${passes}</div>` : ''}`,
    foot: `<span>${esc(docSummary)}</span><span class="btn-row">${m.auditId ? button('See the full record →', { kind: 'link', attrs: `data-go="activity" data-sel="${attr(m.auditId)}"` }) : ''}${docs.length ? button(m.showReport ? 'Hide extraction report' : 'View extraction report →', { attrs: `data-report="${i}"` }) : ''}</span>`
  });
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
  if (state.sending || documentsBusy()) return;
  const box = $('prompt');
  const text = box.value.trim();
  const attachments = selectedAttachments();
  if (!text && !attachments.length) { box.focus(); return; }
  const who = $('who')?.value || sendAs;
  const person = personById(who);
  // Missing identity must not fall through to the console's administrator
  // credential and accidentally exercise the policy's exempt path.
  if (!person?.apiKey) { $('who')?.focus(); return; }
  box.value = '';

  state.chat.push({ from: 'employee', who: `${person.name} · ${person.role}`, text, documents: selectedMetadata() });
  state.sending = true;
  state.followChat = true;
  render();

  try {
    if (await judge(text, person, attachments)) clearDocuments();
    else if ($('prompt')) $('prompt').value = text;
  } catch {
    state.chat.push({ from: 'warden', verdict: 'error', error: 'Warden could not be reached. Your files are still attached. Check the gateway connection and try again.', hadFiles: attachments.length > 0 });
    if ($('prompt')) $('prompt').value = text;
  } finally {
    state.sending = false;
    state.followChat = true;
    render();
    if ($('prompt') && !$('prompt').value) $('prompt').value = state.chat.at(-1)?.verdict === 'error' ? text : '';
    $('prompt')?.focus();
  }
}

async function judge(text, person, attachments) {
  // The person's own API key, exactly as their laptop would send it. The
  // console deliberately has no privileged way to assert an identity — it
  // exercises the same path an employee's tool does, so a break here breaks
  // the demo too.
  const { ok, j } = await post('/api/guard/check', { prompt: text, source: 'console', ...(attachments.length ? { attachments } : {}) }, {
    headers: person?.apiKey ? { authorization: `Bearer ${person.apiKey}` } : {}
  });

  if (j?.error === 'unknown_api_key') {
    state.chat.push({ from: 'warden', verdict: 'BLOCK', line: 'Key not recognised.', kicker: 'Why', why: esc(j.explanation) });
    return false;
  }

  if (!ok || !['ALLOW', 'ESCALATE', 'BLOCK'].includes(j?.verdict)) {
    state.chat.push({ from: 'warden', verdict: 'error', error: typeof j?.error === 'string' ? j.error : 'The gateway could not check this request. Review the files and try again.', hadFiles: attachments.length > 0 });
    return false;
  }

  const exempt = isExempt(person.role);
  const exemptAllow = exempt && j.verdict === 'ALLOW';
  const presentation = policyDecisionPresentation(j, person, exemptAllow);
  const facts = [
    j.maskedSpans?.length ? `${plural(j.maskedSpans.length, 'secret')} masked before checking.` : '',
    j.quota?.limit ? `Used ${j.quota.used} of ${j.quota.limit} today.` : ''
  ].filter(Boolean);

  // A refusal with nowhere to go is what makes people work around the gateway.
  // These two are the way out, and they belong to the employee: the console
  // shows them because the tester is where it stands in for one.
  state.chat.push({
    from: 'warden', verdict: j.verdict, exemptAllow, ...presentation,
    notice: documentAnalysisNotice(j) ? `<div class="verdict-notice">${documentAnalysisNotice(j)}</div>` : '',
    extraFacts: facts.length ? `<p class="verdict-aside">${facts.join(' ')}</p>` : '',
    passes: j.passes, totalMs: j.totalMs, documents: j.documents, maskedSpans: j.maskedSpans?.length ?? 0, auditId: j.auditId,
    ...(j.verdict !== 'ALLOW' && j.auditId ? { followUp: { auditId: j.auditId, prompt: text, who: person.id, hasDocuments: Boolean(attachments.length) } } : {})
  });
  return true;
}

/** The result copy is derived from the decision, including non-blocking warnings. */
export function policyDecisionPresentation(j, person, exemptAllow = false) {
  const warnings = j.warnings ?? [];
  const rule = j.firedRules?.[0] ?? warnings[0];
  const first = person.name.split(' ')[0];
  const line = exemptAllow
    ? `<b>${esc(person.role)} is exempt from company-wide rules</b>, so none of those were applied and nothing here tells you whether the request would pass. Send it as somebody the policy governs to find out.`
    : { BLOCK: `The active rules stop this request from ${esc(first)}. It was checked like a real one and is in Activity.`,
      ESCALATE: `The active rules hold this request for a person to review. It is waiting in your Inbox like a real one.`,
      ALLOW: warnings.length
        ? `${plural(warnings.length, 'warning')} matched. The request would still go through.`
        : `Nothing in the active rules stops this request from ${esc(first)}. It would go through.` }[j.verdict];
  let why = '';
  let kicker = '';
  if (rule) {
    kicker = j.verdict === 'ESCALATE' ? 'Why it needs a person' : j.verdict === 'BLOCK' ? 'Why it matches' : 'Warnings';
    const shown = j.verdict === 'ALLOW' ? warnings : [rule];
    why = shown.map((item) => `<p><b>${esc(ruleName(item.ruleId))}:</b> ${esc(item.guidance || item.reason)}</p>`).join('');
    if (rule.allowedExamples?.length) why += `<p class="verdict-aside">These would go through: ${rule.allowedExamples.map((x) => `“${esc(x)}”`).join(' · ')}</p>`;
  } else if (j.verdict !== 'ALLOW' && j.explanation) {
    kicker = 'Why';
    why = `<p>${esc(j.explanation)}</p>`;
  }
  return { warningCount: warnings.length, line, kicker, why };
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

/** Renders under a refusal, on the message that owns it. */
function followUpControls(m, i) {
  if (!m.followUp) return '';
  const s = m.rewrite;
  return `<div class="follow-up" data-follow="${i}">
    ${s?.suggestion ? `<span class="kicker">Warden suggests asking it this way</span><p class="verdict-reason">${esc(s.suggestion)}</p>
      <div>${button('Put this in the box', { compact: true, attrs: `data-use-rewrite="${i}"` })}</div>` : ''}
    ${s?.reason ? `<p class="verdict-aside">${esc(REWRITE_REFUSAL[s.reason] ?? s.reason)}</p>` : ''}
    ${m.appealed
      ? '<p class="verdict-aside --allow">Reported. An administrator sees it in their Inbox, next to the rule that stopped you.</p>'
      : `<div class="btn-row">
          ${s || m.followUp.hasDocuments ? '' : button(m.busy === 'rewrite' ? 'Asking…' : 'Suggest a rewrite', { compact: true, attrs: `data-rewrite="${i}"`, disabled: Boolean(m.busy) })}
          ${button('This block was wrong', { compact: true, attrs: `data-appeal="${i}"`, disabled: Boolean(m.busy) })}
        </div>
        ${m.followUp.hasDocuments ? '<p class="verdict-aside">To revise a document request, update the file and check it again.</p>' : ''}
        ${m.appealOpen ? `<div class="field"><label for="appealNote">What were you actually trying to do? <span class="optional">(optional)</span></label>
          <textarea id="appealNote" rows="2"></textarea></div>
          <div>${button(m.busy === 'appeal' ? 'Sending…' : 'Send the report', { kind: 'primary', compact: true, attrs: `data-send-appeal="${i}"`, disabled: Boolean(m.busy) })}</div>` : ''}
        ${m.error ? `<p class="verdict-aside --block">${esc(m.error)}</p>` : ''}`}
  </div>`;
}

function bindFollowUps() {
  const at = (el) => state.chat[Number(el.dataset.rewrite ?? el.dataset.appeal ?? el.dataset.sendAppeal ?? el.dataset.useRewrite ?? el.dataset.report)];
  const keyOf = (m) => personById(m.followUp.who)?.apiKey;

  document.querySelectorAll('[data-report]').forEach((b) => { b.onclick = () => { const m = at(b); m.showReport = !m.showReport; state.keepScroll = true; render(); }; });
  document.querySelectorAll('[data-rewrite]').forEach((b) => { b.onclick = () => void askRewrite(at(b)); });
  document.querySelectorAll('[data-appeal]').forEach((b) => {
    b.onclick = () => { const m = at(b); m.appealOpen = !m.appealOpen; m.error = null; state.keepScroll = true; render(); };
  });
  document.querySelectorAll('[data-send-appeal]').forEach((b) => { b.onclick = () => void sendAppeal(at(b)); });
  document.querySelectorAll('[data-use-rewrite]').forEach((b) => {
    b.onclick = () => { const box = $('prompt'); if (box) { box.value = at(b).rewrite.suggestion; box.dispatchEvent(new Event('input')); box.focus(); } };
  });

  async function askRewrite(m) {
    m.busy = 'rewrite'; m.error = null; render();
    const { ok, j } = await post('/api/guard/rewrite', { auditId: m.followUp.auditId, prompt: m.followUp.prompt }, { headers: { authorization: `Bearer ${keyOf(m)}` } });
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
    const { ok, j } = await post('/api/guard/appeal', { auditId: m.followUp.auditId, ...(note ? { note } : {}) }, { headers: { authorization: `Bearer ${keyOf(m)}` } });
    m.busy = null;
    if (!ok) { m.error = j?.error ?? 'could not send that'; render(); return; }
    m.appealed = true;
    m.appealOpen = false;
    await refreshAppeals();
    render();
  }
}

// ── one draft, before it is saved ────────────────────────────────────────────

/**
 * The thread of tests for one draft, kept per draft so going back to edit and
 * returning finds it. Each result is tagged with the draft version it ran
 * against; when the draft changes, older results stay readable and say whose
 * they are, because a verdict about v2 is not a verdict about v3.
 */
const draftThreads = new Map();
const draftKey = () => `${state.testDraft.back.sel}|${state.testDraft.rule.id}`;
const threadOf = () => {
  const key = draftKey();
  if (!draftThreads.has(key)) draftThreads.set(key, []);
  return draftThreads.get(key);
};

const DRAFT_VERDICT = {
  BLOCK: { tone: 'block', glyph: '⊘', title: 'Would block', line: 'This draft matches the test input. No live request was blocked.', kicker: 'Why it matches' },
  ESCALATE: { tone: 'attention', glyph: '↗', title: 'Would escalate', line: 'This draft would hold the request for a person to review. Nothing is sent on until someone decides.', kicker: 'Why it needs a person' },
  ALLOW: { tone: 'allow', glyph: '●', title: 'Would allow', line: 'This draft does not match the test input. The request would go through.', kicker: 'Why it passes' }
};

function draftBody() {
  const t = state.testDraft;
  const thread = threadOf();
  const tested = thread.some((m) => m.from === 'warden');
  const last = [...thread].reverse().find((m) => m.from === 'warden');
  const stale = last && last.version !== t.version;
  const aud = audienceLabel(t.rule.appliesTo).replace(/^everyone$/, 'Everyone');
  const meta = stale
    ? `Current draft v${t.version} · not tested · the active rule is unchanged.`
    : tested ? `Draft v${t.version} · Applies to ${aud} · Simulation only. The active rule is unchanged.`
      : t.unsaved ? 'Testing unsaved changes · The active rule is unchanged.' : 'Testing the saved rule · Nothing is changed or recorded.';

  let lastVersion = null;
  const items = thread.map((m) => {
    let divider = '';
    if (m.from === 'you' && lastVersion !== null && m.version !== lastVersion) divider = `<div class="thread-divider">Draft changed · v${lastVersion} → v${m.version} · previous results belong to v${lastVersion}</div>`;
    if (m.from === 'you') lastVersion = m.version;
    return divider + (m.from === 'you' ? personTurn(m) : draftVerdict(m, t));
  }).join('');
  const staleNote = stale ? `<div class="thread-divider">Draft changed · the result below belongs to v${last.version}</div>` : '';
  const examples = t.rule.examples ?? {};

  return `<div class="chatwrap">
    <div class="sheet flush-head">
      ${pageHead({
        title: 'Test rule',
        crumbs: [{ label: t.back.label, go: t.back.view, sel: t.back.sel }],
        quiet: button(state.open.has('t:instruction') ? 'Hide instruction' : 'View instruction', { kind: 'link', id: 'viewInstruction' })
      })}
      <div class="test-subject">
        <h2 class="section-title --big">${esc(ruleName(t.rule))}</h2>
        <p class="test-meta">${esc(meta)}</p>
        ${state.open.has('t:instruction') ? `<p class="test-instruction">${esc(t.rule.text)}</p>` : ''}
      </div>
      <hr class="hairline">
    </div>
    <div class="chat" id="chat"><div class="thread">
      ${thread.length ? (stale ? staleNote : '') + items : emptyLine('No tests yet. Send a request to see what this draft would do. A draft is tested on text; files are checked against saved rules from Test rules.')}
      ${state.sending ? `<div class="warden-label">Warden</div>${turn('warden', { body: '<b class="turn-title">Checking the request against this draft…</b><span class="turn-note">The draft is judged on this machine, beside its own examples. A busy analyzer can take a minute.</span>' })}` : ''}
    </div></div>
    <div class="chat-foot"><div class="thread">
      ${thread.length ? '' : tries([examples.violating?.[0], examples.compliant?.[0]].filter(Boolean).map((x) => [`“${x}”`, x]))}
      <div class="composer">
        <textarea id="prompt" rows="1" aria-label="Request to test" placeholder="${state.sending ? 'Waiting for the verdict…' : 'Write or paste a request to test…'}"${state.sending ? ' disabled' : ''}></textarea>
        <div class="composer-row"><span class="composer-fill"></span>
          <button type="button" class="btn --primary${state.sending ? ' --busy' : ''}" id="send"${state.sending ? ' disabled' : ''}>${state.sending ? 'Checking…' : stale ? 'Test current draft' : 'Run test'}</button></div>
      </div>
    </div></div>
  </div>`;
}

function draftVerdict(m, t) {
  if (m.error) {
    return verdictCard({
      tone: 'block', glyph: '⚠', title: 'The test did not finish', meta: `${seconds(m.ms)} · failed`,
      line: `${esc(m.error)} Not every example was checked, so nothing was cleared.`,
      kicker: 'What to do', reason: 'Your request is back in the box below. Try again after other checks finish.',
      foot: `<span>Policy analysis did not finish</span>${button('Check the analyzer in Models →', { attrs: 'data-go="models"' })}`
    });
  }
  const v = DRAFT_VERDICT[m.verdict] ?? DRAFT_VERDICT.ALLOW;
  const previous = m.version !== t.version;
  // `preview` reports a firing warn rule as ALLOW, which is the verdict the
  // live guard would give; whether the warning would be attached is not in
  // what it returns, so the card says that instead of guessing.
  const warnNote = m.severity === 'warn' && m.verdict === 'ALLOW'
    ? '<p class="verdict-aside">A warn rule never blocks or holds a request. This simulation cannot tell whether the warning would be shown.</p>' : '';
  return verdictCard({
    tone: previous ? 'muted' : v.tone, glyph: previous ? '' : v.glyph,
    title: previous ? `Previous result · draft v${m.version}` : v.title,
    meta: `${seconds(m.ms)} · ${where()}`,
    line: previous ? `Draft v${m.version} ${v.title.toLowerCase()} this request.<br>This result does not describe the current draft.` : v.line,
    kicker: v.kicker, reason: `<p>${esc(m.reason || 'The judge gave no reason.')}</p>`,
    extra: warnNote,
    muted: previous
  });
}

function bindDraft() {
  const t = state.testDraft;
  const view = $('viewInstruction');
  if (view) view.onclick = () => { if (state.open.has('t:instruction')) state.open.delete('t:instruction'); else state.open.add('t:instruction'); render(); };
  const send = async () => {
    if (state.sending) return;
    const box = $('prompt');
    const text = box.value.trim();
    if (!text) { box.focus(); return; }
    const thread = threadOf();
    thread.push({ from: 'you', text, version: t.version });
    box.value = '';
    state.sending = true;
    state.followChat = true;
    render();
    const started = performance.now();
    const { ok, j } = await post('/api/policy/preview', { rule: t.rule, against: [{ prompt: text, expected: 'ALLOW' }] })
      .catch(() => ({ ok: false, j: { error: 'Warden could not be reached.' } }));
    const ms = performance.now() - started;
    const row = ok ? j.rows?.find((r) => r.source === 'log') : null;
    state.sending = false;
    state.followChat = true;
    if (row) thread.push({ from: 'warden', verdict: row.verdict, reason: row.reason, ms, version: t.version, severity: t.rule.severity });
    else thread.push({ from: 'warden', error: readable(j?.error ?? 'The check did not return a result for this request.'), ms, version: t.version });
    render();
    if (!row && $('prompt')) $('prompt').value = text;
    $('prompt')?.focus();
  };
  if ($('send')) $('send').onclick = send;
  sendOnEnter($('prompt'), send);
}
