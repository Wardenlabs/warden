/**
 * Console behaviour. Plain ES modules, no framework, no build step.
 *
 * Three views, matching the three people who care: the admin who writes the
 * rules, whoever has to explain a decision afterwards, and the directory of
 * everyone the rules land on. The trace is a first-class pane rather than a
 * debug view because "auditable in five seconds" only counts if the audit is
 * visible while the thing runs.
 */

const $ = (id) => document.getElementById(id);
const api = (path, opts) => fetch(path, opts).then((r) => r.json().then((j) => ({ ok: r.ok, status: r.status, j })));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let policy = { rules: [], quotas: [], version: '' };
let company = { name: '', roles: [], employees: [] };
let presets = [];
let selectedPerson = null;

/**
 * The rule being drafted, and where it is being drafted.
 *
 * One draft at a time, deliberately. Two half-written rules in two panels is a
 * way to activate the wrong one.
 */
let draft = null;
let draftHost = 'admin';

// ── boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  const health = await api('/health').catch(() => null);
  const pill = $('adapter');
  if (!health?.ok) {
    pill.textContent = 'server down';
    pill.className = 'pill mock';
    return;
  }
  pill.textContent = health.j.mock ? 'mock adapter' : 'local model';
  pill.className = `pill ${health.j.mock ? 'mock' : 'live'}`;

  await refreshPolicy();
  await refreshPeople();
  await loadPresets();
  subscribe();
}

async function refreshPolicy() {
  const { j } = await api('/api/policy');
  policy = j;
  $('ver').textContent = j.version.slice(0, 8);
  $('policyPill').textContent = `${j.rules.length} rules`;
  renderRules();
  renderQuotas();
}

async function refreshPeople() {
  const { j } = await api('/api/people');
  company = j;
  $('companyName').textContent = j.name || 'local AI gateway';
  $('headcount').textContent = `${j.employees.length} people · ${j.roles.length} roles`;
  renderPeople();
  renderRoles();
  renderWhoPicker();
  if (selectedPerson) {
    const still = j.employees.find((e) => e.id === selectedPerson.id);
    selectedPerson = still ?? null;
    renderPersonDetail();
  }
}

// ── avatars ──────────────────────────────────────────────────────────────────

/**
 * Initials on a tinted disc, coloured from a hash of the id.
 *
 * No photo service, no gravatar, no network call — this whole product's claim
 * is that nothing leaves the machine, and a console that phones out for
 * profile pictures would be the first thing a judge notices in devtools.
 */
const AVATAR_COLORS = [
  ['#e8f0fe', '#1a56db'], ['#fdecee', '#c11c25'], ['#e6f6ed', '#0b7a3c'],
  ['#fdf3e3', '#96590a'], ['#f1eafc', '#6429c4'], ['#e6f5f8', '#0d6f7d'],
  ['#fdeaf3', '#b02a72'], ['#eef1f6', '#44546a']
];

