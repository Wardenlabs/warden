/**
 * Team: the people Warden judges, their roles, and the company they belong to.
 *
 * Three tabs and one page per person. People is the list, where the role is
 * changed in place from its label and the row's ··· carries the rest. A person
 * is a page, `#/people/<id>`, that leads with how they are doing (or with the
 * setup they have not done yet), folds how they connect, and lists the rules
 * that judge them and why. Roles holds the one-line daily limit; Company is a
 * settings page with one open task and the rest folded.
 */
import { $, api, attr, del, esc, post, state } from './core.js';
import { refreshPeople, refreshPolicy } from './data.js';
import { resetDraft } from './draft.js';
import { TOOL_NAMES, copyText, personById, plural, ruleName } from './format.js';
import { limitValue, quotaOf, saveQuota } from './limits.js';
import { disclosure, render } from './render.js';
import { go } from './router.js';
import {
  button, confirmResult, contextBar, dialog, disclosureRow, effectText, feedback, listState, menu,
  pageHead, roleLabel, roleTone, showToast, tabs
} from './ui.js';
import { VIEWS } from './views.js';

// ═══ TEAM ════════════════════════════════════════════════════════════════════

/**
 * `sel` decides what the view is. `roles` and `company` are the tabs; anything
 * else is a person. A person whose id happens to be one of those two words
 * cannot exist: ids are derived from names and those are not names.
 */
const TABS = [['', 'People'], ['roles', 'Roles'], ['company', 'Company']];
const tabOf = () => (state.sel === 'roles' || state.sel === 'company' ? state.sel : state.sel ? null : '');

const exemptRoles = () => new Set(state.policy.exemptRoles ?? ['admin']);
const isExemptRole = (role) => exemptRoles().has(role);
const firstName = (p) => String(p?.name ?? '').split(' ')[0];
const toolsOf = (e) => (e.connected ?? []).map((c) => TOOL_NAMES[c.tool] ?? c.tool);
const isConnected = (e) => Boolean(e.connected?.length);
const lastActiveAt = (e) => (e.connected ?? []).map((c) => Date.parse(c.at)).filter(Number.isFinite).sort((a, b) => b - a)[0] ?? null;

/**
 * What this person's machines said about themselves, which is a different
 * question from what the gateway saw them send.
 *
 * The column used to read `connected` alone — traffic, in memory, gone on a
 * restart — and so one sentence, "Not connected yet", covered three situations
 * an administrator needs to tell apart: somebody who never installed the hook,
 * somebody who installed it and took it out, and somebody who is wired and has
 * been on holiday. The first needs a setup message, the second needs a
 * conversation, and the third needs nothing at all.
 *
 * `wiring` is the classification; `heardAt` is the separate fact of when any
 * of their machines last spoke to the gateway, which survives a restart
 * because it comes off disk.
 */
const devicesOf = (e) => e.devices ?? [];
const heardAt = (e) => devicesOf(e).map((d) => Date.parse(d.lastSeen)).filter(Number.isFinite).sort((a, b) => b - a)[0] ?? lastActiveAt(e);

function wiring(e) {
  const devices = devicesOf(e);
  if (!devices.length) return { kind: 'never' };

  const pending = devices.filter((d) => d.pendingSince);
  const reported = devices.filter((d) => Array.isArray(d.tools));
  const tools = new Map();
  for (const d of reported) for (const t of d.tools) tools.set(t.id, { wired: t.wired, device: d.name || d.machineId });
  const wired = [...tools.entries()].filter(([, t]) => t.wired);
  const unwired = [...tools.entries()].filter(([, t]) => !t.wired);

  // A rotated key outranks everything else in the column: until each machine
  // comes back with the new one, every request from this person is refused,
  // and that is the state somebody has to act on today.
  if (pending.length) return { kind: 'pending', since: Date.parse(pending[0].pendingSince), devices: pending.length };
  if (!reported.length) return { kind: 'silent', devices: devices.length };
  if (wired.length) {
    return {
      kind: 'wired',
      tools: wired.map(([id]) => TOOL_NAMES[id] ?? id),
      devices: reported.length,
      hookVersion: reported[0].hookVersion ?? null
    };
  }
  return { kind: 'unwired', tools: unwired.map(([id]) => TOOL_NAMES[id] ?? id), device: unwired[0]?.[1]?.device ?? '' };
}

/** The column, in the two lines it has: what was reported, and the detail. */
function wiringCell(e) {
  const w = wiring(e);
  if (w.kind === 'wired') {
    return `<span class="cell-strong">${esc(w.tools.join(', '))}</span><small>${esc(`${plural(w.devices, 'device')}${w.hookVersion ? ` · hook v${w.hookVersion}` : ''}`)}</small>`;
  }
  if (w.kind === 'unwired') {
    return `<span class="cell-strong --attention">${esc(`Unwired on ${w.device || 'their device'}`)}</span><small>${esc(`${w.tools.join(', ')} removed from its settings`)}</small>`;
  }
  if (w.kind === 'pending') {
    return `<span class="cell-strong --attention">Waiting for the new key</span><small>${esc(`${plural(w.devices, 'device')} since the key was rotated`)}</small>`;
  }
  if (w.kind === 'silent') {
    return `<span class="cell-strong">Seen, but has not reported</span><small>An older hook that does not say what it wired</small>`;
  }
  return '<span class="cell-muted">Never reported</span><small>No device has ever checked in</small>';
}

