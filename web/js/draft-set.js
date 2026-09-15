/**
 * A compiled set: the rules one broad instruction became, all on screen.
 *
 * `draft.js` owns the conversation and the single draft card; this module
 * owns the list that a set becomes — its cards, the check that runs down
 * them one by one, and the buttons that ratify one card or all of them.
 * Lifting one card out to be edited hands it back to `draft.js` as the
 * single draft, and activating it there hands it back here as an active
 * card, so the two files share `state.set` and nothing else.
 */
import { $, esc, post, state } from './core.js';
import { refreshPeople, refreshPolicy } from './data.js';
import { audienceLabel, plural } from './format.js';
import { disclosure, render } from './render.js';
import { go } from './router.js';
import { checkRowsOf, discardDraft, examplesFold, resetDraft, say, startDraftAudience, verdictLine } from './draft.js';

/**
 * The set: every rule one instruction became, as a list of cards.
 *
 * Each card carries its own check, its own Activate and its own Discard, and
 * "Edit alone" lifts it into the single-rule conversation above when it needs
 * rewording. The button at the top ratifies every card still on the list, after
 * a confirm that lists what is about to bind whom — that dialog is the reading
 * the old queue was trying to force one rule at a time.
 */
export function setCards() {
  const set = state.set;
  const items = set.items;
  const open = items.filter((it) => it.status !== 'active' && it.status !== 'editing');
  const active = items.filter((it) => it.status === 'active').length;
  const editing = items.length - active - open.length;
  const checking = items.some((it) => it.status === 'checking' || it.status === 'pending');
  // In demo mode the checks came from the stand-in and a "missed" there is
  // not a finding; the verdict line on each card already says so, and a hint
  // up here that contradicted it was read as the rule being wrong.
  const worrying = state.mock ? 0 : open.filter((it) => it.preview && (it.preview.falsePositives > 0 || it.preview.misses > 0)).length;

  const head = `<div class="artifact set-head">
    <div class="detail-head">
      <b>${plural(items.length, 'rule')} from that instruction</b>
      <span class="when">${active} active · ${open.length} waiting${editing ? ` · ${editing} being edited above` : ''}</span>
    </div>
    ${open.length ? `<div class="chips">
      <button type="button" class="btn --primary" id="ratifyAll"${state.ruleBusy || checking ? ' disabled' : ''}>
        ${checking ? 'Checking each one…' : `Activate all ${open.length}`}</button>
      <button type="button" class="btn --link" id="dropAll">Discard the rest</button>
    </div>
    ${worrying ? `<div class="note">${plural(worrying, 'rule')} below ${worrying === 1 ? 'has' : 'have'} a check worth reading before you activate everything.</div>` : ''}`
    : ''}
  </div>`;

  return head + items.map((it, i) => {
    const d = it.rule;
    const active = it.status === 'active';
    if (it.status === 'editing') {
      return `<div class="artifact done"><div class="detail-head">
        <span class="badge ${esc(d.severity)}">${esc(d.severity)}</span>
        <span class="when">${i + 1} of ${items.length} · being edited above</span>
      </div><p class="summary">${esc(d.text)}</p></div>`;
    }
    return `<div class="artifact${active ? ' done' : ''}">
    <div class="detail-head">
      <span class="badge ${esc(d.severity)}">${esc(d.severity)}</span>
      ${d.draftedBy ? `<span class="when">written by ${esc(d.draftedBy)}</span>` : ''}
      <span class="when">${active ? 'active' : `${i + 1} of ${items.length} · not active yet`}</span>
    </div>
    <p class="summary">${esc(d.text)}</p>
    ${d.textLocal ? `<p class="note"><b>Employees will read:</b> ${esc(d.textLocal)}</p>` : ''}
    ${d.boundary ? `<p class="note"><b>Not about:</b> ${esc(d.boundary)}</p>` : ''}
    ${active ? '' : verdictLine(it.preview, it.status === 'checking')}
    <div class="kv"><div class="r">
      <span class="k">Applies to</span><span class="v">${esc(audienceLabel(d.appliesTo))}</span>
    </div></div>
    ${active ? '' : `<div class="chips">
      <button type="button" class="btn --primary" data-set-act="ratify" data-set-i="${i}"${state.ruleBusy ? ' disabled' : ''}>Activate</button>
      <button type="button" class="btn --compact" data-set-act="edit" data-set-i="${i}"${state.ruleBusy || state.draft ? ' disabled' : ''}>Edit alone</button>
      <button type="button" class="btn --link" data-set-act="drop" data-set-i="${i}">Discard</button>
    </div>`}
    <div class="folds">
      ${it.preview ? disclosure(`s:check:${i}`, `The ${plural(it.preview.rows.length, 'request')} it was checked against`, checkRowsOf(it.preview)) : ''}
      ${d.guidance ? disclosure(`s:told:${i}`, 'What the employee is told instead', `<div class="banner">${esc(d.guidance)}</div>`) : ''}
      ${examplesFold(`s:examples:${i}`, d)}
    </div>
  </div>`;
  }).join('');
}