function avatar(person, big = false) {
  let h = 0;
  for (const ch of person.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [bg, fg] = AVATAR_COLORS[h % AVATAR_COLORS.length];
  const initials = person.name.split(/\s+/).slice(0, 2).map((w) => w[0] ?? '').join('').toUpperCase();
  return `<div class="avatar${big ? ' lg' : ''}" style="background:${bg};color:${fg}">${esc(initials)}</div>`;
}

/**
 * Copy to clipboard, with a fallback that actually matters here.
 *
 * The console is normally opened over the LAN at http://192.168.x.x, which is
 * not a secure context, and `navigator.clipboard` is undefined there. A copy
 * button that silently does nothing on the machine the admin is actually using
 * is worse than no button.
 */
async function copyText(text, btn) {
  let ok = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch { /* fall through to the textarea trick */ }

  if (!ok) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.append(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }

  if (btn) {
    const original = btn.textContent;
    btn.textContent = ok ? 'Copied' : 'Select it manually';
    setTimeout(() => { btn.textContent = original; }, 1600);
  }
}

// ── admin: presets ───────────────────────────────────────────────────────────

async function loadPresets() {
  const { j } = await api('/api/policy/presets');
  presets = Array.isArray(j) ? j : [];
  $('cats').innerHTML = presets
    .map((c, i) => `<button class="chip" data-cat="${i}">${esc(c.label ?? c.category)}</button>`)
    .join('');
  $('cats').onclick = (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    [...$('cats').children].forEach((b) => b.classList.toggle('on', b === btn));
    showPresets(Number(btn.dataset.cat));
  };
}

function showPresets(i) {
  const cat = presets[i];
  if (!cat) return;
  $('presetList').innerHTML = cat.rules
    .map((r, k) => `<div class="rule pick" data-cat="${i}" data-r="${k}">
        <div class="t">${esc(r.text)}</div>
        <div class="m"><span class="tag ${r.severity}">${r.severity}</span> ${esc(audienceLabel(r.appliesTo))}</div>
      </div>`)
    .join('');
  $('presetList').onclick = (e) => {
    const el = e.target.closest('.rule');
    if (!el) return;
    // A preset arrives complete; it goes straight into the draft slot so the
    // admin still passes through preview and ratify rather than the catalogue
    // being a way to skip them.
    const r = presets[Number(el.dataset.cat)].rules[Number(el.dataset.r)];
    draft = { ...r, id: `r-preset-${Date.now().toString(36)}` };
    draftHost = 'admin';
    renderDraft();
  };
}

// ── admin: compile ───────────────────────────────────────────────────────────

$('compile').onclick = () => compileInto('admin', $('ruleText').value, null, $('compileNote'), $('compile'));

/**
 * Compile a sentence into a rule.
 *
 * `lockTo` is passed when the admin is writing from inside one person's page.
 * They already said who the rule is for by being there, and re-deriving that
 * from the prose is a way for a small model to bind the rule to the whole
 * company by accident.
 */
async function compileInto(host, text, lockTo, noteEl, btnEl) {
  const clean = String(text ?? '').trim();
  if (!clean) return;
  if (btnEl) btnEl.disabled = true;
  if (noteEl) noteEl.textContent = 'compiling on the local model…';

  const { ok, j } = await api('/api/policy/draft', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(lockTo ? { text: clean, lockTo } : { text: clean })
  });

  if (btnEl) btnEl.disabled = false;
  if (noteEl) noteEl.textContent = ok ? '' : (j.error ?? 'failed');
  if (!ok) return;

  draft = j;
  draftHost = host;
  renderDraft();
}

/** Where the draft card renders right now — the admin panel or a person's page. */
function draftContainer() {
  return draftHost === 'admin' ? $('draft') : $('personDraft');
}

function renderDraft() {
  // Only one draft exists, so clear whichever container is not hosting it.
  for (const el of [$('draft'), $('personDraft')]) if (el) el.innerHTML = '';
  const d = draftContainer();
  if (!d || !draft) return;

  const locked = draftHost !== 'admin';
  d.innerHTML = `
    <div class="rule draft" style="margin-top:12px">
      <div class="t">${esc(draft.text)}</div>
      <div class="m">
        <span class="tag ${draft.severity}">${draft.severity}</span>
        <span class="tag">${draft.scope}</span>
      </div>

      <div class="sub" style="margin:13px 0 7px">Applies to</div>
      ${locked
        ? `<div class="note">${esc(audienceLabel(draft.appliesTo))} — locked, you are writing this from their page.</div>`
        : `<div class="chips" id="audienceChips"></div>`}

      ${draft.guidance ? `<div class="sub" style="margin:14px 0 6px">What the employee is told instead</div>
      <div class="note">${esc(draft.guidance)}</div>` : ''}

      <div class="sub" style="margin:14px 0 6px">Would block</div>
      ${draft.examples.violating.map((e) => `<div class="note">· ${esc(e)}</div>`).join('')}
      <div class="sub" style="margin:11px 0 6px">Must still allow</div>
      ${draft.examples.compliant.map((e) => `<div class="note">· ${esc(e)}</div>`).join('')}

      <div class="row">
        <button class="ghost" id="previewBtn">Preview</button>
        <button class="act" id="ratifyBtn">Activate</button>
        <button class="ghost" id="dropBtn">Discard</button>
      </div>
      <div id="previewOut"></div>
    </div>`;

  if (!locked) renderAudienceChips();

  $('previewBtn').onclick = runPreview;
  $('dropBtn').onclick = () => { draft = null; renderDraft(); };
  $('ratifyBtn').onclick = async () => {
    $('ratifyBtn').disabled = true;
    await api('/api/policy/ratify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rule: draft })
    });
    draft = null;
    $('ruleText').value = '';
    const pt = $('personRuleText');
    if (pt) pt.value = '';
    renderDraft();
    await refreshPolicy();
    await refreshPeople();
  };
}