/** "2h ago" beats a timestamp in a column meant to be swept, not read. */
function ago(ts) {
  if (!ts) return '—';
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d}d ago` : new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** A key, with the middle hidden. The prefix says whose, the tail says which. */
const maskKey = (key) => {
  const k = String(key ?? '');
  const cut = k.indexOf('-', 3);
  return cut > 0 && k.length > cut + 12 ? `${k.slice(0, cut + 1)}${'•'.repeat(16)}${k.slice(-6)}` : k;
};

/**
 * Roles in the order they are offered, with exempt ones last.
 *
 * `admin` sits in `exemptRoles`, which means an admin is measured against no
 * company-wide rules at all. It is also alphabetically first, so it was the
 * default on a fresh install — and the very first person anybody added, before
 * they had read anything about exemptions, was silently unjudged. A default that
 * hands out a bypass is the wrong default however defensible the sort order.
 */
const orderedRoles = () => [...state.company.roles].sort((a, b) => Number(isExemptRole(a)) - Number(isExemptRole(b)));

VIEWS.people = {
  body: () => {
    const tab = tabOf();
    if (tab === null) return personPage(personById(state.sel));
    return `<div class="sheet">
      ${contextBar([{ label: 'Your workspace' }])}
      ${pageHead({
        title: 'Team',
        sub: 'Manage the people whose requests run through Warden.',
        actions: tab === '' ? button('Add people', { kind: 'primary', id: 'openAdd' }) : tab === 'roles' ? button('New role', { kind: 'primary', id: 'openNewRole' }) : ''
      })}
      ${tabs('people', TABS, tab, 'Team sections')}
      ${tab === '' ? peopleTab() : tab === 'roles' ? rolesTab() : companyTab()}
      ${dialogMarkup()}
    </div>`;
  },
  bind: () => {
    bindActions();
    bindDialogs();
    const tab = tabOf();
    if (tab === null) bindPerson();
    else if (tab === '') bindPeople();
    else if (tab === 'roles') bindRoles();
    else bindCompany();
  }
};

// ── dialogs ──────────────────────────────────────────────────────────────────

/** One dialog at a time, named by what it is about, with its own error. */
let dlg = null;
const openDialog = (kind, data = {}) => { dlg = { kind, error: '', busy: false, ...data }; render(); };
const closeDialog = () => { dlg = null; render(); };

function dialogMarkup() {
  if (!dlg) return '';
  const p = personById(dlg.id);
  const first = esc(firstName(p));
  switch (dlg.kind) {
    case 'add': {
      const roles = orderedRoles();
      const role = dlg.role ?? roles[0] ?? '';
      return dialog({
        id: 'addPeople', title: 'Add people',
        body: `<p>Each person gets their own connection key.</p>
          <div class="field">
            <label for="newNames">Names</label>
            <input type="text" id="newNames" placeholder="e.g. Ana López, Pablo Ruiz" autocomplete="off" value="${esc(dlg.names ?? '')}">
            <span class="field-help">Separate multiple names with commas.</span>
          </div>
          <div class="field"><span class="field-label">Role</span>
            <div class="role-choices" role="radiogroup" aria-label="Role">${roles.map((r) => `<button type="button" role="radio" aria-checked="${r === role}" class="role-label --${roleTone(r)} role-choice${r === role ? ' --chosen' : ''}" data-choose-role="${esc(r)}">${r === role ? '✓ ' : ''}${esc(r)}</button>`).join('')}</div>
            ${isExemptRole(role) ? `<span class="field-help --attention">${esc(role)} is exempt from company-wide rules: only rules that name the role or the person apply.</span>` : ''}
          </div>
          ${dlg.error ? feedback({ tone: 'error', title: 'Some people were not added', body: esc(dlg.error), icon: true }) : ''}`,
        actions: button('Cancel', { attrs: 'data-dialog-close="addPeople"' }) + button(dlg.busy ? 'Adding…' : 'Add people', { kind: 'primary', id: 'confirmAdd', disabled: !(dlg.names ?? '').trim(), busy: dlg.busy })
      });
    }
    case 'added': {
      const added = dlg.added.map((id) => personById(id)).filter(Boolean);
      const one = added.length === 1;
      return dialog({
        id: 'added', title: '', close: false,
        body: `${confirmResult({ title: one ? `${firstName(added[0])} was added` : `${added.length} people added`, body: one ? 'Share their connection key to finish setup.' : 'Their connection keys are ready.' })}
          <ul class="added-list">${added.map((a) => `<li><span>${esc(a.name)}</span>${roleLabel(a.role)}</li>`).join('')}</ul>
          ${dlg.failed?.length ? feedback({ tone: 'error', icon: true, title: plural(dlg.failed.length, 'name was', 'names were') + ' not added', body: dlg.failed.map(esc).join('<br>') }) : ''}`,
        actions: one ? button('Done', { attrs: 'data-dialog-close="added"' }) + button('Open person', { kind: 'primary', attrs: `data-go="people" data-sel="${attr(added[0].id)}"` }) : button('Done', { kind: 'primary', attrs: 'data-dialog-close="added"' })
      });
    }
    case 'role':
      return dialog({
        id: 'changeRole', title: `Change ${firstName(p)}’s role?`,
        body: dlg.error
          ? `<p>Selected role: ${esc(dlg.to)}. This role is exempt from company-wide rules.</p>
             ${feedback({ tone: 'error', icon: true, title: 'Role couldn’t be changed', body: `${first} is still ${esc(p?.role)}. Their current rules remain in effect. Try again.${dlg.error ? `<br>${esc(dlg.error)}` : ''}` })}`
          : `<p>Two things change. Your company-wide rules stop being applied to ${first}, and ${first} gets administrator access to Warden with the key they already have. Rules written for ${esc(dlg.to)}, or for ${first} by name, still apply.</p>
             <div class="role-change">${roleLabel(p?.role)}<span aria-hidden="true">→</span>${roleLabel(dlg.to)}</div>`,
        actions: button('Cancel', { attrs: 'data-dialog-close="changeRole"' }) + button(dlg.busy ? 'Changing…' : dlg.error ? 'Retry change' : 'Change role', { kind: 'primary', id: 'confirmRole', busy: dlg.busy })
      });
    case 'roleDone':
      return dialog({
        id: 'roleDone', title: 'Role updated',
        body: `<p>${first} is now ${/^[aeiou]/i.test(dlg.to) ? 'an' : 'a'} ${esc(dlg.to)} and exempt from company-wide rules. Rules that name ${esc(dlg.to)} or ${first} still apply.</p>`,
        actions: button('Done', { kind: 'primary', attrs: 'data-dialog-close="roleDone"' })
      });
    case 'key':
      return dialog({
        id: 'newKey', title: 'Generate a new key?',
        body: dlg.error
          ? `<p>The current key will be replaced only when the new key is generated successfully.</p>${feedback({ tone: 'error', icon: true, title: 'New key couldn’t be generated', body: `A new key could not be generated. ${first}’s current key still works.` })}`
          : `<p>${first}’s current key will stop working immediately. Share the new setup message so ${first} can reconnect their tools.</p>`,
        actions: button('Cancel', { attrs: 'data-dialog-close="newKey"' }) + button(dlg.busy ? 'Generating…' : dlg.error ? 'Try again' : 'Generate new key', { kind: 'primary', id: 'confirmKey', busy: dlg.busy })
      });
    case 'keyDone':
      return dialog({
        id: 'keyDone', title: 'New key generated',
        body: `<p>The previous key no longer works. Share ${first}’s new setup message so ${first} can reconnect their tools.</p>`,
        actions: button('Done', { attrs: 'data-dialog-close="keyDone"' }) + button('Copy setup message', { kind: 'primary', attrs: `data-act="copy-setup" data-id="${attr(dlg.id)}"` })
      });
    case 'remove':
      return dialog({
        id: 'removePerson', title: `Remove ${firstName(p)} from the team?`,
        body: dlg.error
          ? `<p>Removing ${first} revokes their connection key and access through Warden.</p>${feedback({ tone: 'error', icon: true, title: `${firstName(p)} couldn’t be removed`, body: `${first} could not be removed. ${first} is still on the team and their access is unchanged.` })}`
          : `<p>${first} will lose access through Warden and their connection key will stop working.</p>`,
        actions: button('Cancel', { attrs: 'data-dialog-close="removePerson"' }) + button(dlg.busy ? 'Removing…' : dlg.error ? 'Retry removal' : 'Remove person', { kind: 'danger', id: 'confirmRemove', busy: dlg.busy })
      });
    case 'newRole':
      return dialog({
        id: 'newRole', title: 'New role',
        body: `<p>A role is a name your rules can point at. Give it a daily limit now or leave it open and set one later.</p>
          <div class="field"><label for="newRoleName">Name</label><input type="text" id="newRoleName" placeholder="designer" autocomplete="off" value="${esc(dlg.name ?? '')}"><span class="field-help">Lowercase, no spaces — people are judged by this name.</span></div>
          <div class="field"><label for="newRoleQuota">Requests a day</label><input type="text" inputmode="numeric" id="newRoleQuota" placeholder="none" autocomplete="off" value="${esc(dlg.quota ?? '')}"><span class="field-help">Leave blank for no limit.</span></div>
          ${dlg.error ? feedback({ tone: 'error', icon: true, title: 'The role was not created', body: esc(dlg.error) }) : ''}`,
        actions: button('Cancel', { attrs: 'data-dialog-close="newRole"' }) + button(dlg.busy ? 'Creating…' : 'Create role', { kind: 'primary', id: 'confirmNewRole', busy: dlg.busy })
      });
    /**
     * A pause asks for the three things `setPause` accepts, and it asks for
     * them because they are what makes it explainable six months later.
     * "Nothing was judged between the 3rd and the 11th" with no author and no
     * reason is a hole in the governance record; with both, it is a decision.
     *
     * The body says what a pause actually does, so nobody reads it as "stop
     * logging": the requests still go out and still land in the log, marked
     * as not judged, which is the sentence `recordUnjudged` writes.
     */
    case 'pause': {
      const choices = [['1h', 'One hour'], ['today', 'Until the end of today'], ['forever', 'Until I turn it back on']];
      const pick = dlg.until ?? '1h';
      return dialog({
        id: 'pausePerson', title: `Pause Warden for ${p ? esc(p.name) : 'this person'}?`,
        body: `<p>While ${first} is paused, ${first}’s requests go through without being checked against any rule. Each one is still recorded and marked “not judged”, with your name on it.</p>
          <div class="field"><span class="field-label">For how long</span>
            <div class="role-choices" role="radiogroup" aria-label="For how long">${choices.map(([id, label]) => `<button type="button" role="radio" aria-checked="${id === pick}" class="role-choice${id === pick ? ' --chosen' : ''}" data-choose-until="${id}">${id === pick ? '✓ ' : ''}${esc(label)}</button>`).join('')}</div>
            ${pick === 'forever' ? '<span class="field-help --attention">With no end date this lasts until somebody turns it back on. Every screen that lists people will say so meanwhile.</span>' : ''}
          </div>
          <div class="field"><label for="pauseReason">Why (optional)</label><input type="text" id="pauseReason" placeholder="Debugging their own rule" autocomplete="off" value="${esc(dlg.reason ?? '')}"><span class="field-help">It shows in the log beside your name.</span></div>
          ${dlg.error ? feedback({ tone: 'error', icon: true, title: 'Warden was not paused', body: esc(dlg.error) }) : ''}`,
        actions: button('Cancel', { attrs: 'data-dialog-close="pausePerson"' }) + button(dlg.busy ? 'Pausing…' : 'Pause', { kind: 'primary', id: 'confirmPause', busy: dlg.busy })
      });
    }
    case 'reset':
      return dialog({
        id: 'resetCompany', title: 'Reset this company?',
        body: `<p>Every person but the first administrator goes, and every stored prompt is cleared. That administrator gets a fresh key — the old ones stop working. Your rules stay.</p>
          ${dlg.error ? feedback({ tone: 'error', icon: true, title: 'The company was not reset', body: esc(dlg.error) }) : ''}`,
        actions: button('Cancel', { attrs: 'data-dialog-close="resetCompany"' }) + button(dlg.busy ? 'Resetting…' : 'Reset company', { kind: 'danger', id: 'confirmReset', busy: dlg.busy })
      });
    default:
      return '';
  }
}

function bindDialogs() {
  const scrim = document.querySelector('[data-dialog-scrim]');
  if (scrim) scrim.onclick = (e) => { if (e.target === scrim && !dlg?.busy) closeDialog(); };
  for (const b of document.querySelectorAll('[data-dialog-close]')) b.onclick = () => closeDialog();
  if (!dlg) return;

  const names = $('newNames');
  if (names) { names.oninput = () => { dlg.names = names.value; const ok = $('confirmAdd'); if (ok) ok.disabled = !names.value.trim(); }; if (!dlg.focused) { names.focus(); dlg.focused = true; } }
  for (const b of document.querySelectorAll('[data-choose-role]')) b.onclick = () => { dlg.role = b.dataset.chooseRole; render(); };
  const add = $('confirmAdd');
  if (add) add.onclick = () => void addPeople();

  const role = $('confirmRole');
  if (role) role.onclick = () => void changeRole(dlg.id, dlg.to, true);

  const key = $('confirmKey');
  if (key) key.onclick = async () => {
    dlg.busy = true; render();
    const { ok } = await post(`/api/people/${encodeURIComponent(dlg.id)}/key`).catch(() => ({ ok: false }));
    if (!ok) { dlg.busy = false; dlg.error = 'failed'; render(); return; }
    await refreshPeople();
    openDialog('keyDone', { id: dlg.id });
  };

  for (const b of document.querySelectorAll('[data-choose-until]')) b.onclick = () => { dlg.until = b.dataset.chooseUntil; render(); };
  const reason = $('pauseReason');
  if (reason) reason.oninput = () => { dlg.reason = reason.value; };
  const pause = $('confirmPause');
  if (pause) pause.onclick = async () => {
    const p = personById(dlg.id);
    dlg.busy = true; render();
    const body = { until: untilISO(dlg.until ?? '1h'), ...(dlg.reason?.trim() ? { reason: dlg.reason.trim() } : {}) };
    const { ok, j } = await post(`/api/people/${encodeURIComponent(dlg.id)}/pause`, body).catch(() => ({ ok: false, j: null }));
    if (!ok) { dlg.busy = false; dlg.error = j?.error ?? 'The gateway did not answer.'; render(); return; }
    dlg = null;
    await refreshPeople();
    render();
    showToast(`Warden is paused for ${firstName(p)}`, 'Their requests go out unchecked and are recorded as not judged.');
  };

  const remove = $('confirmRemove');
  if (remove) remove.onclick = async () => {
    const id = dlg.id;
    const p = personById(id);
    dlg.busy = true; render();
    const { ok, j } = await del(`/api/people/${encodeURIComponent(id)}`).catch(() => ({ ok: false, j: null }));
    if (!ok) { dlg.busy = false; dlg.error = j?.error ?? 'failed'; render(); return; }
    dlg = null;
    await refreshPeople();
    go('people');
    // Rules written only for someone who has left still exist and now bind
    // nobody. Saying so beats leaving dead policy in the list unremarked.
    const orphaned = j.orphanedRules?.length ?? 0;
    showToast(`${firstName(p)} was removed`, `Their connection key no longer works.${orphaned ? ` ${plural(orphaned, 'rule')} written only for ${firstName(p)} now ${orphaned === 1 ? 'applies' : 'apply'} to nobody — retarget or remove ${orphaned === 1 ? 'it' : 'them'} on Rules.` : ''}`);
  };

  const roleName = $('newRoleName');
  if (roleName) { roleName.oninput = () => { dlg.name = roleName.value; }; if (!dlg.focused) { roleName.focus(); dlg.focused = true; } }
  const roleQuota = $('newRoleQuota');
  if (roleQuota) roleQuota.oninput = () => { dlg.quota = roleQuota.value; };
  const newRole = $('confirmNewRole');
  if (newRole) newRole.onclick = async () => {
    const name = (dlg.name ?? '').trim();
    const quota = limitValue(dlg.quota);
    if (!name) { dlg.error = 'Give the role a name.'; render(); return; }
    if (Number.isNaN(quota)) { dlg.error = 'Use a whole number of requests above zero, or leave it blank for no limit.'; render(); return; }
    dlg.busy = true; render();
    const { ok, j } = await post('/api/roles', { role: name, maxRequestsPerDay: quota ?? 0 }).catch(() => ({ ok: false, j: null }));
    if (!ok) { dlg.busy = false; dlg.error = j?.error ?? 'Warden could not be reached.'; render(); return; }
    dlg = null;
    await Promise.all([refreshPeople(), refreshPolicy()]);
    render();
    showToast('Role created', `${name} can now be given to people and named by rules.`);
  };

  const reset = $('confirmReset');
  if (reset) reset.onclick = async () => {
    dlg.busy = true; render();
    const { ok, j } = await post('/api/company/reset', { name: state.company.name }).catch(() => ({ ok: false, j: null }));
    if (!ok) { dlg.busy = false; dlg.error = j?.error ?? 'Warden could not be reached.'; render(); return; }
    dlg = null;
    await refreshPeople();
    render();
    showToast('Company reset', 'Everyone else was removed and stored prompts were cleared. The administrator’s new key is on their page.');
  };
}

// ── People ───────────────────────────────────────────────────────────────────

/**
 * The role, changed where it is read: the label is the trigger, the menu
 * lists roles with their identity colour. Making somebody exempt asks first,
 * because it hands out both a bypass and administrator access; anything else
 * is applied at once and said in a toast.
 */
function roleMenu(p) {
  const roles = orderedRoles();
  const items = roles.map((r) => `<button type="button" role="menuitemradio" aria-checked="${r === p.role}" class="menu-item" data-set-role="${esc(r)}" data-id="${attr(p.id)}"><i class="menu-dot --${roleTone(r)}"></i><span>${esc(r)}</span>${r === p.role ? '<b class="menu-check">✓</b>' : ''}</button>`).join('');
  return `<details class="menu --left role-menu">
    <summary class="menu-trigger" aria-label="Role of ${esc(p.name)}: ${esc(p.role)}">${roleLabel(p.role)}</summary>
    <div class="menu-list" role="menu">
      ${roles.length > 5 ? `<input type="text" class="menu-search" placeholder="Search roles…" aria-label="Search roles" data-role-search>` : ''}
      ${items}
      <div class="menu-note" hidden data-role-empty>No roles found</div>
    </div>
  </details>`;
}

function personActions(p) {
  const paused = activePause(p);
  return [
    { label: `Write a rule for ${firstName(p)}`, act: 'write-rule', attrs: `data-id="${attr(p.id)}"` },
    paused
      ? { label: 'Resume judging', act: 'resume', attrs: `data-id="${attr(p.id)}"` }
      : { label: `Pause Warden for ${firstName(p)}…`, act: 'pause', attrs: `data-id="${attr(p.id)}"` },
    { label: 'New key', act: 'key', attrs: `data-id="${attr(p.id)}"` },
    { label: 'Remove from team', act: 'remove', attrs: `data-id="${attr(p.id)}"`, destructive: true }
  ];
}

/**
 * Two problems, two counts, because they have different answers: somebody who
 * never set up gets a setup message, and somebody who took the hook out gets a
 * conversation. One number over both of them hid the second behind the first.
 */
function needsAttention(e) {
  const k = wiring(e).kind;
  return k === 'never' ? 'never' : k === 'unwired' ? 'unwired' : k === 'pending' ? 'pending' : '';
}

function peopleTab() {
  const only = state.query.only === 'unsetup';
  const all = state.company.employees;
  const counts = { never: 0, unwired: 0, pending: 0 };
  for (const e of all) { const k = needsAttention(e); if (k) counts[k]++; }
  const shown = only ? all.filter((e) => needsAttention(e)) : all;
  const load = state.loads.people;
  if (load?.error) {
    return listState({ title: 'Could not load the team', body: 'We could not confirm who is on the team. Retry to load the latest list.', icon: true, action: button('Retry loading', { kind: 'primary', id: 'retryPeople' }) });
  }
  if (load?.loading && !all.length) {
    return listState({ title: 'Loading the team…', body: 'Fetching people, their roles and their connections.' });
  }
  if (!all.length) {
    return listState({ title: 'Nobody yet', body: 'Add people and Warden issues each of them a connection key.', action: button('Add people', { kind: 'primary', id: 'openAddEmpty' }) });
  }
  const gaps = [
    counts.unwired ? `${counts.unwired} unwired` : '',
    counts.pending ? `${counts.pending} waiting for a new key` : '',
    counts.never ? `${counts.never} never set up` : ''
  ].filter(Boolean);
  return `${pausedBand()}
    <div class="subhead">
      <span class="subhead-count">${only ? `${plural(shown.length, 'person', 'people')} to look at` : plural(all.length, 'person', 'people')}</span>
      ${only ? button('Show everyone', { attrs: 'data-go="people"' }) : gaps.length ? button(`${gaps.join(' · ')} →`, { attrs: 'data-go="people" data-q="only=unsetup"' }) : ''}
    </div>
    <div class="table people-table" role="table" aria-label="People">
      <div class="thead" role="row"><span>Person</span><span>Role</span><span>Wired</span><span>Last heard from</span><span></span></div>
      ${shown.map(personRow).join('')}
    </div>`;
}

/**
 * While anybody is paused, every screen that lists people says so.
 *
 * A gateway that is not judging somebody must not look like one that is, and
 * a pause with no end date is the one most likely to be forgotten — which is
 * exactly why the band names who, until when, and offers the way back.
 */
function pausedBand() {
  const paused = state.company.employees.filter((e) => activePause(e));
  if (!paused.length) return '';
  const names = paused.map((p) => esc(p.name)).join(', ');
  const one = paused.length === 1 ? activePause(paused[0]) : null;
  const until = one ? (one.until ? `until ${new Date(one.until).toLocaleString()}` : 'until somebody turns it back on') : '';
  return feedback({
    tone: 'attention',
    icon: true,
    title: `${names} ${paused.length === 1 ? 'is' : 'are'} paused — ${paused.length === 1 ? 'their' : 'those'} requests are going through unchecked`,
    body: esc(`${one ? `Paused ${until}${one.by ? ` by ${one.by}` : ''}${one.reason ? `: “${one.reason}”` : ''}. ` : ''}Every request is still recorded, marked not judged.`)
  });
}

/**
 * The three durations, as an instant the server will accept. `setPause`
 * refuses an `until` in the past, so "the end of today" is the end of today
 * and never a time that has already gone; null is the indefinite one.
 */
function untilISO(choice) {
  if (choice === 'forever') return null;
  if (choice === 'today') {
    const end = new Date();
    end.setHours(23, 59, 59, 0);
    return (end.getTime() > Date.now() ? end : new Date(Date.now() + 3600000)).toISOString();
  }
  return new Date(Date.now() + 3600000).toISOString();
}

/**
 * The line under a person's name: what is wired, then when they were last
 * heard from. Never "Not connected yet" off the back of traffic — a person
 * who wired two machines on Friday and has not worked since is set up, and
 * telling their administrator otherwise sends them to fix nothing.
 */
function personLine(p) {
  const w = wiring(p);
  const heard = heardAt(p) ? `last heard from ${ago(heardAt(p))}` : 'never heard from';
  if (w.kind === 'wired') return `${p.role} · ${w.tools.join(', ')} on ${plural(w.devices, 'device')} · ${heard}`;
  if (w.kind === 'unwired') return `${p.role} · unwired on ${w.device || 'their device'} · ${heard}`;
  if (w.kind === 'pending') return `${p.role} · waiting for the new key · ${heard}`;
  if (w.kind === 'silent') return `${p.role} · ${plural(w.devices, 'device')} seen, wiring not reported · ${heard}`;
  return `${p.role} · no device has reported yet`;
}

/** The pause in force right now, or null — the same rule the server applies. */
function activePause(e) {
  const p = e?.paused;
  if (!p) return null;
  if (p.until === null || p.until === undefined) return p;
  const t = Date.parse(p.until);
  return Number.isFinite(t) && t > Date.now() ? p : null;
}

/**
 * One row. The name opens the page; the role changes in place; the menu has
 * what used to need the page open. Last active is what an administrator
 * actually sweeps a list of people for.
 */
function personRow(e) {
  const paused = activePause(e);
  return `<div class="trow --link" role="row" tabindex="0" data-go="people" data-sel="${attr(e.id)}">
    <span class="cell-strong person-name">${esc(e.name)}</span>
    <span class="role-cell">${roleMenu(e)}${isExemptRole(e.role) ? '<span class="exempt-note">Exempt from company-wide rules</span>' : ''}</span>
    <span class="cell-stack">${wiringCell(e)}</span>
    ${paused
      // While somebody is paused, when they were last heard from does not mean
      // what the column says: their requests keep arriving and nothing judges
      // them. The cell says the thing that is true instead.
      ? `<span class="status-text --attention">${esc(paused.until ? `Paused until ${new Date(paused.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Paused')}</span>`
      : `<span class="cell-muted">${ago(heardAt(e))}</span>`}
    <span class="row-menu">${menu(personActions(e), { label: `Actions for ${e.name}` })}</span>
  </div>`;
}

async function addPeople() {
  const names = (dlg.names ?? '').split(',').map((n) => n.trim()).filter(Boolean);
  if (!names.length) return;
  const role = dlg.role ?? orderedRoles()[0];
  dlg.busy = true; render();
  // Sequential rather than concurrent because ids are derived from names and
  // two people called Ana must not race for the same one.
  const added = [];
  const failed = [];
  for (const name of names) {
    const { ok, j } = await post('/api/people', { name, role }).catch(() => ({ ok: false, j: null }));
    if (ok) added.push(j.id); else failed.push(`${name}: ${j?.error ?? 'Warden could not be reached.'}`);
  }
  await refreshPeople();
  if (!added.length) { dlg.busy = false; dlg.error = failed.join(' · '); render(); return; }
  openDialog('added', { added, failed });
}

async function changeRole(id, to, confirmed = false) {
  const p = personById(id);
  if (!p || p.role === to) return;
  if (!confirmed && isExemptRole(to) && !isExemptRole(p.role)) { openDialog('role', { id, to }); return; }
  if (dlg) { dlg.busy = true; render(); }
  const { ok, j } = await post('/api/people', { id: p.id, name: p.name, role: to }).catch(() => ({ ok: false, j: null }));
  if (!ok) {
    if (dlg) { dlg.busy = false; dlg.error = j?.error ?? 'Warden could not be reached.'; render(); }
    else showToast('Role couldn’t be changed', `${p.name} is still ${p.role}. ${j?.error ?? 'Try again.'}`);
    return;
  }
  await refreshPeople();
  if (isExemptRole(to) && !isExemptRole(p.role)) openDialog('roleDone', { id, to });
  else { dlg = null; render(); showToast('Role updated', `${p.name} is now ${to}.`); }
}

function bindPeople() {
  const retry = $('retryPeople');
  if (retry) retry.onclick = async () => { retry.disabled = true; await refreshPeople(); render(); };
  const open = () => openDialog('add', { role: orderedRoles()[0] });
  if ($('openAdd')) $('openAdd').onclick = open;
  if ($('openAddEmpty')) $('openAddEmpty').onclick = open;
}

// ── one person ───────────────────────────────────────────────────────────────

/**
 * The one thing about this person that needs a person, above everything else.
 *
 * A rotated key is invisible today: the old one stops working instantly —
 * there is no grace period, by decision — so the only signal anybody gets is
 * the employee discovering they are refused. `pendingSince` turns that into
 * something the administrator can see on the screen where they pressed the
 * button, and it clears itself on the first request that arrives with the new
 * key, so nobody has to remember to dismiss it.
 *
 * The unwired notice is worded against what the product can actually do.
 * Warden sees the hook go; it cannot put it back, because it is a file in
 * somebody else's settings and there is no agent on that machine. Offering a
 * button that implied otherwise would be promising a lock this is not.
 */
function personNotice(p) {
  const paused = activePause(p);
  if (paused) {
    const until = paused.until ? `until ${new Date(paused.until).toLocaleString()}` : 'until somebody turns it back on';
    return feedback({
      tone: 'attention', icon: true,
      title: `Warden is paused for ${firstName(p)} ${esc(until)}`,
      body: esc(`Their requests go through without being checked against any rule${paused.by ? `. Paused by ${paused.by}` : ''}${paused.reason ? `: “${paused.reason}”` : ''}. Every one is still recorded, marked not judged.`)
    });
  }
  const w = wiring(p);
  if (w.kind === 'pending') {
    return feedback({
      tone: 'attention', icon: true,
      title: `${firstName(p)}’s key was rotated and no device has used the new one yet`,
      body: `Until each machine checks in with it, every request from ${esc(firstName(p))} is refused. The old key stopped working immediately — there is no grace period, by decision.`
    });
  }
  if (w.kind === 'unwired') {
    return feedback({
      tone: 'attention', icon: true,
      title: `The hook is gone from ${esc(w.device || 'their device')}`,
      body: `${esc(w.tools.join(', '))} reported that Warden is no longer in its settings. Warden can see this; it cannot put it back — the hook is a file on their machine. Send the setup again, or talk to ${esc(firstName(p))}.`
    });
  }
  return '';
}

/**
 * One row per machine, because "this person is connected" was never the
 * question an administrator had. What each machine reported about its own
 * wiring, with what it reported it, and when it was last heard from — and
 * wired-and-quiet stays in ordinary ink, because a laptop nobody asked
 * anything today is not a fault.
 */
function devicesSection(p) {
  const devices = devicesOf(p);
  if (!devices.length) return '';
  return `<section class="person-devices">
    <h2 class="section-title">Devices</h2>
    <p class="section-lede">What each machine reported about its own wiring. Warden cannot see a machine it has not heard from.</p>
    <div class="setting-rows">${devices.map((d) => {
      const tools = (d.tools ?? []);
      const wired = tools.filter((t) => t.wired).map((t) => TOOL_NAMES[t.id] ?? t.id);
      const gone = tools.filter((t) => !t.wired).map((t) => TOOL_NAMES[t.id] ?? t.id);
      const line = d.pendingSince
        ? `<span class="status-text --attention">Has not come back with the new key</span>`
        : !tools.length
          ? '<span class="cell-muted">Has not reported its wiring</span>'
          : wired.length
            ? `<span class="cell-strong">${esc(wired.join(', '))} · wired</span>`
            : `<span class="status-text --attention">${esc(gone.join(', '))} · not wired</span>`;
      return `<div class="setting-row">
        <span class="mono">${esc(d.name || d.machineId)}</span>
        <span class="cell-stack device-cell">${line}<small>${esc(`${d.hookVersion ? `hook v${d.hookVersion} · ` : ''}last heard from ${ago(Date.parse(d.lastSeen))}`)}</small></span>
      </div>`;
    }).join('')}</div>
  </section>`;
}

function personPage(p) {
  if (!p) {
    return `<div class="sheet">${contextBar([{ label: 'Team', go: 'people', back: true }, { label: 'Removed' }])}
      ${pageHead({ title: 'This person is not on the team' })}${listState({ title: 'Nothing to show', body: 'They were removed, or the link is from another installation.' })}</div>`;
  }
  const first = esc(firstName(p));
  const hits = state.audit.filter((a) => a.actor?.id === p.id);
  const count = (v) => hits.filter((h) => h.decision?.verdict === v).length;
  const on = isConnected(p);
  const exempt = isExemptRole(p.role);
  const seeActivity = button('See activity →', { kind: 'link', attrs: `data-act="decisions" data-id="${attr(p.id)}"` });
  const summary = exempt
    ? `<div class="person-card"><div><h2 class="section-title --big">Exempt from company-wide rules</h2><p>${first}’s ${esc(p.role)} role is not judged by company-wide rules. Rules that name the role or ${first} still apply. Previous activity remains available.</p></div>${seeActivity}</div>`
    : on || hits.length
      ? `<div class="person-card"><div><h2 class="section-title --big">${plural(hits.length, 'request')} seen</h2><p>${count('ALLOW')} allowed · ${count('BLOCK')} blocked · ${count('ESCALATE')} held for review</p></div>${seeActivity}</div>`
      : `<div class="person-card --setup"><div><h2 class="section-title --big">${first} hasn’t connected yet</h2><p>Share their setup message. It includes their connection key and instructions for each tool.</p></div><div>${button('Copy setup message', { kind: 'primary', attrs: `data-act="copy-setup" data-id="${attr(p.id)}"` })}</div></div>`;
  return `<div class="sheet">
    ${contextBar([{ label: 'Team', go: 'people', back: true }, { label: p.name }])}
    ${pageHead({
      title: p.name,
      sub: esc(personLine(p)),
      actions: menu(personActions(p), { label: `Actions for ${p.name}` })
    })}
    <div class="facts person-role">${roleMenu(p)}<span class="fact-v">Role determines which rules apply.</span></div>
    ${personNotice(p)}
    ${summary}
    ${devicesSection(p)}
    <div class="reading-wide">
      ${disclosureRow('p:setup', 'Connection & setup', '', `
        <div class="setup-share">
          <div><b>Share setup with ${first}</b><p>Copy a message with their connection key and setup instructions, then send it to them.</p></div>
          ${button('Copy setup message', { compact: true, attrs: `data-act="copy-setup" data-id="${attr(p.id)}"` })}
        </div>
        ${disclosure('p:key', 'View connection key', `<div class="key-row"><span class="mono" title="Their identity. A new one revokes the old.">${esc(maskKey(p.apiKey))}</span>${button('Copy key', { compact: true, attrs: `data-copy="${attr(`export WARDEN_API_KEY=${p.apiKey}`)}"` })}</div>`)}
        ${disclosure('p:manual', 'Configure manually', '<div id="onboarding"><p class="disclosure-text">Loading the steps…</p></div>')}
      `, { open: state.open.has('p:setup'), big: true })}
    </div>
    <section class="person-rules">
      <h2 class="section-title --big">Rules that apply to ${first}</h2>
      <div class="table person-rules-table" role="table" aria-label="Rules that apply to ${first}" id="personRules">
        <div class="thead" role="row"><span>Rule</span><span>Why it applies</span><span>Effect</span></div>
        <div class="trow"><span class="cell-muted">Loading the rules…</span></div>
      </div>
    </section>
    ${dialogMarkup()}
  </div>`;
}

function bindPerson() {
  const p = personById(state.sel);
  if (!p) return;
  void fillRules(p);
  if (state.open.has('p:setup') && state.open.has('p:manual')) void renderOnboarding(p);
  const manual = document.querySelector('details[data-key="p:manual"]');
  if (manual) manual.addEventListener('toggle', () => { if (manual.open) void renderOnboarding(p); });
}

/**
 * Every rule that will judge this person, personal ones first, with why it
 * binds them — because "everyone" and "written for you" are very different
 * things to be told when a request is refused.
 */
async function fillRules(p) {
  const host = $('personRules');
  if (!host) return;
  const { ok, j } = await api(`/api/people/${encodeURIComponent(p.id)}/rules`).catch(() => ({ ok: false }));
  if (!host.isConnected || state.sel !== p.id) return;
  const head = '<div class="thead" role="row"><span>Rule</span><span>Why it applies</span><span>Effect</span></div>';
  if (!ok) { host.innerHTML = `${head}<div class="trow"><span class="cell-muted">The rules could not be loaded.</span></div>`; return; }
  const order = { personal: 0, role: 1, company: 2 };
  const rules = [...(j?.rules ?? [])].sort((a, b) => (order[a.binding] ?? 3) - (order[b.binding] ?? 3));
  const why = (r) => (r.binding === 'personal' ? roleLabel('everyone', p.name) : r.binding === 'role' ? roleLabel(p.role) : roleLabel('everyone', 'Everyone'));
  host.innerHTML = head + (rules.length
    ? rules.map((r) => `<div class="trow --link" role="row" tabindex="0" data-go="policy" data-sel="${attr(r.id)}">
        <span class="cell-strong">${esc(ruleName(r))}</span><span>${why(r)}</span><span>${effectText(r.severity)}</span></div>`).join('')
    : `<div class="trow"><span class="cell-muted">No rule applies to ${esc(firstName(p))} yet.</span></div>`);
}

/**
 * The setup for one person, per tool, with their values already in it.
 *
 * Generated on the server rather than assembled here, so the console and a
 * pasted chat message say the same thing, and so the gateway address is one the
 * server knows is reachable rather than one the admin typed from memory.
 */
let onboardingTool = 0;
async function renderOnboarding(person) {
  const host = $('onboarding');
  if (!host || host.dataset.loaded) return;
  host.dataset.loaded = '1';
  const { ok, j } = await api(`/api/people/${encodeURIComponent(person.id)}/onboarding`).catch(() => ({ ok: false, j: null }));
  if (!host.isConnected) return;
  if (!ok) { host.innerHTML = `<p class="disclosure-text">${esc(j?.error ?? 'The setup steps could not be loaded.')}</p>`; return; }
  const tools = j.integrations ?? [];
  const step = (st) => `<div class="setup-step">
      <b>${esc(st.title)}</b>
      ${st.note ? `<p>${esc(st.note)}</p>` : ''}
      <div class="codewrap"><pre class="code">${esc(st.code)}</pre>${button('Copy', { compact: true, attrs: `data-copy="${attr(st.code)}"` })}</div>
    </div>`;
  const draw = () => {
    const t = tools[onboardingTool] ?? tools[0];
    host.innerHTML = `
      <span class="kicker">Everyone does this first</span>
      ${(j.common ?? []).map(step).join('')}
      <span class="kicker">Then their tool</span>
      <div class="seg-tool" role="group" aria-label="Tool">${tools.map((x, i) => `<button type="button" aria-pressed="${x === t}" data-tool="${i}">${esc(x.name)}</button>`).join('')}</div>
      ${t ? `<p class="disclosure-text">${esc(t.summary)} ${t.kind === 'hook' ? 'Checks before the prompt leaves the machine.' : 'Routes through the gateway.'} ${t.worksOnSubscription ? 'Works on a subscription.' : 'Needs an API key.'} <span class="status-text --${t.verified ? 'allow' : 'attention'}">${t.verified ? 'Verified working' : 'Not verified end to end'}</span></p>
        ${t.steps.map(step).join('')}` : ''}`;
    for (const b of host.querySelectorAll('[data-tool]')) b.onclick = () => { onboardingTool = Number(b.dataset.tool); draw(); };
  };
  draw();
}

// ── actions shared by rows, the page, and their menus ────────────────────────

function bindActions() {
  $('pane').onclick = async (e) => {
    // The pane outlives this view; the handler must not act on another one.
    if (state.view !== 'people') return;
    const setRole = e.target.closest('[data-set-role]');
    if (setRole) {
      setRole.closest('details.menu')?.removeAttribute('open');
      void changeRole(setRole.dataset.id, setRole.dataset.setRole);
      return;
    }
    const el = e.target.closest('[data-act]');
    if (!el) return;
    el.closest('details.menu')?.removeAttribute('open');
    const id = el.dataset.id;
    const p = personById(id);
    switch (el.dataset.act) {
      case 'decisions':
        state.actorFilter = id;
        state.filter = 'all';
        go('activity');
        return;
      case 'copy-setup': {
        const { ok, j } = await api(`/api/people/${encodeURIComponent(id)}/onboarding`).catch(() => ({ ok: false, j: null }));
        if (ok) await copyText(j.message, el);
        else showToast('The setup message could not be built', j?.error ?? 'Try again.');
        return;
      }
      case 'write-rule':
        resetDraft();
        state.draftFor = id;
        go('policy', 'new');
        return;
      case 'key':
        if (p) openDialog('key', { id });
        return;
      case 'pause':
        if (p) openDialog('pause', { id, until: '1h' });
        return;
      // Resuming needs no dialog: it takes nothing away and leaves the record
      // of the pause exactly where it was.
      case 'resume': {
        const { ok, j } = await del(`/api/people/${encodeURIComponent(id)}/pause`).catch(() => ({ ok: false, j: null }));
        if (!ok) { showToast('Warden was not resumed', j?.error ?? 'Warden could not be reached.'); return; }
        await refreshPeople();
        render();
        showToast(`Judging ${firstName(p)} again`, 'Requests from now on are checked against the rules in force.');
        return;
      }
      case 'remove':
        if (p) openDialog('remove', { id });
        return;
      case 'set-limit':
        roleEdit = { role: id, value: String(quotaOf(id).maxRequestsPerDay ?? ''), error: '', busy: false };
        render();
        $('roleLimit')?.focus();
        return;
      case 'remove-role': {
        const { ok, j } = await del(`/api/roles/${encodeURIComponent(id)}`).catch(() => ({ ok: false, j: null }));
        if (!ok) { showToast('The role was not removed', j?.error ?? 'Warden could not be reached.'); return; }
        await Promise.all([refreshPeople(), refreshPolicy()]);
        render();
        showToast('Role removed', `${id} and its daily limit are gone.`);
      }
    }
  };
  // Filtering a long role menu does not re-render: it hides items in place.
  for (const input of document.querySelectorAll('[data-role-search]')) {
    input.onclick = (e) => e.stopPropagation();
    input.oninput = () => {
      const q = input.value.trim().toLowerCase();
      let shown = 0;
      for (const item of input.closest('.menu-list').querySelectorAll('[data-set-role]')) {
        const match = item.dataset.setRole.toLowerCase().includes(q);
        item.hidden = !match;
        if (match) shown++;
      }
      input.closest('.menu-list').querySelector('[data-role-empty]').hidden = shown > 0;
    };
  }
}

// ── Roles ────────────────────────────────────────────────────────────────────

/**
 * The daily limit, as an inline editor of one line: the field, what the number
 * means, and Save only once the value has changed. Session ceilings are not
 * here — they are tokens, and tokens are Models' business.
 */
let roleEdit = null;

function rolesTab() {
  const roles = state.company.roles;
  return `<div class="subhead"><span class="subhead-count">${plural(roles.length, 'role')}</span></div>
    <div class="table roles-table" role="table" aria-label="Roles">
      <div class="thead" role="row"><span>Role</span><span>People</span><span>Judged by</span><span>Daily limit</span><span></span></div>
      ${roles.map(roleRow).join('')}
    </div>
    <p class="table-foot">A daily limit is a number of requests, not money. Setting one also opens that role's session ceilings — output, context and prompt size, on Models. Token counts are reported by the tool, not measured here.</p>`;
}

function roleRow(r) {
  const held = state.company.employees.filter((e) => e.role === r).length;
  const q = quotaOf(r);
  const editing = roleEdit?.role === r;
  const items = [
    { label: 'Set daily limit', act: 'set-limit', attrs: `data-id="${attr(r)}"` },
    held ? { label: 'Remove role', disabled: true } : { label: 'Remove role', act: 'remove-role', attrs: `data-id="${attr(r)}"`, destructive: true },
    ...(held ? [{ note: `${plural(held, 'person still holds', 'people still hold')} it` }] : [])
  ];
  const row = `<div class="trow${editing ? ' --editing' : ''}" role="row">
    <span>${roleLabel(r)}</span>
    <span>${plural(held, 'person', 'people')}</span>
    <span>${isExemptRole(r) ? '<span class="exempt-note">Exempt from company-wide rules</span>' : 'Every rule'}</span>
    <span class="${q.maxRequestsPerDay ? '' : 'cell-muted'}">${q.maxRequestsPerDay ? `${q.maxRequestsPerDay} / day` : 'No limit'}</span>
    <span class="row-menu">${menu(items, { label: `Actions for ${r}` })}</span>
  </div>`;
  if (!editing) return row;
  const current = String(q.maxRequestsPerDay ?? '');
  const changed = roleEdit.value.trim() !== current;
  const dropsCeilings = !roleEdit.value.trim() && current && (q.maxSessionOutputTokens || q.maxContextTokens || q.maxPromptChars);
  return `${row}<div class="inline-editor" role="group" aria-label="Daily limit for ${esc(r)}">
    <label for="roleLimit"><b>Daily limit for ${esc(r)}</b></label>
    <input type="text" inputmode="numeric" id="roleLimit" class="field-compact" value="${esc(roleEdit.value)}" placeholder="none" autocomplete="off"${roleEdit.busy ? ' readonly' : ''}>
    <span class="inline-editor-help">requests a day · blank means no limit${dropsCeilings ? ' · clearing it also clears this role’s session ceilings' : ''}</span>
    ${changed ? button(roleEdit.busy ? 'Saving…' : 'Save limit', { kind: 'primary', compact: true, id: 'saveRoleLimit', busy: roleEdit.busy }) : ''}
    ${button('Cancel', { compact: true, id: 'cancelRoleLimit', disabled: roleEdit.busy })}
    ${roleEdit.error ? `<span class="inline-editor-error" role="alert">${esc(roleEdit.error)}</span>` : ''}
  </div>`;
}

function bindRoles() {
  if ($('openNewRole')) $('openNewRole').onclick = () => openDialog('newRole');
  const field = $('roleLimit');
  if (field) {
    field.oninput = () => {
      const was = roleEdit.value.trim() !== String(quotaOf(roleEdit.role).maxRequestsPerDay ?? '');
      roleEdit.value = field.value;
      roleEdit.error = '';
      if (was !== (roleEdit.value.trim() !== String(quotaOf(roleEdit.role).maxRequestsPerDay ?? '')) || !roleEdit.value.trim()) render();
    };
    field.onkeydown = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); roleEdit = null; render(); }
      if (e.key === 'Enter') $('saveRoleLimit')?.click();
    };
  }
  if ($('cancelRoleLimit')) $('cancelRoleLimit').onclick = () => { roleEdit = null; render(); };
  const save = $('saveRoleLimit');
  if (save) save.onclick = async () => {
    const value = limitValue(roleEdit.value);
    roleEdit.busy = true; render();
    const result = await saveQuota(roleEdit.role, { maxRequestsPerDay: value, ...(value == null ? { maxSessionOutputTokens: null, maxContextTokens: null, maxPromptChars: null } : {}) });
    if (!result.ok) { roleEdit.busy = false; roleEdit.error = result.error; render(); return; }
    const role = roleEdit.role;
    roleEdit = null;
    render();
    showToast('Daily limit saved', value ? `${role} can make ${value} requests a day.` : `${role} has no daily limit.`);
  };
}

