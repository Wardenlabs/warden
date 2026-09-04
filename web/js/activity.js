/**
 * Activity: the decision log, the shape of today, and one decision opened in place.
 */
import { $, attr, esc, state } from './core.js';
import { actorName, clip, dayKey, dayLabel, hhmm, plural, ruleName, shortHash } from './format.js';
import { disclosure, render } from './render.js';
import { go } from './router.js';
import { VIEWS } from './views.js';

// ═══ ACTIVITY ════════════════════════════════════════════════════════════════

/** Held and still unanswered. The rail counts these, not the ones already dealt
 *  with — a badge that never goes down stops being read. */
export function pendingEscalations() { return state.escalations.filter((e) => !e.review); }

/**
 * The three verdicts, in words rather than in the enum.
 *
 * `ESCALATE` is what the code calls it and it is the right name there — it is
 * a position in a lattice. On a screen it is jargon: nobody outside this repo
 * knows whether an escalated request was refused, and the whole point of that
 * verdict is that it was not. What happened is that it is waiting for a
 * person, so that is what it says.
 */
export function verdictWord(v) {
  return { all: 'All', BLOCK: 'Blocked', ESCALATE: 'Held', ALLOW: 'Allowed' }[v] ?? v;
}

function visibleAudit() {
  return state.audit.filter((a) => {
    const d = a.decision ?? {};
    if (state.filter !== 'all' && d.verdict !== state.filter) return false;
    if (state.actorFilter && a.actor?.id !== state.actorFilter) return false;
    if (state.query.rule && !(d.firedRules ?? []).some((r) => r.ruleId === state.query.rule)) return false;
    return true;
  });
}

/**
 * The shape of the day, above the log.
 *
 * Opening a console should answer "do I have to do something?" before it
 * answers "what happened?". Every number here comes from the audit records
 * already loaded — there is no second surface and no new endpoint behind it.
 */
function todayCard() {
  const today = dayKey(new Date().toISOString());
  const rows = state.audit.filter((a) => dayKey(a.ts) === today);
  const stopped = rows.filter((a) => a.decision?.verdict === 'BLOCK').length;
  const waiting = pendingEscalations().length;
  const people = new Set(rows.filter((a) => a.decision?.verdict !== 'ALLOW').map((a) => a.actor?.id)).size;

  if (!rows.length) {
    return `<div class="today">
      <p class="line">Nothing has come through Warden today yet.</p>
      <div class="cta"><button type="button" class="btn" data-go="simulator">Try a prompt</button></div>
    </div>`;
  }

  return `<div class="today">
    <p class="line">Warden looked at <b>${rows.length}</b> request${rows.length === 1 ? '' : 's'} today and stopped <b>${stopped}</b>.
      ${people ? `${plural(people, 'person', 'people')} hit a rule.` : 'Nobody hit a rule.'}</p>
    ${waiting ? `<div class="cta">
      <button type="button" class="btn primary" data-go="inbox">${plural(waiting, 'request')} waiting on you</button>
    </div>` : ''}
  </div>`;
}

function decisionRows(entries, emptyState) {
  if (!entries.length) return emptyState;

  let out = '';
  let day = null;
  const counts = entries.reduce((m, a) => { const k = dayKey(a.ts); m[k] = (m[k] ?? 0) + 1; return m; }, {});

  for (const a of entries) {
    const k = dayKey(a.ts);
    if (k !== day) {
      day = k;
      out += `<div class="day">${esc(dayLabel(k))}<span class="n">${counts[k]}</span></div>`;
    }
    const d = a.decision ?? {};
    const fired = d.firedRules?.[0];
    const open = state.sel === a.auditId;

    out += `<button type="button" class="row${open ? ' on' : ''}" data-toggle="${state.view}" data-sel="${attr(a.auditId)}" aria-expanded="${open}">
      <span class="dot ${esc(d.verdict ?? '')}"></span>
      <span class="who">${esc(actorName(a.actor))}</span>
      <span class="txt">${d.maskedPrompt
        ? esc(d.maskedPrompt)
        : '<i class="nokeep" title="The audit log keeps this prompt\'s SHA-256, not its text. The console can show the text only while the gateway that judged it is still running.">not stored</i>'}</span>
      ${fired ? `<span class="rule-ref">${esc(ruleName(fired.ruleId))}</span>` : ''}
      <span class="meta">${esc(hhmm(a.ts))}</span>
    </button>`;

    if (open) out += decisionDetail(a);
  }
  return out;
}

/**
 * What happened, in one sentence, before any of the machinery.
 *
 * Assembled from fields the audit record already carries — no second model
 * call. An operations lead should be able to read this line, close the row,
 * and be correct about what Warden did.
 */