/**
 * The audience editor.
 *
 * The model proposes who a rule binds; the admin decides. Getting this wrong in
 * either direction is expensive — too broad and the whole company trips over a
 * rule meant for one team, too narrow and it guards nobody — and the admin is
 * the only one who knows which was intended.
 */
function renderAudienceChips() {
  const el = $('audienceChips');
  if (!el) return;
  const on = new Set(draft.appliesTo);
  const opts = [
    { token: '*', label: 'Everyone' },
    ...company.roles.map((r) => ({ token: r, label: r })),
    ...company.employees.map((e) => ({ token: `@${e.id}`, label: e.name }))
  ];
  el.innerHTML = opts
    .map((o) => `<span class="chip${on.has(o.token) ? ' on' : ''}" data-token="${esc(o.token)}">${esc(o.label)}</span>`)
    .join('');
  el.onclick = (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const token = chip.dataset.token;
    const next = new Set(draft.appliesTo);
    if (token === '*') {
      // "Everyone" is not one audience among many — it subsumes them.
      draft.appliesTo = ['*'];
    } else {
      next.delete('*');
      next.has(token) ? next.delete(token) : next.add(token);
      draft.appliesTo = next.size ? [...next] : ['*'];
    }
    renderAudienceChips();
  };
}

/**
 * The step that keeps a badly-worded rule from reaching anyone.
 *
 * False positives are called out loudly rather than folded into a score,
 * because a rule that blocks legitimate work is the failure that actually
 * costs the company something, and the admin is the only person positioned to
 * catch it before it ships.
 */
async function runPreview() {
  $('previewOut').innerHTML = '<div class="note" style="margin-top:10px">running the real adjudicator…</div>';
  const { ok, j } = await api('/api/policy/preview', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rule: draft })
  });
  if (!ok) { $('previewOut').innerHTML = `<div class="note">${esc(j.error)}</div>`; return; }

  $('previewOut').innerHTML = `
    <div style="margin-top:11px;font-size:12px">
      ${j.rows.map((r) => `
        <div style="padding:4px 0;display:flex;gap:9px;align-items:baseline">
          <span class="v ${r.verdict}" style="min-width:66px;font-family:var(--mono)">${r.verdict}</span>
          <span style="flex:1;color:${r.isFalsePositive ? 'var(--block)' : 'var(--dim)'}">${esc(r.prompt.slice(0, 70))}</span>
          ${r.isFalsePositive ? '<b style="color:var(--block)">false positive</b>' : ''}
          ${r.isMiss ? '<b style="color:var(--escalate)">missed</b>' : ''}
        </div>`).join('')}
      ${j.falsePositives > 0
        ? `<div class="banner" style="margin-top:11px;background:var(--block-soft);color:var(--block)"><b>${j.falsePositives} legitimate request${j.falsePositives > 1 ? 's' : ''} would be blocked.</b> Reword before activating.</div>`
        : '<div style="margin-top:11px;color:var(--allow);font-weight:600">No false positives on these examples.</div>'}
    </div>`;
}

// ── admin: active policy ─────────────────────────────────────────────────────

/** `@id` means nothing to a reader; resolve it to a name. */
function audienceLabel(appliesTo) {
  if (!appliesTo?.length) return 'nobody';
  if (appliesTo.includes('*')) return 'everyone';
  return appliesTo
    .map((t) => {
      if (!t.startsWith('@')) return t;
      const id = t.slice(1);
      return company.employees.find((e) => e.id === id)?.name ?? `${id} (removed)`;
    })
    .join(', ');
}

const isPersonal = (rule) => rule.appliesTo.some((t) => t.startsWith('@'));

/** Tool ids as they arrive from the hook, in words. */
const TOOL_NAMES = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  generic: 'other tool',
  proxy: 'API'
};

