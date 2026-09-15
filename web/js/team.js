/**
 * Team: the people Warden judges.
 *
 * One thing per tab and one page per person. People is the list, and it is
 * where nearly everything happens in place: the role is a select in the row,
 * and the row's menu carries the rest. Roles and Company are their own tabs
 * rather than sections stacked under the list, because a page that shows four
 * things at once is a page where nothing is the thing you came for.
 *
 * A person is a page, `#/people/<id>`, not a drawer between two rows. It
 * leads with how they are doing (or with the setup they have not done yet),
 * then their key, then the rules that judge them. Removing them and issuing a
 * new key live in the menu, not in a footer that every visit has to scroll
 * past.
 */
import { $, api, attr, del, esc, post, state } from './core.js';
import { refreshPeople, refreshPolicy } from './data.js';
import { bindPolicy, sendRuleMessage } from './draft.js';
import { TOOL_NAMES, avatar, copyText, personById, plural, ruleName } from './format.js';
import { bindLimits, limitEditor } from './limits.js';
import { disclosure, render } from './render.js';
import { go } from './router.js';
import { VIEWS } from './views.js';

// ═══ TEAM ════════════════════════════════════════════════════════════════════

/**
 * `sel` decides what the view is. `roles` and `company` are the tabs; anything
 * else is a person. A person whose id happens to be one of those two words
 * cannot exist: ids are derived from names and those are not names.
 */
const TABS = [['', 'People'], ['roles', 'Roles'], ['company', 'Company']];
const tabOf = () => (state.sel === 'roles' || state.sel === 'company' ? state.sel : state.sel ? null : '');

const toolsOf = (e) => (e.connected ?? []).map((c) => TOOL_NAMES[c.tool] ?? c.tool).join(', ');
const requestsOf = (e) => (e.connected ?? []).reduce((n, c) => n + (c.count ?? 0), 0);
const isConnected = (e) => Boolean(e.connected?.length);
const lastActiveAt = (e) => (e.connected ?? []).map((c) => Date.parse(c.at)).filter(Number.isFinite).sort((a, b) => b - a)[0] ?? null;

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

VIEWS.people = {
  body: () => {
    const tab = tabOf();
    if (tab === null) return personPage(personById(state.sel));
    return `<div class="sheet">
      ${pageHead()}
      ${demoBanner()}
      <nav class="tabs" aria-label="Team sections">
        ${TABS.map(([sel, label]) => `<button type="button" class="tab${tab === sel ? ' --on' : ''}" data-go="people"${sel ? ` data-sel="${sel}"` : ''}>${label}</button>`).join('')}
      </nav>
      ${tab === '' ? peopleTab() : tab === 'roles' ? rolesTab() : companyTab()}
    </div>`;
  },
  bind: () => {
    bindPolicy();
    bindActions();
    const tab = tabOf();
    if (tab === null) { bindPerson(); return; }
    if (tab === '') bindPeople();
    else if (tab === 'roles') bindRoles();
    else bindCompany();
  }
};

// ── the page head, shared by the three tabs ──────────────────────────────────

/**
 * The title and one line that says where the team stands. One fact, said
 * once: the number that asks for something — people who have not connected —
 * is the link; when it is zero the line says so, then how the gateway is
 * reached, which is the next thing an administrator wonders.
 *
 * No button up here. Adding people is the form under the tabs, and a primary
 * button whose whole job was to focus a field already on the screen was the
 * heaviest thing on the page doing the least.
 */
function pageHead() {
  const emps = state.company.employees;
  const unsetup = emps.filter((e) => !isConnected(e)).length;
  const reach = `<span class="muted">${state.publicUrl ? 'reachable on the internet' : 'reachable from this machine only'}</span>`;
  const line = !emps.length
    ? `<span class="muted">nobody yet</span><i>·</i>${reach}`
    : unsetup
      ? `<span>${plural(emps.length, 'person', 'people')}</span><i>·</i>
         <button type="button" class="linkbtn strong" data-go="people" data-q="only=unsetup">${unsetup} without setup →</button>`
      : `<span>${plural(emps.length, 'person', 'people')}</span><i>·</i><span>all connected</span><i>·</i>${reach}`;
  return `<header class="page-head">
    <div>
      <h1 class="page-title">Team</h1>
      <div class="page-status">${line}</div>
    </div>
  </header>`;
}