function plainSummary(entry) {
  const d = entry.decision ?? {};
  const who = esc(actorName(entry.actor));
  // Without this the sentence reads: asked “”. The record kept the hash and
  // not the text, and saying so is better than quoting nothing as if it were
  // the prompt.
  const asked = d.maskedPrompt
    ? `“${esc(clip(d.maskedPrompt, 130))}”`
    : 'something this record no longer holds the text of';
  const rule = d.firedRules?.[0];

  if (d.verdict === 'ALLOW') {
    return `<b>${who}</b> asked ${asked}, and Warden let it through, because nothing in the policy applies to it.`;
  }
  if (!rule) {
    // No rule fired, so the only account of the refusal is the explanation the
    // guard wrote. It is multi-line and one of its lines names the structural
    // signal — invisible characters, faked conversation turns, phrasing aimed
    // at the instruction layer. Without this the panel says a person was
    // stopped and offers nothing to point at, which is exactly the failure the
    // policy-is-the-authority rule exists to prevent.
    const flagged = String(d.explanation ?? '').split('\n').find((l) => l.startsWith('Also flagged:'));
    const signal = flagged ? flagged.replace(/^Also flagged:\s*/, '').replace(/\.\s*$/, '') : '';
    if (d.verdict === 'ESCALATE') {
      return `<b>${who}</b> asked ${asked}. No rule matched it, but Warden noticed ${
        signal ? `<b>${esc(signal)}</b>` : 'something structural in the text'
      } and queued it for a person. They have not been refused; they are waiting.`;
    }
    return `<b>${who}</b> asked ${asked}, and Warden stopped it${
      signal ? ` after noticing <b>${esc(signal)}</b>` : ''
    }. No rule in the policy matched it.`;
  }
  const name = esc(ruleName(rule.ruleId));
  // The guidance stays out of this sentence on purpose. It is often three lines
  // long, and a lead that runs to six lines is no longer a lead.
  return d.verdict === 'BLOCK'
    ? `<b>${who}</b> asked ${asked}. The <b>${name}</b> rule forbids that, so Warden stopped it.`
    : `<b>${who}</b> asked ${asked}. The <b>${name}</b> rule says this needs a person to sign off, so Warden is holding it.`;
}

/**
 * @param entry the audit record
 * @param head  markup spliced in above the summary. The Inbox uses it to lead
 *              with what a person said about this decision, which is the part
 *              the log cannot tell you.
 */
export function decisionDetail(entry, head = '') {
  const d = entry.decision ?? {};
  const slowest = Math.max(1, ...(d.passes ?? []).map((p) => p.ms ?? 0));
  const guidance = d.firedRules?.[0]?.guidance;

  // Latency lives here and only here — this is the section about how it ran.
  // "None of it left this machine" is the conclusion of the same paragraph,
  // which is a better home for that claim than a light in a corner.
  const passes = `<div>${(d.passes ?? []).map((p) => passRow(p, slowest)).join('')}
    <div class="note">${((d.totalMs ?? 0) / 1000).toFixed(1)}s${state.mock ? ' · demo mode' : ' · nothing left this machine'}</div>`;

  const chain = `<div class="chain">
      <div class="link"><span>previous</span><b>${esc(shortHash(entry.prevHash))}</b></div>
      <div class="rail-line"></div>
      <div class="link"><span class="dot ${state.chain?.ok ? 'ALLOW' : 'BLOCK'}"></span><b>${esc(shortHash(entry.entryHash))}</b><span>this one</span></div>
    </div>
    <div class="note">${state.chain?.ok
      ? `All ${state.chain.entries} records still match their hashes.`
      : 'This log no longer verifies: a record was altered or removed after it was written.'}</div>`;

  const record = `<div class="kv">
      <div class="r"><span class="k">Audit id</span><span class="v mono">${esc(entry.auditId)}</span></div>
      <div class="r"><span class="k">Exact time</span><span class="v mono">${esc(entry.ts)}</span></div>
      <div class="r"><span class="k">Policy</span><span class="v mono">${esc(shortHash(d.policyVersion))}</span></div>
      ${d.quota?.limit ? `<div class="r"><span class="k">Daily use</span><span class="v num">${d.quota.used} of ${d.quota.limit}</span></div>` : ''}
      ${d.maskedSpans?.length ? `<div class="r"><span class="k">Masked</span><span class="v">${plural(d.maskedSpans.length, 'secret')} removed before checking</span></div>` : ''}
      ${(d.firedRules ?? []).map((r) => `
        <div class="r"><span class="k">${esc(r.ruleId)}</span><span class="v">${esc(r.reason)} · confidence ${r.confidence ?? '—'}</span></div>`).join('')}
    </div>`;

  return `<div class="detail">
    ${head}
    <div class="detail-head">
      <span class="badge ${esc(d.verdict)}">${esc(d.verdict)}</span>
      <span class="when">${esc(hhmm(entry.ts))} · ${esc(dayLabel(dayKey(entry.ts)).toLowerCase())}</span>
    </div>

    <p class="summary">${plainSummary(entry)}</p>

    ${guidance ? `<div class="group">
      <div class="label">What Warden told them to do instead</div>
      <div class="banner">${esc(guidance)}</div>
    </div>` : ''}

    <div class="group">
      <div class="label">What they sent</div>
      <pre class="code">${esc(d.maskedPrompt || '—')}</pre>
    </div>

    ${(d.firedRules ?? []).length ? `
      <div class="group">
        <div class="label">Rule${d.firedRules.length > 1 ? 's' : ''} behind it</div>
        ${d.firedRules.map((r) => `
          <button type="button" class="ruleref" data-go="policy" data-sel="${attr(r.ruleId)}">
            <span class="dot ${esc(r.severity)}"></span>
            <span class="col">
              <span class="t">${esc(ruleName(r.ruleId))}</span>
              <span class="m">${esc(clip(r.ruleText, 130))}</span>
            </span>
          </button>`).join('')}
      </div>` : ''}

    <div class="folds">
      ${disclosure('d:passes', 'How it was decided', passes)}
      ${disclosure('d:chain', 'Proof this record has not been altered', chain)}
      ${disclosure('d:record', 'Technical record', record)}
    </div>
  </div>`;
}

