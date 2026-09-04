/**
 * Team: the company, how it is reached, the people, and one person opened in place with their setup.
 */
import { $, api, attr, esc, state } from './core.js';
import { refreshPeople, refreshPolicy } from './data.js';
import { bindPolicy, sendRuleMessage } from './draft.js';
import { TOOL_NAMES, avatar, clip, copyText, personById, plural, ruleName } from './format.js';
import { bindDisclosures, disclosure, render } from './render.js';
import { go } from './router.js';
import { VIEWS } from './views.js';

// ═══ TEAM ════════════════════════════════════════════════════════════════════

/**
 * The company's own name, and the way out of the demo.
 *
 * A fresh install ships a seeded directory — another company's name and seven
 * invented people — because an empty console teaches nobody anything. Until
 * this existed there was no way to leave it: the name in the title bar was not
 * editable and the demo staff could only be deleted one at a time. That reads
 * as a product stuck in a demo, and it was.
 *
 * "Start fresh" keeps one administrator and issues them a new key, because a
 * directory with nobody in an exempt role is a console that cannot be opened
 * again once `WARDEN_ADMIN_REQUIRE_KEY` is set — and because the point of
 * starting over is that the demo's keys stop working. It leaves the policy
 * alone: rules and people are separate decisions.
 */
/**
 * How the team reaches this gateway, on the screen where somebody is handing
 * out addresses.
 *
 * The control lived only in the macOS menu bar, which is a place you find if
 * you already know it is there. The person who needs it is the administrator
 * looking at Team wondering what URL to send.
 *
 * Both honest properties of a quick tunnel are on the screen rather than in a
 * dialog somebody dismissed a week ago: the address is public to whoever holds
 * it, and it changes every time the tunnel restarts.
 */
function reachBlock() {
  const on = Boolean(state.publicUrl);
  return `<div class="section">
    <div class="label">How your team reaches this</div>

    <div class="kv">
      <div class="r"><span class="k">Address</span>
        <span class="v">${on
          ? `<span class="mono">${esc(state.publicUrl)}</span>`
          : 'This machine only. Teammates elsewhere cannot reach it.'}</span></div>
    </div>

    ${on ? `<div class="note">Anyone with this address reaches the gateway. Employees still
      need their own key, and administration is refused through it. The address changes every
      time the tunnel restarts, and everyone has to be given the new one.</div>` : ''}

    ${state.canLeaveDemo ? `<div class="row-actions">
      <button type="button" class="btn${on ? '' : ' primary'}" id="toggleExpose">
        ${on ? 'Take it off the internet' : 'Put it on the internet'}
      </button>
      ${state.mock ? '<span class="note">Not while Warden is in demo mode: nothing here is really judged.</span>' : ''}
    </div>` : `<div class="note">Run this inside the Warden app to open a tunnel from here,
      or put your own proxy in front of it.</div>`}
  </div>`;
}

function companyBlock() {
  const demo = Boolean(state.company.demo);
  return `<div class="section company">
    <div class="label">Company</div>
    ${demo ? `<div class="banner warn">
      <b>Sample data.</b> ${esc(state.company.name)} and everyone below are made up.
    </div>` : ''}
    <div class="chips">
      <input type="text" id="orgInput" class="inline" value="${demo ? '' : esc(state.company.name ?? '')}"
             placeholder="Your company's name">
      <button type="button" class="btn${demo ? ' primary' : ''}" id="orgSave">${demo ? 'This is us' : 'Rename'}</button>
      <span class="spacer"></span>
      <button type="button" class="btn" id="orgReset">${demo ? 'Clear the sample team' : 'Start fresh…'}</button>
    </div>
    <div class="note" id="orgNote">${state.orgNote ? esc(state.orgNote) : ''}</div>
  </div>`;
}

/**
 * Roles for the add-someone dropdown, with `admin` never first.
 *
 * `admin` sits in `exemptRoles`, which means an admin is measured against no
 * rules at all. It is also alphabetically first, so it was the selected option
 * on a fresh install — and the very first person anybody added, before they
 * had read anything about exemptions, was silently unjudgeable. A default that
 * hands out a bypass is the wrong default however defensible the sort order.
 *
 * It stays in the list, because somebody does have to be one. It is last, it
 * says what it costs, and it is never what you get by not choosing.
 */