/**
 * A seeded directory says so where the seeded people are seen, not only on
 * the tab with the rename field. Somebody opening Team for the first time is
 * looking at eight people they never added; the sentence that explains that
 * has to be above them.
 */
function demoBanner() {
  if (!state.company.demo) return '';
  return `<div class="banner warn demo"><b>Sample data.</b> ${esc(state.company.name)} and everyone in it are made up.
    <button type="button" class="linkish" data-go="people" data-sel="company">Make it yours</button></div>`;
}

// ── People ───────────────────────────────────────────────────────────────────

/**
 * Roles for the add-someone dropdown, with `admin` never first.
 *
 * `admin` sits in `exemptRoles`, which means an admin is measured against no
 * rules at all. It is also alphabetically first, so it was the selected option
 * on a fresh install — and the very first person anybody added, before they
 * had read anything about exemptions, was silently unjudgeable. A default that
 * hands out a bypass is the wrong default however defensible the sort order.
 */
function roleOptions(selected, short = false) {
  const exempt = new Set(state.policy.exemptRoles ?? ['admin']);
  const ordinary = state.company.roles.filter((r) => !exempt.has(r));
  const privileged = state.company.roles.filter((r) => exempt.has(r));
  const opt = (r, suffix = '') => `<option value="${attr(r)}"${r === selected ? ' selected' : ''}>${esc(r)}${suffix}</option>`;
  // A select is as wide as its widest option, so the one in a row says
  // `admin`, not the sentence; the sentence is on the Roles tab.
  return [...ordinary.map((r) => opt(r)), ...privileged.map((r) => opt(r, short ? '' : ' — exempt from every rule'))].join('');
}

function peopleTab() {
  const only = state.query.only === 'unsetup';
  const all = state.company.employees;
  const emps = only ? all.filter((e) => !isConnected(e)) : all;
  return `
    <div class="add-row">
      <input type="text" id="newName" class="grow" placeholder="Names, comma-separated" autocomplete="off">
      <select id="newRole">${roleOptions()}</select>
      <button type="button" class="btn --primary" id="addPerson">Add</button>
    </div>
    <div class="note under" id="addNote"></div>
    ${only ? `<div class="filter-note">Only ${plural(emps.length, 'person', 'people')} without setup ·
        <button type="button" class="linkish" data-go="people">Show everyone</button></div>` : ''}
    ${all.length
      ? `<div class="tbl">
          <div class="thead"><span>Person</span><span>Role</span><span>Connected</span><span>Last active</span><span></span></div>
          ${emps.map(personRow).join('')}
        </div>`
      : '<div class="empty"><b>Nobody yet</b><span>Add somebody above and Warden issues them a key.</span></div>'}`;
}

/**
 * One row. The name opens the page; the role edits in place; the menu has
 * what used to need the page open.
 *
 * No rule count. It read the same in every row and "0" on the admin with no
 * hint that exemption was why — a column that is always the same number is
 * decoration. Exemption is said where it applies, beside the role; the rules
 * themselves are the page's job. Last active is what an administrator
 * actually sweeps a list of people for.
 */
function personRow(e) {
  const on = isConnected(e);
  const exempt = new Set(state.policy.exemptRoles ?? ['admin']).has(e.role);
  return `<div class="trow">
    <button type="button" class="pname" data-go="people" data-sel="${attr(e.id)}">${avatar(e)}<span class="nm">${esc(e.name)}</span></button>
    <span class="c-role">
      <select class="mini" data-role-of="${attr(e.id)}" aria-label="Role of ${esc(e.name)}">${roleOptions(e.role, true)}</select>
      ${exempt ? '<span class="chip warn" title="Measured against no rules">Exempt</span>' : ''}
    </span>
    <span class="c-conn${on ? ' on' : ''}"><i class="dot"></i>${on ? `${esc(toolsOf(e))} · ${plural(requestsOf(e), 'request')}` : 'Not connected yet'}</span>
    <span class="c-when">${ago(lastActiveAt(e))}</span>
    ${menu(e.id, [['open', 'Open'], ['key', 'New key'], ['remove', 'Remove from team', 'danger']])}
  </div>`;
}

