/**
 * The red-team report, off the main path on purpose.
 */
import { $, api, esc, state } from './core.js';
import { render } from './render.js';
import { backToRules } from './simulator.js';
import { VIEWS } from './views.js';

// ═══ RED TEAM ════════════════════════════════════════════════════════════════

/**
 * The corpus run. Off the console's main path on purpose.
 *
 * It is a developer's screen wearing an administrator's clothes: it replays 160
 * canned attacks written against the *sample* policy, takes minutes of local
 * inference to do it, and tells you about this repo's corpus rather than about
 * the rules you wrote. An administrator pressing "Try to break it" expects
 * their own policy tested and does not get that.
 *
 * Still here, still reachable, still what `pnpm run redteam` renders — it just
 * no longer sits in the toolbar next to things that are about your policy.
 */
VIEWS.redteam = {
  railParent: 'policy',
  body: () => {
    const s = state.rtReport;
    const toolbar = `<div class="toolbar">
      ${backToRules}
      <span class="spacer"></span>
      <button type="button" class="btn" id="loadRt">Load last report</button>
      <button type="button" class="btn primary" id="runRt"${state.rtBusy ? ' disabled' : ''}>${state.rtBusy ? 'Running…' : 'Run suite'}</button>
    </div>`;

    if (!s) {
      return `<div class="sheet">${toolbar}<div class="empty"><b>No report yet</b><span>Run the suite to see how the guard does against attacks somebody already wrote down.</span></div></div>`;
    }
    const attacks = (s.warden ?? []).filter((c) => !c.isControl);
    const controls = (s.warden ?? []).filter((c) => c.isControl);
    const sum = (rows, k) => rows.reduce((n, c) => n + c[k], 0);
    const caught = sum(attacks, 'correct'), atotal = sum(attacks, 'total');
    const fp = sum(controls, 'falsePositives'), ctotal = sum(controls, 'total');
    const pc = (n, d) => (d ? Math.round((n / d) * 100) : 0);

    return `<div class="sheet">
      ${toolbar}
      <div class="group">
        ${s.adapter === 'mock' ? '<div class="banner warn">Demo mode: these numbers measure nothing.</div>' : ''}
        <p class="summary">Warden stopped <b>${caught} of ${atotal}</b> attacks, and wrongly stopped <b>${fp} of ${ctotal}</b> legitimate requests.</p>
        <div class="stats">
          <div class="stat"><div class="n good">${pc(caught, atotal)}%</div><div class="k">attacks stopped</div></div>
          <div class="stat"><div class="n${fp ? ' warn' : ' good'}">${pc(fp, ctotal)}%</div><div class="k">wrongly stopped</div></div>
        </div>
      </div>
      <div class="section">
        <table>
          <thead><tr><th>Attack class</th><th class="n">Warden</th><th class="n">No guard</th></tr></thead>
          <tbody>
          ${(s.warden ?? []).map((c) => {
            const b = (s.baseline ?? []).find((x) => x.class === c.class);
            const rate = pc(c.correct, c.total);
            const colour = rate > 70 ? 'var(--allow)' : rate > 40 ? 'var(--escalate)' : 'var(--block)';
            return `<tr>
              <td>${esc(c.class)}${c.isControl ? ' <span class="note">(control)</span>' : ''}</td>
              <td class="n">${rate}%<div class="bar"><i style="width:${rate}%;background:${colour}"></i></div></td>
              <td class="n">${b ? `${pc(b.correct, b.total)}%` : '—'}</td>
            </tr>`;
          }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
  },
  bind: () => {
    const load = $('loadRt');
    if (load) load.onclick = async () => {
      const { ok, j } = await api('/api/redteam/report');
      if (ok) { state.rtReport = j; render(); }
    };
    const run = $('runRt');
    if (run) run.onclick = async () => {
      state.rtBusy = true; render();
      const { ok, j } = await api('/api/redteam/run', { method: 'POST' });
      state.rtBusy = false;
      if (ok) state.rtReport = j;
      render();
    };
  },
  onEnter: () => { if (!state.rtReport) void autoLoadRedteam(); }
};

async function autoLoadRedteam() {
  const { ok, j } = await api('/api/redteam/report');
  if (ok && j) { state.rtReport = j; render(); }
}
