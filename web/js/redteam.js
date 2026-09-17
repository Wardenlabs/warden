/**
 * The red-team report, off the main path on purpose.
 */
import { $, api, esc, post, state } from './core.js';
import { render } from './render.js';
import { button, feedback, listState, pageHead, statusText } from './ui.js';
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
    const head = pageHead({
      title: 'Red team',
      crumbs: [{ label: 'Rules', go: 'policy' }],
      quiet: button('Load last report', { id: 'loadRt' }),
      primary: button(state.rtBusy ? 'Running…' : 'Run suite', { kind: 'primary', id: 'runRt', busy: state.rtBusy })
    });
    if (!s) {
      return `<div class="sheet">${head}${listState({ title: 'No report yet', body: 'Run the suite to see how the guard does against attacks somebody already wrote down.' })}</div>`;
    }
    const attacks = (s.warden ?? []).filter((c) => !c.isControl);
    const controls = (s.warden ?? []).filter((c) => c.isControl);
    const sum = (rows, k) => rows.reduce((n, c) => n + c[k], 0);
    const caught = sum(attacks, 'correct'), atotal = sum(attacks, 'total');
    const fp = sum(controls, 'falsePositives'), ctotal = sum(controls, 'total');
    const pc = (n, d) => (d ? Math.round((n / d) * 100) : 0);

    return `<div class="sheet">
      ${head}
      <div class="reading-wide settings-page">
        <!-- The header's sentence, in the column that reads it. It is the
             caveat on every number below, so it belongs above them. -->
        <p class="section-lede">The canned attack corpus, replayed against the sample policy. It measures the guard, not the rules you wrote.</p>
        ${s.adapter === 'mock' ? feedback({ tone: 'attention', title: 'Demo mode', body: 'These numbers measure nothing: no model judged the corpus.' }) : ''}
        <p class="redteam-summary">Warden stopped <b>${caught} of ${atotal}</b> attacks (${pc(caught, atotal)}%), and wrongly stopped <b>${fp} of ${ctotal}</b> legitimate requests (${pc(fp, ctotal)}%).</p>
        <div class="table redteam-table" role="table" aria-label="Attack classes">
          <div class="thead" role="row"><span>Attack class</span><span>Warden</span><span>No guard</span></div>
          ${(s.warden ?? []).map((c) => {
            const b = (s.baseline ?? []).find((x) => x.class === c.class);
            const rate = pc(c.correct, c.total);
            const tone = rate > 70 ? 'allow' : rate > 40 ? 'attention' : 'block';
            return `<div class="trow" role="row">
              <span>${esc(c.class)}${c.isControl ? ' <span class="cell-muted">(control)</span>' : ''}</span>
              <span class="rate">${statusText(`${rate}%`, tone)}<span class="rate-bar --${tone}"><i style="width:${rate}%"></i></span></span>
              <span class="num">${b ? `${pc(b.correct, b.total)}%` : '—'}</span>
            </div>`;
          }).join('')}
        </div>
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
      const { ok, j } = await post('/api/redteam/run');
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