function menu(id, items) {
  return `<details class="menu">
    <summary aria-label="More">···</summary>
    <div class="menu-list">
      ${items.map(([act, label, cls]) => `<button type="button" class="menu-item${cls ? ` --${cls === 'danger' ? 'destructive' : cls}` : ''}" data-act="${act}" data-id="${attr(id)}">${label}</button>`).join('')}
    </div>
  </details>`;
}

// A menu closes when you click anywhere else. Once for the document, not per
// render: menus are rebuilt with every render and the listener is not.
document.addEventListener('click', (e) => {
  for (const m of document.querySelectorAll('details.menu[open]')) if (!m.contains(e.target)) m.removeAttribute('open');
});

function bindPeople() {
  /**
   * Adding people, without a round trip per person.
   *
   * A comma-separated list is added in order and the field is left cleared and
   * focused, so a whole team is one paste. One person is still one name and
   * Enter — and for one person, their page (and their key) is what you wanted
   * next, so that is where it goes.
   *
   * Sequential rather than concurrent because ids are derived from names and
   * two people called Ana must not race for the same one.
   */
  const addPeople = async () => {
    const field = $('newName');
    const names = field.value.split(',').map((n) => n.trim()).filter(Boolean);
    if (!names.length) return;
    const role = $('newRole').value;
    const added = [];
    const failed = [];
    for (const name of names) {
      const { ok, j } = await post('/api/people', { name, role });
      if (ok) added.push(j); else failed.push(`${name}: ${j.error ?? 'failed'}`);
    }
    await refreshPeople();
    if (added.length === 1 && !failed.length) { go('people', added[0].id); return; }
    render();
    const note = $('addNote');
    if (note) note.textContent = [added.length ? `Added ${added.length}.` : '', ...failed].filter(Boolean).join(' · ');
    const next = $('newName');
    if (next) { next.value = ''; next.focus(); }
  };
  $('addPerson').onclick = addPeople;
  $('newName').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); void addPeople(); } };

  for (const sel of document.querySelectorAll('select[data-role-of]')) {
    sel.onchange = async (e) => {
      const p = personById(sel.dataset.roleOf);
      if (!p) return;
      const { ok, j } = await post('/api/people', { id: p.id, name: p.name, role: e.target.value });
      if (!ok) { $('addNote').textContent = j.error ?? 'could not change role'; }
      await refreshPeople();
      render();
    };
  }
}

// ── Roles ────────────────────────────────────────────────────────────────────

/**
 * What a role decides: a daily limit and whether the rules apply at all.
 * Exemption is the one fact here that is easy to hand out by accident, so it
 * is the one thing in colour.
 */
function rolesTab() {
  const exempt = new Set(state.policy.exemptRoles ?? ['admin']);
  const quotas = new Map((state.policy.quotas ?? []).map((q) => [q.role, q]));
  return `<div class="tbl roles">
    <div class="thead"><span>Role</span><span>People</span><span>Daily limit</span><span>Judged by</span><span></span></div>
    ${state.company.roles.map((r) => {
      const held = state.company.employees.filter((e) => e.role === r).length;
      const q = quotas.get(r);
      const editing = state.quotaEdit === r;
      return `<div class="trow">
        <span class="strong">${esc(r)}</span>
        <span>${held}</span>
        <span><button type="button" class="linkbtn" data-quota="${attr(r)}" aria-expanded="${editing}">${q?.maxRequestsPerDay ? `${q.maxRequestsPerDay} / day` : 'No limit'}</button></span>
        <span>${exempt.has(r) ? '<span class="chip warn">Exempt from every rule</span>' : 'Every rule'}</span>
        ${held === 0 ? menu(r, [['remove-role', 'Remove role', 'danger']]) : '<span></span>'}
      </div>
      ${editing ? `<div class="trow-note">${limitEditor(r)}</div>` : ''}`;
    }).join('')}
    <div class="tfoot">
      <input type="text" id="newRoleName" class="grow" placeholder="New role">
      <input type="number" min="1" id="newRoleQuota" placeholder="Requests / day">
      <button type="button" class="btn" id="addRole">Add role</button>
    </div>
  </div>
  <div class="note under">A daily limit opens its role's ceilings — output, context and prompt size.
    Token counts are reported by the tool, not measured here.</div>
  <div class="note under" id="roleNote"></div>`;
}