function roleOptions() {
  const exempt = new Set(state.policy.exemptRoles ?? ['admin']);
  const ordinary = state.company.roles.filter((r) => !exempt.has(r));
  const privileged = state.company.roles.filter((r) => exempt.has(r));
  return [
    ...ordinary.map((r) => `<option value="${attr(r)}">${esc(r)}</option>`),
    ...privileged.map((r) => `<option value="${attr(r)}">${esc(r)} — exempt from every rule</option>`)
  ].join('');
}

VIEWS.people = {
  body: () => `<div class="sheet">
    ${companyBlock()}
    ${reachBlock()}
    ${state.company.employees.length
      ? state.company.employees.map(personRow).join('')
      : '<div class="empty"><b>Nobody yet</b><span>Add somebody below and Warden issues them a key.</span></div>'}

    <div class="section">
      <div class="label">Add someone</div>
      <div class="chips">
        <input type="text" id="newName" class="inline wide" placeholder="Federico Tavano, Jeremías Souto, Gastón Foncea" autocomplete="off">
        <select class="inline" id="newRole">${roleOptions()}</select>
        <button type="button" class="btn primary" id="addPerson">Add</button>
      </div>
      <div class="note">Commas for several. Enter adds them.</div>
      <div class="note" id="addNote"></div>
    </div>

    <div class="section">
      <div class="label">Roles</div>
      <div class="chips" id="roleChips">
        ${state.company.roles.map((r) => {
          const held = state.company.employees.filter((e) => e.role === r).length;
          return `<span class="chip static" title="${held} employee(s)">${esc(r)} <span class="num">${held}</span>${
            held === 0 ? ` <button type="button" class="linkbtn" data-role="${attr(r)}" aria-label="Remove role ${esc(r)}">✕</button>` : ''}</span>`;
        }).join('')}
      </div>
      <div class="chips">
        <input type="text" id="newRoleName" class="inline" placeholder="New role">
        <input type="number" min="1" id="newRoleQuota" class="inline" placeholder="req/day">
        <button type="button" class="btn" id="addRole">Add role</button>
      </div>
      <div class="note" id="roleNote"></div>
    </div>
  </div>`,
  bind: () => {
    bindPeopleList();
    bindPolicy();
    if (state.sel) void renderPerson(state.sel);
  }
};

function personRow(e) {
  const open = state.sel === e.id;
  return `<button type="button" class="row roomy${open ? ' on' : ''}" data-toggle="people" data-sel="${attr(e.id)}" aria-expanded="${open}">
      ${avatar(e)}
      <span class="col">
        <span class="t">${esc(e.name)}</span>
        <span class="m">
          <span>${esc(e.role)}${e.quota ? ` · ${e.quota}/day` : ''}</span>
          <span>${plural(e.ruleCount, 'rule')}${e.personalRuleCount ? ` · ${e.personalRuleCount} personal` : ''}</span>
        </span>
        <span class="tools">${e.connected?.length
          ? e.connected.map((c) => `<span class="tool on" title="${c.count} request(s), last ${esc(c.at)}">${esc(TOOL_NAMES[c.tool] ?? c.tool)}</span>`).join('')
          : '<span class="tool">not connected yet</span>'}</span>
      </span>
    </button>
    ${open ? '<div class="detail" id="personDetail"><div class="note">loading…</div></div>' : ''}`;
}