// ── Company ──────────────────────────────────────────────────────────────────

/**
 * The company's name, the sample, and the reset, as a settings page.
 *
 * The reset says what the gateway does: everyone but the first administrator
 * goes, that administrator gets a new key, stored prompts are cleared, and the
 * rules stay. There is no type-the-name ceremony, because that was sized for a
 * loss of rules that does not happen. How the team reaches this machine is not
 * a company fact and lives on This device.
 */
let orgName = null;

function companyTab() {
  const demo = Boolean(state.company.demo);
  const value = orgName ?? (demo ? '' : state.company.name ?? '');
  const saved = demo ? '' : state.company.name ?? '';
  const people = state.company.employees.length;
  const roles = state.company.roles.length;
  const rules = state.policy.rules.length;
  const installed = demo || Boolean(state.company.sampleInstalledAt);
  return `<div class="reading settings-page">
    <section class="settings-task">
      <h2 class="section-title">Company name</h2>
      <p class="section-lede">Everyone in Team belongs to this company. The name is a label — changing it doesn't change who is judged or which rules apply.</p>
      <div class="inline-form">
        <input type="text" id="orgInput" value="${esc(value)}" placeholder="Your company's name" autocomplete="off">
        ${button('Save name', { id: 'orgSave', disabled: !value.trim() || value.trim() === saved })}
      </div>
    </section>
    <div class="disclosures">
      ${disclosureRow('c:sample', 'Sample data', installed ? `Installed · ${plural(people, 'person', 'people')} · ${plural(roles, 'role')} · ${plural(rules, 'rule')}` : 'Not installed', installed
        ? `${feedback({ tone: 'attention', title: 'Sample rules are enforced', body: 'They judge real requests exactly like the rules you write. Anything they block is really blocked.' })}
           <div>${button('Clear sample data', { id: 'clearSample' })}</div>`
        : `<p class="disclosure-text">A made-up company and the rules that judge it, to look around before your own team is in.</p><div>${button('Load sample data', { id: 'loadSampleCompany' })}</div>`, { open: state.open.has('c:sample') })}
      ${disclosureRow('c:reset', 'Reset company', 'People and prompts · rules stay', `
        <p class="disclosure-text">Removes every person except the first administrator, who gets a fresh key, and clears every stored prompt. Your rules and roles stay. There is no undo.</p>
        <div>${button('Reset company', { kind: 'danger', id: 'openReset' })}</div>`, { open: state.open.has('c:reset') })}
    </div>
    <p class="table-foot">Looking for the address people connect to? That belongs to the machine running Warden, not to the company — it lives in <button type="button" class="linkish" data-go="soloRules">This device</button>.</p>
  </div>`;
}