function bindRoles() {
  bindLimits();
  const addRole = async () => {
    const role = $('newRoleName').value.trim();
    if (!role) return;
    const { ok, j } = await post('/api/roles', { role, maxRequestsPerDay: Number($('newRoleQuota').value || 0) });
    if (!ok) { $('roleNote').textContent = j.error ?? 'failed'; return; }
    await Promise.all([refreshPeople(), refreshPolicy()]);
    render();
  };
  $('addRole').onclick = addRole;
  for (const id of ['newRoleName', 'newRoleQuota']) {
    $(id).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); void addRole(); } };
  }
}

// ── Company ──────────────────────────────────────────────────────────────────

/**
 * The company's own name, and how the team reaches this machine. Set once,
 * so it is the last tab, not the first thing on the page.
 *
 * "Start fresh" keeps one administrator and issues them a new key, because a
 * directory with nobody in an exempt role is a console that cannot be opened
 * again once `WARDEN_ADMIN_REQUIRE_KEY` is set — and because the point of
 * starting over is that the demo's keys stop working. It leaves the policy
 * alone: rules and people are separate decisions.
 *
 * Both honest properties of a quick tunnel are on the screen rather than in a
 * dialog somebody dismissed a week ago: the address is public to whoever holds
 * it, and it changes every time the tunnel restarts.
 */
function companyTab() {
  const demo = Boolean(state.company.demo);
  const on = Boolean(state.publicUrl);
  return `<div class="cards">
    <section class="card">
      <div class="label">Company</div>
      ${demo ? `<div class="banner warn"><b>Sample data.</b> ${esc(state.company.name)} and everyone in it are made up.</div>` : ''}
      <div class="inline-row">
        <input type="text" id="orgInput" class="grow" value="${demo ? '' : esc(state.company.name ?? '')}" placeholder="Your company's name">
        <button type="button" class="btn${demo ? ' primary' : ''}" id="orgSave">${demo ? 'This is us' : 'Rename'}</button>
      </div>
      <div class="note" id="orgNote">${state.orgNote
        ? esc(state.orgNote)
        : `<button type="button" class="linkish" id="orgReset">${demo ? 'Clear the sample team' : 'Start fresh…'}</button> removes everyone and issues you a new key. Your rules stay.`}</div>
    </section>

    <section class="card">
      <div class="label">Address</div>
      <div class="v">${on ? `<span class="mono">${esc(state.publicUrl)}</span>` : 'This machine only. Teammates elsewhere cannot reach it.'}</div>
      ${state.canLeaveDemo
        ? `<div class="inline-row">
            <button type="button" class="btn" id="toggleExpose"${state.mock ? ' disabled' : ''}>${on ? 'Take it off the internet' : 'Put it on the internet'}</button>
           </div>
           <div class="note" id="exposeNote">${state.mock
             ? 'Not while Warden is in demo mode: nothing here is really judged.'
             : 'Anyone with the address reaches the gateway; they still need a key. It changes every time the tunnel restarts.'}</div>`
        : '<div class="note">Open a tunnel from the Warden app, or put your own proxy in front of it.</div>'}
    </section>
  </div>`;
}