function renderRules() {
  $('rules').innerHTML = policy.rules.length
    ? policy.rules.map((r) => `<div class="rule">
        <div class="t" style="padding-right:64px">${esc(r.text)}</div>
        <div class="m">
          <span class="tag ${r.severity}">${r.severity}</span>
          <span class="tag${isPersonal(r) ? ' personal' : ''}">${esc(audienceLabel(r.appliesTo))}</span>
          ${r.pinned ? '<span class="tag">always checked</span>' : ''}
        </div>
        <button class="ghost danger del" data-del="${esc(r.id)}">Remove</button>
      </div>`).join('')
    : '<div class="empty">No rules yet.</div>';

  $('rules').onclick = async (e) => {
    const btn = e.target.closest('[data-del]');
    if (!btn) return;
    await api(`/api/policy/rules/${encodeURIComponent(btn.dataset.del)}`, { method: 'DELETE' });
    await refreshPolicy();
    await refreshPeople();
  };
}

function renderQuotas() {
  $('quotas').innerHTML = policy.quotas.length
    ? `<div class="quota-grid">${policy.quotas.map((q) => `<div class="quota">
        <span>${esc(q.role)}</span><b>${q.maxRequestsPerDay}/day</b>
      </div>`).join('')}</div>`
    : '<div class="note">No quotas set — every role is unmetered.</div>';
}

// ── people ───────────────────────────────────────────────────────────────────

function renderPeople() {
  $('peopleGrid').innerHTML = company.employees.length
    ? company.employees.map((e) => `
      <div class="person${selectedPerson?.id === e.id ? ' on' : ''}" data-id="${esc(e.id)}">
        ${avatar(e)}
        <div style="min-width:0;flex:1">
          <div class="nm">${esc(e.name)}</div>
          <div class="rl">${esc(e.role)}${e.quota ? ` · ${e.quota}/day` : ''}</div>
          <div class="st">${e.ruleCount} rule${e.ruleCount === 1 ? '' : 's'}${
            e.personalRuleCount ? ` · <b style="color:var(--accent)">${e.personalRuleCount} personal</b>` : ''
          }</div>
          <div class="tools">${
            e.connected?.length
              ? e.connected.map((c) => `<span class="tool on" title="${c.count} request(s), last ${esc(c.at)}">${esc(TOOL_NAMES[c.tool] ?? c.tool)}</span>`).join('')
              : '<span class="tool">not connected yet</span>'
          }</div>
        </div>
      </div>`).join('')
    : '<div class="empty">Nobody yet. Add the first person above.</div>';

  $('peopleGrid').onclick = (e) => {
    const card = e.target.closest('.person');
    if (!card) return;
    selectedPerson = company.employees.find((p) => p.id === card.dataset.id) ?? null;
    if (draftHost !== 'admin') { draft = null; }
    renderPeople();
    renderPersonDetail();
  };
}

function renderRoles() {
  $('roleChips').innerHTML = company.roles
    .map((r) => {
      const held = company.employees.filter((e) => e.role === r).length;
      return `<span class="chip static" title="${held} employee(s)">${esc(r)} <span style="color:var(--faint)">${held}</span>${
        held === 0 ? `<span class="x" data-role="${esc(r)}">×</span>` : ''
      }</span>`;
    })
    .join('');

  $('roleChips').onclick = async (e) => {
    const x = e.target.closest('[data-role]');
    if (!x) return;
    const { ok, j } = await api(`/api/roles/${encodeURIComponent(x.dataset.role)}`, { method: 'DELETE' });
    $('roleNote').textContent = ok ? '' : (j.error ?? 'failed');
    if (ok) { await refreshPeople(); await refreshPolicy(); }
  };

  const sel = $('newRole');
  const keep = sel.value;
  sel.innerHTML = company.roles.map((r) => `<option>${esc(r)}</option>`).join('');
  if (company.roles.includes(keep)) sel.value = keep;
}

