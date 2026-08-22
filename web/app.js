/**
 * Console behaviour. Plain ES modules, no framework, no build step.
 *
 * The three panes correspond to the three people who care: the admin who writes
 * the rules, the employee who hits them, and whoever later has to explain a
 * decision. That last one is why the trace is a first-class pane rather than a
 * debug view — "auditable in five seconds" only counts if the audit is visible
 * while the thing runs.
 */

const $ = (id) => document.getElementById(id);
const api = (path, opts) => fetch(path, opts).then((r) => r.json().then((j) => ({ ok: r.ok, status: r.status, j })));
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

let policy = { rules: [], quotas: [], version: '' };
let presets = [];
let draft = null;

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
  renderRoles();
}

// ── admin: presets ───────────────────────────────────────────────────────────

async function loadPresets() {
  const { j } = await api('/api/policy/presets');
  presets = Array.isArray(j) ? j : [];
  $('cats').innerHTML = presets
    .map((c, i) => `<button data-cat="${i}">${esc(c.label ?? c.category)}</button>`)
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
        <div class="m">${r.severity} · ${r.appliesTo.join(', ')}</div>
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
    renderDraft();
  };
}

// ── admin: compile ───────────────────────────────────────────────────────────

$('compile').onclick = async () => {
  const text = $('ruleText').value.trim();
  if (!text) return;
  $('compile').disabled = true;
  $('compileNote').textContent = 'compiling…';
  const { ok, j } = await api('/api/policy/draft', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text })
  });
  $('compile').disabled = false;
  $('compileNote').textContent = ok ? '' : (j.error ?? 'failed');
  if (ok) { draft = j; renderDraft(); }
};

function renderDraft() {
  const d = $('draft');
  if (!draft) { d.style.display = 'none'; return; }
  d.style.display = 'block';
  d.innerHTML = `
    <div class="rule" style="border-color:var(--accent)">
      <div class="t">${esc(draft.text)}</div>
      <div class="m">${draft.scope} · ${draft.severity} · ${draft.appliesTo.join(', ')}</div>
      <div class="m" style="margin-top:7px;color:var(--dim)">
        blocks: ${draft.examples.violating.map((e) => `<div>· ${esc(e)}</div>`).join('')}
        allows: ${draft.examples.compliant.map((e) => `<div>· ${esc(e)}</div>`).join('')}
      </div>
      <div class="row">
        <button class="ghost" id="previewBtn">Preview</button>
        <button class="act" id="ratifyBtn">Activate</button>
        <button class="ghost" id="dropBtn">Discard</button>
      </div>
      <div id="previewOut"></div>
    </div>`;

  $('previewBtn').onclick = runPreview;
  $('dropBtn').onclick = () => { draft = null; renderDraft(); };
  $('ratifyBtn').onclick = async () => {
    await api('/api/policy/ratify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rule: draft })
    });
    draft = null; $('ruleText').value = ''; renderDraft(); refreshPolicy();
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
  $('previewOut').innerHTML = '<div class="m">running…</div>';
  const { ok, j } = await api('/api/policy/preview', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rule: draft })
  });
  if (!ok) { $('previewOut').innerHTML = `<div class="m">${esc(j.error)}</div>`; return; }

  $('previewOut').innerHTML = `
    <div style="margin-top:9px;font-size:11.5px">
      ${j.rows.map((r) => `
        <div style="padding:3px 0;color:${r.isFalsePositive ? 'var(--block)' : 'var(--dim)'}">
          <span class="v ${r.verdict}" style="font-family:var(--mono)">${r.verdict.padEnd(8)}</span>
          ${esc(r.prompt.slice(0, 54))}
          ${r.isFalsePositive ? ' <b style="color:var(--block)">← FALSE POSITIVE</b>' : ''}
          ${r.isMiss ? ' <b style="color:var(--escalate)">← missed</b>' : ''}
        </div>`).join('')}
      ${j.falsePositives > 0
        ? `<div style="margin-top:8px;color:var(--block)"><b>${j.falsePositives} legitimate request${j.falsePositives > 1 ? 's' : ''} would be blocked.</b> Reword before activating.</div>`
        : '<div style="margin-top:8px;color:var(--allow)">No false positives on these examples.</div>'}
    </div>`;
}

// ── admin: active policy ─────────────────────────────────────────────────────