function bindPeopleList() {
  const orgSave = $('orgSave');
  if (orgSave) orgSave.onclick = async () => {
    const name = $('orgInput').value.trim();
    if (!name) return;
    const { ok, j } = await api('/api/company', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name })
    });
    state.orgNote = ok ? 'Renamed.' : (j?.error ?? 'could not rename');
    if (ok) await refreshPeople();
    render();
  };

  const orgReset = $('orgReset');
  if (orgReset) orgReset.onclick = async () => {
    const name = $('orgInput').value.trim() || state.company.name;
    // Irreversible and it revokes keys, so it asks. The wording names both
    // consequences rather than asking "are you sure" about nothing in
    // particular.
    const people = state.company.employees.length;
    if (!confirm(
      `Remove ${people === 1 ? 'the 1 person' : `all ${people} people`} and issue the administrator a new key?\n\n` +
      'Their keys stop working right away. Your rules stay.'
    )) return;
    const { ok, j } = await api('/api/company/reset', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name })
    });
    state.orgNote = ok ? 'Started fresh. Add your team below.' : (j?.error ?? 'could not reset');
    if (ok) await refreshPeople();
    render();
  };

  /**
   * Adding people, without a round trip per person.
   *
   * This used to take one name and then navigate into that person's page,
   * which is the right screen to end on when you are adding one person and
   * exactly the wrong one when you are setting up a team: eight people meant
   * eight trips back to this form. It now takes a comma-separated list, adds
   * them in order, and stays here with the field cleared and focused — so the
   * whole team is one paste, and one person is still one name and Enter.
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
      const { ok, j } = await api('/api/people', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, role })
      });
      if (ok) added.push(j); else failed.push(`${name}: ${j.error ?? 'failed'}`);
    }

    await refreshPeople();
    if (added.length === 1 && !failed.length) {
      // One person is still the case where their page — and their key — is
      // what you wanted next.
      go('people', added[0].id);
      return;
    }
    render();
    const note = $('addNote');
    if (note) {
      note.textContent = [
        added.length ? `Added ${added.length}, each with a key on their row.` : '',
        ...failed
      ].filter(Boolean).join(' · ');
    }
    const next = $('newName');
    if (next) { next.value = ''; next.focus(); }
  };

  const add = $('addPerson');
  if (add) add.onclick = addPeople;
  const newName = $('newName');
  // Reaching for the mouse after typing a name is the friction you feel every
  // single time; Enter is the whole fix.
  if (newName) newName.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); void addPeople(); } };

  for (const id of ['newRoleName', 'newRoleQuota']) {
    const el = $(id);
    if (el) el.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('addRole')?.click(); } };
  }

  const addRole = $('addRole');
  if (addRole) addRole.onclick = async () => {
    const role = $('newRoleName').value.trim();
    if (!role) return;
    const { ok, j } = await api('/api/roles', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role, maxRequestsPerDay: Number($('newRoleQuota').value || 0) })
    });
    if (!ok) { $('roleNote').textContent = j.error ?? 'failed'; return; }
    await Promise.all([refreshPeople(), refreshPolicy()]);
    render();
  };

  const chips = $('roleChips');
  if (chips) chips.onclick = async (e) => {
    const x = e.target.closest('[data-role]');
    if (!x) return;
    const role = decodeURIComponent(x.dataset.role);
    if (!confirm(`Remove the role "${role}"? Its daily limit goes with it.`)) return;
    const { ok, j } = await api(`/api/roles/${encodeURIComponent(role)}`, { method: 'DELETE' });
    if (!ok) { $('roleNote').textContent = j.error ?? 'failed'; return; }
    await Promise.all([refreshPeople(), refreshPolicy()]);
    render();
  };
}

/**
 * One person, opened under their row: who they are, and every rule that will
 * judge them — separated by why it binds them, because "everyone" and "written
 * for you" are very different things to be told when a prompt is refused.
 */