/**
 * Check every card in the set, one after the other.
 *
 * Sequential because each check is a handful of real adjudications on the
 * local model, and the set can be eight rules; run at once they would queue
 * behind each other anyway and the cards would all sit on "checking". One at
 * a time, the first card's verdict is on screen while the last is still
 * being judged. Stops quietly if the set was discarded or replaced meanwhile.
 */
export async function runSetPreviews(set) {
  for (const item of set.items) {
    if (state.set !== set) return;
    if (item.status !== 'pending') continue;
    item.status = 'checking';
    render();
    const { ok, j } = await post('/api/policy/preview', { rule: item.rule });
    if (state.set !== set) return;
    if (item.status === 'checking') {
      item.preview = ok ? j : null;
      item.status = ok ? 'checked' : 'error';
      if (ok && (j.falsePositives > 0 || j.misses > 0)) state.open.add(`s:check:${set.items.indexOf(item)}`);
    }
    render();
  }
  if (state.set !== set || state.mock) return;
  const flagged = set.items.filter((it) => it.preview && (it.preview.falsePositives > 0 || it.preview.misses > 0)).length;
  say(flagged
    ? `Checked all ${set.items.length}. ${plural(flagged, 'rule')} ${flagged === 1 ? 'has' : 'have'} something worth reading in ${flagged === 1 ? 'its' : 'their'} check before you activate everything.`
    : `Checked all ${set.items.length} against their own examples. Nothing wrongly stopped. Activate them when the list reads right.`);
  render();
}

/** Ratify one rule of the set, keeping the card as an "active" record. */
async function ratifySetItem(item) {
  await post('/api/policy/ratify', { rule: item.rule });
  item.status = 'active';
}

/** When nothing in the set is left to decide, leave the conversation for the list. */
async function settleSet() {
  if (!state.set) return;
  if (state.set.editing || state.set.items.some((it) => it.status !== 'active')) { render(); return; }
  const person = state.draftFor;
  resetDraft();
  await Promise.all([refreshPolicy(), refreshPeople()]);
  if (person) go('people', person); else go('policy');
}

/**
 * The set's buttons: one per card, and the pair at the top.
 *
 * "Activate all" confirms with the list of what binds whom, in a dialog the
 * person has to read to dismiss. That is where the reading happens now; the
 * per-card audience chips of the single flow are not on these cards, and
 * "Edit alone" is the way to a card that needs its audience changed.
 */
export function bindSet() {
  const set = state.set;
  if (!set) return;

  const describe = (it) => `${it.rule.severity.toUpperCase()} · ${it.rule.text} — ${audienceLabel(it.rule.appliesTo)}`;

  const all = $('ratifyAll');
  if (all) all.onclick = async () => {
    const open = set.items.filter((it) => it.status !== 'active' && it.status !== 'editing');
    if (!open.length) return;
    const lines = open.map((it, i) => `${i + 1}. ${describe(it)}`).join('\n');
    if (!confirm(`Activate ${plural(open.length, 'rule')}? They start binding people immediately.\n\n${lines}`)) return;
    state.ruleBusy = true;
    render();
    let n = 0;
    for (const it of open) {
      if (state.set !== set) return;
      await ratifySetItem(it);
      n++;
      render();
    }
    state.ruleBusy = false;
    say(`Activated ${plural(n, 'rule')}.`);
    await settleSet();
  };

  const dropAll = $('dropAll');
  if (dropAll) dropAll.onclick = () => {
    const open = set.items.filter((it) => it.status !== 'active').length;
    if (!confirm(`Discard the ${plural(open, 'rule')} not yet activated?`)) return;
    set.items = set.items.filter((it) => it.status === 'active');
    if (!set.items.length) { discardDraft(); return; }
    void settleSet();
  };

  document.querySelectorAll('[data-set-act]').forEach((btn) => {
    btn.onclick = async () => {
      const item = set.items[Number(btn.dataset.setI)];
      if (!item || item.status === 'active') return;
      const act = btn.dataset.setAct;
      if (act === 'ratify') {
        if (!confirm(`Activate this rule? It starts binding people immediately.\n\n${describe(item)}`)) return;
        state.ruleBusy = true;
        render();
        await ratifySetItem(item);
        state.ruleBusy = false;
        await refreshPolicy();
        say('Activated.');
        await settleSet();
      } else if (act === 'drop') {
        set.items = set.items.filter((it) => it !== item);
        if (!set.items.length) { discardDraft(); return; }
        void settleSet();
      } else if (act === 'edit') {
        // Out of the list and into the conversation above it, where the
        // audience chips and "change it as follows" work as for any draft.
        // Held by reference, not by id: a reword compiles a fresh id.
        item.status = 'editing';
        set.editing = item;
        state.draft = item.rule;
        state.preview = item.preview;
        startDraftAudience();
        say('Out of the set. Tell me how to change it, or fix who it applies to, then activate it.');
        render();
      }
    };
  });
}