function bindCompany() {
  $('orgSave').onclick = async () => {
    const name = $('orgInput').value.trim();
    if (!name) return;
    const { ok, j } = await post('/api/company', { name }, { method: 'PUT' });
    state.orgNote = ok ? 'Renamed.' : (j?.error ?? 'could not rename');
    if (ok) await refreshPeople();
    render();
  };

  const reset = $('orgReset');
  if (reset) reset.onclick = async () => {
    const name = $('orgInput').value.trim() || state.company.name;
    // Irreversible and it revokes keys, so it asks. The wording names both
    // consequences rather than asking "are you sure" about nothing in
    // particular.
    const people = state.company.employees.length;
    if (!confirm(
      `Remove ${people === 1 ? 'the 1 person' : `all ${people} people`} and issue the administrator a new key?\n\n` +
      'Their keys stop working right away. Your rules stay.'
    )) return;
    const { ok, j } = await post('/api/company/reset', { name });
    state.orgNote = ok ? 'Started fresh. Add your team under People.' : (j?.error ?? 'could not reset');
    if (ok) await refreshPeople();
    render();
  };

  const expose = $('toggleExpose');
  if (expose) expose.onclick = async () => {
    const enabled = !state.publicUrl;
    expose.disabled = true;
    expose.textContent = enabled ? 'Opening the tunnel…' : 'Closing the tunnel…';
    const { ok, j } = await post('/api/gateway/expose', { enabled });
    const note = $('exposeNote');
    if (!ok) {
      expose.disabled = false;
      expose.textContent = enabled ? 'Put it on the internet' : 'Take it off the internet';
      if (note) note.textContent = j?.error ?? 'could not change that';
      return;
    }
    // 202: asked, not done. The gateway restarts behind the tunnel and the
    // console learns the address from /health once it is back.
    if (note) note.textContent = enabled
      ? 'Opening. The address appears here when the gateway is back, usually within a few seconds.'
      : 'Closing. The address stops working as soon as the gateway is back.';
  };
}

// ── one person ───────────────────────────────────────────────────────────────

/**
 * The page for one person. It answers, in order: how are they doing (or have
 * they even connected), what do they put on their machine, and which rules
 * judge them and why. Nothing here explains itself in a paragraph; the
 * numbers and the list are the explanation.
 */
function personPage(p) {
  if (!p) {
    return `<div class="sheet person">
      <button type="button" class="back linkish" data-go="people">← Team</button>
      <div class="empty"><b>This person has been removed.</b></div>
    </div>`;
  }
  const first = esc(p.name.split(' ')[0]);
  const hits = state.audit.filter((a) => a.actor?.id === p.id);
  const stopped = hits.filter((h) => h.decision?.verdict !== 'ALLOW').length;
  const on = isConnected(p);

  return `<div class="sheet person">
    <button type="button" class="back linkish" data-go="people">← Team</button>

    <header class="person-head">
      ${avatar(p, true)}
      <div class="grow">
        <h1 class="page-title">${esc(p.name)}</h1>
        <div class="person-meta">
          <select id="editRole" class="mini" aria-label="Role">${roleOptions(p.role, true)}</select>
          <span class="c-conn${on ? ' on' : ''}"><i class="dot"></i>${on ? esc(toolsOf(p)) : 'Not connected yet'}</span>
          ${p.quota ? `<span>${p.quota} requests a day</span>` : ''}
        </div>
      </div>
      ${menu(p.id, [['key', 'New key'], ['decisions', 'See their decisions'], ['remove', 'Remove from team', 'danger']])}
    </header>
    <div class="note under" id="personNote"></div>

    ${on || hits.length
      ? `<div class="stats">
          <div class="stat"><b>${hits.length}</b><span>${hits.length === 1 ? 'request seen' : 'requests seen'}</span></div>
          <div class="stat"><b${stopped ? ' class="block"' : ''}>${stopped}</b><span>stopped</span></div>
          <div class="stat"><b id="ruleStat">${p.ruleCount}</b><span>${p.ruleCount === 1 ? 'rule judges them' : 'rules judge them'}</span></div>
          <button type="button" class="stat-link" data-act="decisions" data-id="${attr(p.id)}">See decisions →</button>
        </div>`
      : `<div class="setup-card">
          <div><b>${first} has not connected yet.</b><span class="note">The setup message has their key and the steps for every tool. Send it to them.</span></div>
          <button type="button" class="btn --primary" data-act="copy-setup" data-id="${attr(p.id)}">Copy setup message</button>
        </div>`}

    <section class="block">
      <div class="label">Key</div>
      <div class="key-row">
        <span class="mono grow" title="Their identity. A new one revokes the old.">${esc(maskKey(p.apiKey))}</span>
        <button type="button" class="linkbtn" data-copy="${attr(`export WARDEN_API_KEY=${p.apiKey}`)}">Copy key</button>
        ${on || hits.length ? `<button type="button" class="linkbtn" data-act="copy-setup" data-id="${attr(p.id)}">Copy setup message</button>` : ''}
      </div>
      <div class="folds">
        ${disclosure('p:onboarding', 'Setup steps, tool by tool', '<div id="onboarding"><div class="note">loading…</div></div>')}
      </div>
    </section>

    <section class="block">
      <div class="label">Rules</div>
      <div class="rule-list" id="personRules"><div class="note">loading…</div></div>
      <div class="rule-add">
        ${state.personCompose === p.id
          ? `<textarea id="personRuleText" rows="2" placeholder="e.g. cannot request data from other teams"></textarea>
             <div class="inline-row">
               <button type="button" class="btn --primary" id="personCompile">Write this rule</button>
               <button type="button" class="btn --link" id="personCancel">Cancel</button>
             </div>`
          : `<button type="button" class="linkish" id="personCompose">+ Write a rule for ${first}</button>`}
      </div>
    </section>
  </div>`;
}