async function renderPerson(id) {
  const p = personById(id);
  const host = $('personDetail');
  if (!host) return;
  if (!p) { host.innerHTML = '<div class="note">This person has been removed.</div>'; return; }

  const { j } = await api(`/api/people/${encodeURIComponent(p.id)}/rules`);
  if (!host.isConnected || state.sel !== id) return;
  const rules = j?.rules ?? [];
  const group = (kind) => rules.filter((r) => r.binding === kind);
  const hits = state.audit.filter((a) => a.actor?.id === p.id);
  const stopped = hits.filter((h) => h.decision?.verdict !== 'ALLOW').length;

  const section = (title, list, note) => `
    <div class="group">
      <div class="label">${title} · ${list.length}</div>
      ${list.length
        ? list.map((r) => `
          <button type="button" class="ruleref" data-go="policy" data-sel="${attr(r.id)}">
            <span class="dot ${esc(r.severity)}"></span>
            <span class="col">
              <span class="t">${esc(ruleName(r))}</span>
              <span class="m">${esc(clip(r.text, 110))}</span>
            </span>
          </button>`).join('')
        : `<div class="note">${note}</div>`}
    </div>`;

  host.innerHTML = `
    <div class="person-top">
      ${avatar(p, true)}
      <div>
        <div class="nm">${esc(p.name)}</div>
        <div class="note">${esc(p.role)}${p.quota ? ` · ${p.quota} requests a day` : ' · no daily limit'}</div>
      </div>
    </div>

    <p class="summary">${hits.length
      ? `Warden has looked at ${plural(hits.length, 'request')} from ${esc(p.name.split(' ')[0])} and stopped ${stopped}.`
      : `${esc(p.name.split(' ')[0])} has not sent anything through Warden yet.`}
      ${plural(rules.length, 'rule')} appl${rules.length === 1 ? 'ies' : 'y'} to them.</p>

    ${hits.length ? '<div class="group"><button type="button" class="btn" id="seePerson">See their decisions</button></div>' : ''}

    <div class="field">
      <label for="editRole">Role</label>
      <select id="editRole">${state.company.roles.map((r) => `<option${r === p.role ? ' selected' : ''}>${esc(r)}</option>`).join('')}</select>
    </div>

    <div class="field">
      <label>What they put on their own machine</label>
      <div class="codewrap">
        <pre class="code oneline">export WARDEN_API_KEY=${esc(p.apiKey)}</pre>
        <button type="button" class="btn sm copy" data-copy="${attr('export WARDEN_API_KEY=' + p.apiKey)}">Copy</button>
      </div>
      <div class="note">This key is their identity. A new one revokes the old.</div>
    </div>

    <div class="chips">
      <button type="button" class="btn" id="rotateKey">New key</button>
      <button type="button" class="btn danger" id="removePerson">Remove from team</button>
    </div>
    <div class="note" id="personNote"></div>

    <div class="group">
      <div class="label">Write a rule just for ${esc(p.name.split(' ')[0])}</div>
      <textarea id="personRuleText" rows="2" placeholder="e.g. cannot request data from other teams"></textarea>
      <button type="button" class="btn primary" id="personCompile">Write this rule</button>
    </div>

    <div class="folds">
      ${disclosure('p:onboarding', 'Setup instructions to send them', '<div id="onboarding"><div class="note">loading…</div></div>')}
    </div>

    ${section('Written for them', group('personal'), 'No personal rules, only the company and role ones below.')}
    ${section(`Because they are ${esc(p.role)}`, group('role'), 'No rules target this role.')}
    ${section('Everyone', group('company'), 'No company-wide rules.')}`;

  bindDisclosures();

  $('editRole').onchange = async (e) => {
    const { ok, j } = await api('/api/people', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: p.id, name: p.name, role: e.target.value })
    });
    $('personNote').textContent = ok ? `Now judged as ${j.role}.` : (j.error ?? 'failed');
    if (ok) { await refreshPeople(); void renderPerson(p.id); }
  };

  $('rotateKey').onclick = async () => {
    if (!confirm('Issue a new key? Their current one stops working immediately.')) return;
    await api(`/api/people/${encodeURIComponent(p.id)}/key`, { method: 'POST' });
    await refreshPeople();
    void renderPerson(p.id);
  };

  $('removePerson').onclick = async () => {
    if (!confirm(`Remove ${p.name}? Their key stops working immediately.`)) return;
    const { ok, j } = await api(`/api/people/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
    if (!ok) { $('personNote').textContent = j.error ?? 'failed'; return; }
    await refreshPeople();
    go('people');
    // Rules written only for someone who has left still exist and now bind
    // nobody. Saying so beats leaving dead policy in the list unremarked.
    if (j.orphanedRules?.length) {
      const pane = $('pane').querySelector('.sheet');
      if (pane) pane.insertAdjacentHTML('afterbegin',
        `<div class="banner warn">${j.orphanedRules.length} rule(s) were written only for ${esc(j.removed.name)} and now apply to nobody. Retarget or remove them under Rules.</div>`);
    }
  };

  const seen = $('seePerson');
  if (seen) seen.onclick = () => { state.actorFilter = p.id; go('activity'); };

  $('personCompile').onclick = () => {
    const text = $('personRuleText').value.trim();
    if (!text) return;
    state.draftFor = p.id;
    state.ruleChat = [];
    void sendRuleMessage(text);
  };

  void renderOnboarding(p);
}

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
        <button type="button" class="btn sm copy" data-copy="${attr(st.code)}">Copy</button>
      </div>
    </div>`;

  host.innerHTML = `
    <div><button type="button" class="btn" id="copyAll">Copy the whole message</button></div>
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

  $('copyAll').onclick = (e) => copyText(j.message, e.target);
}