$('addPerson').onclick = async () => {
  const name = $('newName').value.trim();
  if (!name) return;
  const { ok, j } = await api('/api/people', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, role: $('newRole').value })
  });
  $('addNote').textContent = ok
    ? `${j.name} added · WARDEN_API_KEY=${j.apiKey}`
    : (j.error ?? 'failed');
  if (ok) {
    $('newName').value = '';
    await refreshPeople();
    selectedPerson = company.employees.find((e) => e.id === j.id) ?? null;
    renderPeople();
    renderPersonDetail();
  }
};

$('addRole').onclick = async () => {
  const role = $('newRoleName').value.trim();
  if (!role) return;
  const quota = Number($('newRoleQuota').value || 0);
  const { ok, j } = await api('/api/roles', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role, maxRequestsPerDay: quota })
  });
  $('roleNote').textContent = ok ? '' : (j.error ?? 'failed');
  if (ok) {
    $('newRoleName').value = '';
    $('newRoleQuota').value = '';
    await refreshPeople();
    await refreshPolicy();
  }
};

/**
 * One person's page: who they are, and every rule that will judge them —
 * separated by why it binds them, because "everyone" and "written for you" are
 * very different things to be told when a prompt is refused.
 */
async function renderPersonDetail() {
  const host = $('personDetail');
  if (!selectedPerson) {
    host.innerHTML = '<div class="empty-state"><div><div class="signal">ID</div><b>No person selected</b><span>Choose someone from the directory to manage their setup and rules.</span></div></div>';
    return;
  }
  const p = selectedPerson;
  const { j } = await api(`/api/people/${encodeURIComponent(p.id)}/rules`);
  const rules = j?.rules ?? [];
  const group = (kind) => rules.filter((r) => r.binding === kind);

  const section = (title, list, note) => `
    <div class="sub">${title} <span style="color:var(--faint);font-weight:500">${list.length}</span></div>
    ${list.length
      ? list.map((r) => `<div class="rule">
          <div class="t">${esc(r.text)}</div>
          <div class="m"><span class="tag ${r.severity}">${r.severity}</span>
            <span class="tag${r.binding === 'personal' ? ' personal' : ''}">${esc(r.audience)}</span></div>
        </div>`).join('')
      : `<div class="note">${note}</div>`}`;

  host.innerHTML = `
    <div class="detail-top">
      ${avatar(p, true)}
      <div style="min-width:0">
        <div class="nm">${esc(p.name)}</div>
        <div class="note">${esc(p.role)}${p.quota ? ` · ${p.quota} requests/day` : ' · unmetered'}</div>
      </div>
    </div>

    <div class="field">
      <label>Role</label>
      <select id="editRole">${company.roles.map((r) => `<option${r === p.role ? ' selected' : ''}>${esc(r)}</option>`).join('')}</select>
    </div>

    <div class="field">
      <label>API key — their whole identity. Rotating it revokes the old one.</label>
      <div class="codewrap">
        <pre class="code">${esc(p.apiKey)}</pre>
        <button class="ghost copy" data-copy="${encodeURIComponent(p.apiKey)}">Copy</button>
      </div>
    </div>

    <div class="field">
      <label>What they put on their own machine</label>
      <div class="codewrap">
        <pre class="code">export WARDEN_API_KEY=${esc(p.apiKey)}</pre>
        <button class="ghost copy" data-copy="${encodeURIComponent('export WARDEN_API_KEY=' + p.apiKey)}">Copy</button>
      </div>
    </div>

    <div class="row">
      <button class="ghost" id="rotateKey">New key</button>
      <button class="ghost danger" id="removePerson">Remove from directory</button>
    </div>
    <div class="note" id="personNote" style="margin-top:7px"></div>

    <div class="sub">Onboarding <span style="color:var(--faint);font-weight:500">what you send them</span></div>
    <div id="onboarding"><div class="note">loading…</div></div>

    <div class="sub">Write a rule just for ${esc(p.name.split(' ')[0])}</div>
    <textarea id="personRuleText" rows="2" placeholder="p. ej. no puede pedir datos de otros equipos"></textarea>
    <div class="row">
      <button class="act" id="personCompile">Compile</button>
      <span class="note" id="personCompileNote"></span>
    </div>
    <div id="personDraft"></div>

    ${section('Written for them', group('personal'), 'No personal rules — only the company and role ones below.')}
    ${section(`Because they are ${esc(p.role)}`, group('role'), 'No rules target this role.')}
    ${section('Company-wide', group('company'), 'No company-wide rules.')}`;

  $('editRole').onchange = async (e) => {
    const { ok, j } = await api('/api/people', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: p.id, name: p.name, role: e.target.value })
    });
    $('personNote').textContent = ok ? `Now judged as ${j.role}.` : (j.error ?? 'failed');
    if (ok) await refreshPeople();
  };

  $('rotateKey').onclick = async () => {
    await api(`/api/people/${encodeURIComponent(p.id)}/key`, { method: 'POST' });
    await refreshPeople();
  };

  $('removePerson').onclick = async () => {
    const { ok, j } = await api(`/api/people/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
    if (!ok) { $('personNote').textContent = j.error ?? 'failed'; return; }
    selectedPerson = null;
    await refreshPeople();
    // Rules written only for someone who has left still exist and now bind
    // nobody. Saying so beats leaving dead policy in the list unremarked.
    if (j.orphanedRules?.length) {
      $('personDetail').innerHTML =
        `<div class="banner">${j.orphanedRules.length} rule(s) were written only for ${esc(j.removed.name)} and now apply to nobody. Retarget or remove them in the Policy panel.</div>`;
    }
  };

  $('personCompile').onclick = () =>
    compileInto('person', $('personRuleText').value, [`@${p.id}`], $('personCompileNote'), $('personCompile'));

  if (draft && draftHost === 'person') renderDraft();

  // One delegated handler for every copy button on the page, including the ones
  // renderOnboarding adds later. Binding per-button would miss those.
  host.onclick = (e) => {
    const btn = e.target.closest('[data-copy]');
    if (btn) void copyText(decodeURIComponent(btn.dataset.copy), btn);
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
  if (!ok) { host.innerHTML = `<div class="note">${esc(j.error ?? 'failed')}</div>`; return; }

  const tools = j.integrations;
  const step = (st) => `
    <div style="margin-top:11px">
      <div style="font-size:12px;font-weight:600">${esc(st.title)}</div>
      ${st.note ? `<div class="note" style="margin:3px 0 5px">${esc(st.note)}</div>` : ''}
      <div class="codewrap">
        <pre class="code">${esc(st.code)}</pre>
        <button class="ghost copy" data-copy="${encodeURIComponent(st.code)}">Copy</button>
      </div>
    </div>`;

  host.innerHTML = `
    <div class="row" style="margin-top:0">
      <button class="act" id="copyAll">Copy the whole setup message</button>
      <span class="note" id="copyNote"></span>
    </div>

    <div class="sub" style="margin:14px 0 7px">Everyone does this first</div>
    ${j.common.map(step).join('')}

    <div class="sub" style="margin:16px 0 7px">Then their tool</div>
    <div class="chips" id="toolTabs">
      ${tools.map((t, i) => `<span class="chip${i === 0 ? ' on' : ''}" data-tool="${i}">${esc(t.name)}</span>`).join('')}
    </div>
    <div id="toolBody"></div>`;

  const showTool = (i) => {
    const t = tools[i];
    $('toolBody').innerHTML = `
      <div style="margin-top:11px">
        <div class="chips" style="margin-bottom:8px">
          <span class="chip static">${t.kind === 'hook' ? 'runs before the prompt leaves the machine' : 'routes through the gateway'}</span>
          <span class="chip static" style="${t.worksOnSubscription ? '' : 'background:var(--escalate-soft);color:var(--escalate)'}">
            ${t.worksOnSubscription ? 'works on a subscription' : 'needs an API key, not a subscription'}
          </span>
          ${t.verified
            ? '<span class="chip static" style="background:var(--allow-soft);color:var(--allow)">verified working</span>'
            : '<span class="chip static" style="background:var(--block-soft);color:var(--block)">nobody has seen this block yet</span>'}
        </div>
        <div class="note">${esc(t.summary)}</div>
        ${t.steps.map(step).join('')}
      </div>`;
  };
  showTool(0);

  $('toolTabs').onclick = (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    [...$('toolTabs').children].forEach((c) => c.classList.toggle('on', c === chip));
    showTool(Number(chip.dataset.tool));
  };

  $('copyAll').onclick = (e) => copyText(j.message, e.target);
}

// ── employee chat ────────────────────────────────────────────────────────────

function renderWhoPicker() {
  const sel = $('who');
  const keep = sel.value;
  sel.innerHTML = company.employees
    .map((e) => `<option value="${esc(e.id)}">${esc(e.name)} · ${esc(e.role)}</option>`)
    .join('');
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

$('send').onclick = send;
$('prompt').onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); };

async function send() {
  const text = $('prompt').value.trim();
  if (!text) return;
  const who = $('who').value || 'anon';
  const person = company.employees.find((e) => e.id === who);
  $('prompt').value = '';
  append(person ? `${person.name} (${person.role})` : who, text, '');

  // The person's own API key, exactly as their laptop would send it. Neither a
  // name nor a role goes over the wire: the key is the whole identity, and the
  // console deliberately has no privileged way to assert one — it exercises the
  // same path an employee's tool does, so a break here breaks the demo too.
  const { j } = await api('/api/guard/check', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(person?.apiKey ? { authorization: `Bearer ${person.apiKey}` } : {})
    },
    body: JSON.stringify({ prompt: text, source: 'console' })
  });

  if (j?.error === 'unknown_api_key') {
    append('warden', 'key not recognised', `<div class="why">${esc(j.explanation)}</div>`, 'blocked');
    return;
  }

  const rule = j.firedRules?.[0];
  const cls = { ALLOW: 'allowed', BLOCK: 'blocked', ESCALATE: 'escalated' }[j.verdict];
  const label = { ALLOW: 'allowed', BLOCK: 'blocked by Warden', ESCALATE: 'held for review' }[j.verdict];

  let why = '';
  if (rule) {
    // A refusal that only names the rule leaves the person holding a question
    // with nowhere to take it. What they can do instead is the part that keeps
    // them working with the gateway rather than around it.
    why += `<div class="why"><b>Rule:</b> ${esc(rule.ruleText)}</div>`;
    if (rule.guidance) {
      why += `<div class="why" style="margin-top:7px"><b>Instead:</b> ${esc(rule.guidance)}</div>`;
    } else {
      why += `<div class="why"><b>Why:</b> ${esc(rule.reason)}</div>`;
    }
    if (rule.allowedExamples?.length) {
      why += `<div class="why" style="margin-top:7px"><b>These would go through:</b>${
        rule.allowedExamples.map((e) => `<div style="margin-left:10px">· ${esc(e)}</div>`).join('')
      }</div>`;
    }
  }
  if (j.maskedSpans?.length) {
    why += `<div class="why">${j.maskedSpans.length} secret(s) masked before checking: <code>${esc(j.maskedPrompt.slice(0, 90))}</code></div>`;
  }
  if (j.quota?.limit) why += `<div class="why">quota ${j.quota.used}/${j.quota.limit}</div>`;
  why += `<div class="why" style="color:var(--faint)">audit ${esc(j.auditId)} · ${j.totalMs}ms</div>`;

  append('warden', label, why, cls);
}

function append(who, text, extra, cls = '') {
  const el = document.createElement('div');
  el.className = `msg ${cls}`;
  el.innerHTML = `<div class="who">${esc(who)}</div><div class="txt">${esc(text)}</div>${extra}`;
  const chat = $('chat');
  if (chat.querySelector('.empty, .empty-state')) chat.innerHTML = '';
  chat.append(el);
  chat.scrollTop = chat.scrollHeight;
}

// ── live trace ───────────────────────────────────────────────────────────────

function subscribe() {
  const src = new EventSource('/api/events');
  src.onopen = () => { $('sse').textContent = '● live'; $('sse').style.color = 'var(--allow)'; };
  src.onerror = () => { $('sse').textContent = '● offline'; $('sse').style.color = 'var(--block)'; };
  src.onmessage = (e) => {
    let payload; try { payload = JSON.parse(e.data); } catch { return; }
    if (payload.type !== 'decision') return;
    renderTrace(payload.decision);
  };
}

function renderTrace(d) {
  const el = document.createElement('div');
  el.className = 'decision';
  el.innerHTML = `
    <div class="top">
      <span class="badge ${d.verdict}">${d.verdict}</span>
      <span style="margin-left:auto;font-family:var(--mono);font-size:11px;color:var(--faint)">${d.totalMs}ms</span>
    </div>
    <div class="prompt">${esc((d.maskedPrompt ?? '').slice(0, 110))}</div>
    ${(d.passes ?? []).map((p) => `
      <div class="pass">
        <span class="n">${esc(p.pass)}${p.failedClosed ? ' ⚠' : ''}</span>
        <span class="v ${p.verdict ?? ''}">${p.verdict ?? ''}</span>
        <span class="ms">${p.ms}ms</span>
      </div>`).join('')}`;
  const trace = $('trace');
  if (trace.querySelector('.empty, .empty-state')) trace.innerHTML = '';
  trace.prepend(el);
  while (trace.children.length > 25) trace.lastChild.remove();
}

// ── tabs ─────────────────────────────────────────────────────────────────────

const TABS = { console: 'grid3', people: 'grid2', redteam: 'single' };

document.querySelector('nav').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  document.querySelectorAll('nav button').forEach((x) => {
    const active = x === b;
    x.classList.toggle('on', active);
    x.setAttribute('aria-selected', String(active));
  });
  for (const [tab, layout] of Object.entries(TABS)) {
    const el = $(`tab-${tab}`);
    el.style.display = tab === b.dataset.tab ? (layout === 'single' ? 'block' : 'grid') : 'none';
  }
};

// ── red team tab ─────────────────────────────────────────────────────────────

$('loadRt').onclick = async () => {
  const { ok, j } = await api('/api/redteam/report');
  $('rtNote').textContent = ok ? '' : 'no report yet — run npm run redteam';
  if (ok) renderRedteam(j);
};

$('runRt').onclick = async () => {
  $('rtNote').textContent = 'running — this takes a while with a real model…';
  $('runRt').disabled = true;
  const { ok, j } = await api('/api/redteam/run', { method: 'POST' });
  $('runRt').disabled = false;
  $('rtNote').textContent = ok ? '' : (j.error ?? 'failed');
  if (ok) renderRedteam(j);
};

function renderRedteam(s) {
  const attacks = (s.warden ?? []).filter((c) => !c.isControl);
  const controls = (s.warden ?? []).filter((c) => c.isControl);
  const sum = (rows, k) => rows.reduce((n, c) => n + c[k], 0);
  const caught = sum(attacks, 'correct'), atotal = sum(attacks, 'total');
  const fp = sum(controls, 'falsePositives'), ctotal = sum(controls, 'total');
  const p = (n, d) => (d ? Math.round((n / d) * 100) : 0);

  $('rtOut').innerHTML = `
    ${s.adapter === 'mock' ? '<div class="banner">These numbers come from the mock adapter, not a real model. They measure the harness, not the guard.</div>' : ''}
    <div style="display:flex;gap:36px;margin-bottom:22px">
      <div><div class="stat">${p(caught, atotal)}%</div>
           <div class="note">attacks stopped · ${caught}/${atotal}</div></div>
      <div><div class="stat" style="color:${fp ? 'var(--escalate)' : 'var(--allow)'}">${p(fp, ctotal)}%</div>
           <div class="note">false positives · ${fp}/${ctotal}</div></div>
    </div>
    <table>
      <tr><th>Class</th><th style="text-align:right">Warden</th><th style="text-align:right">Baseline</th><th style="text-align:right">p50</th></tr>
      ${(s.warden ?? []).map((c) => {
        const b = (s.baseline ?? []).find((x) => x.class === c.class);
        const rate = p(c.correct, c.total);
        const colour = rate > 70 ? 'var(--allow)' : rate > 40 ? 'var(--escalate)' : 'var(--block)';
        return `<tr>
          <td>${esc(c.class)}${c.isControl ? ' <span style="color:var(--faint)">(control)</span>' : ''}</td>
          <td class="num">${rate}%<div class="bar"><i style="width:${rate}%;background:${colour}"></i></div></td>
          <td class="num" style="color:var(--faint)">${b ? p(b.correct, b.total) + '%' : '—'}</td>
          <td class="num" style="color:var(--faint)">${c.p50}ms</td>
        </tr>`;
      }).join('')}
    </table>`;
}

boot();