function bindPerson() {
  const p = personById(state.sel);
  if (!p) return;

  $('editRole').onchange = async (e) => {
    const { ok, j } = await post('/api/people', { id: p.id, name: p.name, role: e.target.value });
    $('personNote').textContent = ok ? `Now judged as ${j.role}.` : (j.error ?? 'failed');
    if (ok) { await refreshPeople(); render(); }
  };

  const compose = $('personCompose');
  if (compose) compose.onclick = () => { state.personCompose = p.id; render(); $('personRuleText')?.focus(); };
  const cancel = $('personCancel');
  if (cancel) cancel.onclick = () => { state.personCompose = null; render(); };
  const compile = $('personCompile');
  if (compile) compile.onclick = () => {
    const text = $('personRuleText').value.trim();
    if (!text) return;
    state.personCompose = null;
    state.draftFor = p.id;
    state.ruleChat = [];
    void sendRuleMessage(text);
  };

  void fillRules(p);
  void renderOnboarding(p);
}

/**
 * Every rule that will judge this person, personal ones first, with why it
 * binds them on the right — because "everyone" and "written for you" are very
 * different things to be told when a prompt is refused.
 */
async function fillRules(p) {
  const host = $('personRules');
  if (!host) return;
  const { j } = await api(`/api/people/${encodeURIComponent(p.id)}/rules`);
  if (!host.isConnected || state.sel !== p.id) return;
  const order = { personal: 0, role: 1, company: 2 };
  const rules = [...(j?.rules ?? [])].sort((a, b) => (order[a.binding] ?? 3) - (order[b.binding] ?? 3));
  const why = { personal: `for ${p.name.split(' ')[0]}`, role: p.role, company: 'everyone' };
  host.innerHTML = rules.length
    ? rules.map((r) => `<button type="button" class="rule-line" data-go="policy" data-sel="${attr(r.id)}">
        <span class="dot ${esc(r.severity)}"></span>
        <span class="t">${esc(ruleName(r))}</span>
        <span class="why">${esc(why[r.binding] ?? '')}</span>
      </button>`).join('')
    : '<div class="note">No rule applies to them yet.</div>';
  // The row's count and this list can disagree for an exempt role — the list
  // says which rules name them, the count says which will fire — so the
  // number and its label follow the list once it is here.
  const stat = $('ruleStat');
  if (stat) {
    stat.textContent = rules.length;
    stat.nextElementSibling.textContent = rules.length === 1 ? 'rule judges them' : 'rules judge them';
  }
}

// ── actions shared by rows, the page, and their menus ────────────────────────

/**
 * One handler on the pane for every `data-act`. Menus are rebuilt on each
 * render, so binding them one by one would be a loop that has to be right in
 * three places; delegating is right once.
 */