function renderRules() {
  $('rules').innerHTML = policy.rules.length
    ? policy.rules.map((r) => `<div class="rule">
        <div class="t">${esc(r.text)}</div>
        <div class="m">${r.severity} · ${r.appliesTo.join(', ')}${r.pinned ? ' · always checked' : ''}</div>
      </div>`).join('')
    : '<div class="empty">No rules yet.</div>';
}

function renderQuotas() {
  $('quotas').innerHTML = policy.quotas
    .map((q) => `<div style="font-size:11.5px;margin-bottom:6px">
        <span style="color:var(--dim)">${esc(q.role)}</span>
        <span style="float:right;font-family:var(--mono);color:var(--faint)">${q.maxRequestsPerDay}/day</span>
      </div>`).join('');
}

function renderRoles() {
  const roles = [...new Set(policy.quotas.map((q) => q.role))];
  $('role').innerHTML = roles.map((r) => `<option${r === 'analyst' ? ' selected' : ''}>${esc(r)}</option>`).join('');
}

// ── employee chat ────────────────────────────────────────────────────────────

$('send').onclick = send;
$('prompt').onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); };

async function send() {
  const text = $('prompt').value.trim();
  if (!text) return;
  const role = $('role').value || 'analyst';
  $('prompt').value = '';
  append('you', text, '');

  const { j } = await api('/api/guard/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-warden-user': 'demo', 'x-warden-role': role },
    body: JSON.stringify({ prompt: text })
  });

  const rule = j.firedRules?.[0];
  const cls = { ALLOW: 'allowed', BLOCK: 'blocked', ESCALATE: 'escalated' }[j.verdict];
  const label = { ALLOW: 'allowed', BLOCK: 'blocked by warden', ESCALATE: 'held for review' }[j.verdict];

  let why = '';
  if (rule) why += `<div class="why"><b>Rule:</b> ${esc(rule.ruleText)}<br><b>Why:</b> ${esc(rule.reason)}</div>`;
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
  el.innerHTML = `<div class="who">${who}</div><div class="txt">${esc(text)}</div>${extra}`;
  const chat = $('chat');
  if (chat.querySelector('.empty')) chat.innerHTML = '';
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
      <span class="v ${d.verdict}" style="font-family:var(--mono);font-weight:600">${d.verdict}</span>
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
  if (trace.querySelector('.empty')) trace.innerHTML = '';
  trace.prepend(el);
  while (trace.children.length > 25) trace.lastChild.remove();
}

// ── red team tab ─────────────────────────────────────────────────────────────

document.querySelector('nav').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('on', x === b));
  $('tab-console').style.display = b.dataset.tab === 'console' ? 'grid' : 'none';
  $('tab-redteam').style.display = b.dataset.tab === 'redteam' ? 'grid' : 'none';
};

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
    ${s.adapter === 'mock' ? '<div class="rule" style="border-color:var(--escalate);margin-bottom:14px"><div class="t">These numbers come from the mock adapter, not a real model. They measure the harness, not the guard.</div></div>' : ''}
    <div style="display:flex;gap:28px;margin-bottom:18px">
      <div><div style="font-size:24px;font-weight:600">${p(caught, atotal)}%</div>
           <div style="font-size:11px;color:var(--faint)">attacks stopped · ${caught}/${atotal}</div></div>
      <div><div style="font-size:24px;font-weight:600;color:${fp ? 'var(--escalate)' : 'var(--allow)'}">${p(fp, ctotal)}%</div>
           <div style="font-size:11px;color:var(--faint)">false positives · ${fp}/${ctotal}</div></div>
    </div>
    <table>
      <tr><th>Class</th><th style="text-align:right">Warden</th><th style="text-align:right">Baseline</th><th style="text-align:right">p50</th></tr>
      ${(s.warden ?? []).map((c) => {
        const b = (s.baseline ?? []).find((x) => x.class === c.class);
        const rate = p(c.correct, c.total);
        return `<tr>
          <td>${esc(c.class)}${c.isControl ? ' <span style="color:var(--faint)">(control)</span>' : ''}</td>
          <td class="num">${rate}%<div class="bar"><i style="width:${rate}%;background:${rate > 70 ? 'var(--allow)' : rate > 40 ? 'var(--escalate)' : 'var(--block)'}"></i></div></td>
          <td class="num" style="color:var(--faint)">${b ? p(b.correct, b.total) + '%' : '—'}</td>
          <td class="num" style="color:var(--faint)">${c.p50}ms</td>
        </tr>`;
      }).join('')}
    </table>`;
}

boot();