function bindCompany() {
  const input = $('orgInput');
  const save = $('orgSave');
  if (input && save) {
    const saved = state.company.demo ? '' : state.company.name ?? '';
    input.oninput = () => { orgName = input.value; save.disabled = !input.value.trim() || input.value.trim() === saved; };
    save.onclick = async () => {
      const name = input.value.trim();
      if (!name) return;
      save.disabled = true;
      const { ok, j } = await post('/api/company', { name }, { method: 'PUT' }).catch(() => ({ ok: false, j: null }));
      if (!ok) { showToast('The name was not saved', j?.error ?? 'Warden could not be reached.'); save.disabled = false; return; }
      orgName = null;
      await refreshPeople();
      render();
      showToast('Name saved', `This company is ${name}.`);
    };
  }
  const clear = $('clearSample');
  if (clear) clear.onclick = async () => {
    clear.disabled = true;
    const { ok, j } = await post('/api/company/sample/clear').catch(() => ({ ok: false, j: null }));
    if (!ok) { clear.disabled = false; showToast('The sample was not cleared', j?.error ?? 'Warden could not be reached.'); return; }
    await Promise.all([refreshPolicy(), refreshPeople()]);
    render();
    // Nothing matched, so say that rather than leaving a button that looks
    // broken: the company is already all theirs.
    showToast('Sample data cleared', j.people || j.rules || j.quotas
      ? `Removed what came with Warden: ${plural(j.people ?? 0, 'person', 'people')}, ${plural(j.rules ?? 0, 'rule')}, ${plural(j.quotas ?? 0, 'limit')}. Anything you wrote or edited stays.`
      : 'Nothing here came with Warden. Every rule and every person is yours.');
  };
  const load = $('loadSampleCompany');
  if (load) load.onclick = async () => {
    load.disabled = true;
    await post('/api/company/sample');
    await Promise.all([refreshPolicy(), refreshPeople()]);
    render();
  };
  if ($('openReset')) $('openReset').onclick = () => openDialog('reset');
}