function bindActions() {
  $('pane').onclick = async (e) => {
    // The pane outlives this view; the handler must not act on another one.
    if (state.view !== 'people') return;
    const el = e.target.closest('[data-act]');
    if (!el) return;
    el.closest('details.menu')?.removeAttribute('open');
    const id = el.dataset.id;
    const p = personById(id);

    switch (el.dataset.act) {
      case 'open':
        go('people', id);
        return;

      case 'decisions':
        state.actorFilter = id;
        go('activity');
        return;

      case 'copy-setup': {
        const { ok, j } = await api(`/api/people/${encodeURIComponent(id)}/onboarding`);
        if (ok) await copyText(j.message, el);
        else if ($('personNote')) $('personNote').textContent = j?.error ?? 'could not build the setup message';
        return;
      }

      case 'key':
        if (!p || !confirm(`Issue ${p.name} a new key? Their current one stops working immediately.`)) return;
        await post(`/api/people/${encodeURIComponent(id)}/key`);
        await refreshPeople();
        render();
        if ($('personNote')) $('personNote').textContent = 'New key issued. The old one no longer works.';
        return;

      case 'remove': {
        if (!p || !confirm(`Remove ${p.name}? Their key stops working immediately.`)) return;
        const { ok, j } = await del(`/api/people/${encodeURIComponent(id)}`);
        if (!ok) { const n = $('personNote') ?? $('addNote'); if (n) n.textContent = j.error ?? 'failed'; return; }
        await refreshPeople();
        go('people');
        // Rules written only for someone who has left still exist and now bind
        // nobody. Saying so beats leaving dead policy in the list unremarked.
        if (j.orphanedRules?.length) {
          const pane = $('pane').querySelector('.sheet');
          if (pane) pane.insertAdjacentHTML('afterbegin',
            `<div class="banner warn">${j.orphanedRules.length} rule(s) were written only for ${esc(j.removed.name)} and now apply to nobody. Retarget or remove them under Rules.</div>`);
        }
        return;
      }

      case 'remove-role': {
        if (!confirm(`Remove the role "${id}"? Its daily limit goes with it.`)) return;
        const { ok, j } = await del(`/api/roles/${encodeURIComponent(id)}`);
        if (!ok) { $('roleNote').textContent = j.error ?? 'failed'; return; }
        await Promise.all([refreshPeople(), refreshPolicy()]);
        render();
        return;
      }
    }
  };
}

// ── onboarding, folded under the key ─────────────────────────────────────────

/**
 * The setup for one person, per tool, with their values already in it.
 *
 * Generated on the server rather than assembled here, so the console and a
 * pasted chat message say the same thing, and so the gateway address is one the
 * server knows is reachable rather than one the admin typed from memory.
 */
async function renderOnboarding(person) {
  const host = $('onboarding');
  if (!host) return;
  const { ok, j } = await api(`/api/people/${encodeURIComponent(person.id)}/onboarding`);
  if (!host.isConnected) return;
  if (!ok) { host.innerHTML = `<div class="note">${esc(j.error ?? 'failed')}</div>`; return; }

  const tools = j.integrations;
  const step = (st) => `
    <div class="group">
      <div class="note"><b>${esc(st.title)}</b></div>
      ${st.note ? `<div class="note">${esc(st.note)}</div>` : ''}
      <div class="codewrap">
        <pre class="code">${esc(st.code)}</pre>
        <button type="button" class="btn --compact copy" data-copy="${attr(st.code)}">Copy</button>
      </div>
    </div>`;

  host.innerHTML = `
    <div class="label">Everyone does this first</div>
    ${j.common.map(step).join('')}
    <div class="label">Then their tool</div>
    <div class="chips" id="toolTabs">
      ${tools.map((t, i) => `<button type="button" class="chip${i === 0 ? ' on' : ''}" data-tool="${i}">${esc(t.name)}</button>`).join('')}
    </div>
    <div id="toolBody"></div>`;

  const showTool = (i) => {
    const t = tools[i];
    $('toolBody').innerHTML = `
      <div class="group">
        <div class="chips">
          <span class="chip static">${t.kind === 'hook' ? 'checks before the prompt leaves the machine' : 'routes through the gateway'}</span>
          <span class="chip static">${t.worksOnSubscription ? 'works on a subscription' : 'needs an API key'}</span>
          <span class="badge ${t.verified ? 'ALLOW' : 'BLOCK'}">${t.verified ? 'verified working' : 'unverified'}</span>
        </div>
        <div class="note">${esc(t.summary)}</div>
        ${t.steps.map(step).join('')}
      </div>`;
  };
  showTool(0);

  $('toolTabs').onclick = (e) => {
    const chip = e.target.closest('[data-tool]');
    if (!chip) return;
    [...$('toolTabs').children].forEach((c) => c.classList.toggle('on', c === chip));
    showTool(Number(chip.dataset.tool));
  };
}