/**
 * One row of the pass table, and the reason when the row failed closed.
 *
 * `adjudicateAll` has always recorded why a pass threw, in `detail.error`, and
 * nothing has ever rendered it. So the guard would fail closed correctly, the
 * decision would read "rule could not be evaluated, escalated rather than
 * assumed clean", and the sentence that says whether the model timed out or the
 * worker never started sat in the record with no way to see it. Somebody whose
 * models are installed and whose rules still will not evaluate could not find
 * out why from the screen telling them it happened.
 *
 * Shown only when the pass actually failed: a healthy run keeps the tight table
 * it had.
 */
export function passRow(p, slowest) {
  const why = p.failedClosed && p.detail?.error ? String(p.detail.error) : '';
  return `<div class="pass">
      <span class="n">${esc(p.pass)}${p.failedClosed ? ' ⚠' : ''}</span>
      <span class="v ${esc(p.verdict ?? '')}">${esc(p.verdict ?? '')}</span>
      <span class="track"><i style="width:${Math.round(((p.ms ?? 0) / slowest) * 100)}%"></i></span>
      <span class="ms">${p.ms ?? 0}ms</span>
    </div>${why ? `<div class="pass-why">${esc(why)}</div>` : ''}`;
}

/** Filters live with the list they filter, not in the app chrome. */
function activityToolbar() {
  const opts = state.company.employees
    .map((e) => `<option value="${esc(e.id)}"${state.actorFilter === e.id ? ' selected' : ''}>${esc(e.name)}</option>`).join('');
  return `<div class="toolbar">
    <span class="seg" id="verdictSeg">
      ${['all', 'BLOCK', 'ESCALATE', 'ALLOW'].map((v) => `
        <button type="button" data-v="${v}" class="${state.filter === v ? 'on' : ''}">${verdictWord(v)}</button>`).join('')}
    </span>
    <select class="inline" id="actorFilter" aria-label="Filter by person">
      <option value="">Everyone</option>${opts}
    </select>
    ${state.query.rule ? `<button type="button" class="chip on" id="clearRule">${esc(ruleName(state.query.rule))} ✕</button>` : ''}
    <span class="spacer"></span>
    <span class="note">${visibleAudit().length} of ${state.audit.length}</span>
  </div>`;
}

function bindActivity() {
  const seg = $('verdictSeg');
  if (seg) seg.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.filter = b.dataset.v;
    render();
  };
  const sel = $('actorFilter');
  if (sel) sel.onchange = (e) => { state.actorFilter = e.target.value; render(); };
  const cr = $('clearRule');
  if (cr) cr.onclick = () => go('activity');
}

VIEWS.activity = {
  bind: bindActivity,
  body: () => {
    const rows = visibleAudit();
    const filtered = rows.length !== state.audit.length;
    return `<div class="sheet">
      ${filtered ? '' : todayCard()}
      ${activityToolbar()}
      ${decisionRows(rows, '<div class="empty"><b>Nothing matches</b><span>Nothing in the log matches. Drop a filter.</span></div>')}
    </div>`;
  }
};
