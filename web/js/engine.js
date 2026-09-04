/**
 * Engine: is the guard working, which model judges, and what is on this disk.
 */
import { $, api, esc, state } from './core.js';
import { refreshAdjudicator, refreshCompiler } from './data.js';
import { render } from './render.js';
import { go } from './router.js';
import { readable } from './rules.js';
import { VIEWS } from './views.js';

/**
 * What is on this disk, and which of the two seats your subscription can take.
 *
 * Two complaints, one panel. The console named the adjudicator without ever
 * saying whether its weights exist, so a filename in a config and an installed
 * model looked the same on screen; `onDisk` comes from the file system, not
 * from what would be loaded. And people configure Claude Code expecting it to
 * do the work, because nothing said which work. Judging never leaves the
 * machine under any setting on this page, and that sentence belongs here rather
 * than in SECURITY.md where nobody hits it at the moment they are wondering.
 */
/**
 * Is the guard working, in one sentence, before anything else on the page.
 *
 * The old screen made you infer this from a red banner that appeared beside an
 * inventory of five files: everything on disk and still nothing judging looked
 * exactly like everything on disk and judging fine. The state the gateway
 * already tracks answers it directly, so it says so.
 */
function engineStatus(m) {
  if (!m) return { tone: 'bad', title: 'The gateway is not answering.', detail: '' };
  if (m.mock) {
    return {
      tone: 'warn',
      title: 'Demo mode. Nothing is really being judged.',
      detail: 'A stand-in is answering in place of the models, so no verdict here means anything.'
    };
  }
  if ((m.runtime && !m.runtime.ok) || m.state === 'failed') {
    return {
      tone: 'bad',
      title: 'Judging is not running. Every rule is escalating.',
      detail: 'Nothing is being let through unchecked: a rule that cannot be evaluated is held for a person, never assumed clean. But nobody is getting an answer either.'
    };
  }
  if (m.state !== 'ready') {
    return {
      tone: 'warn',
      title: 'Judging is warming up.',
      detail: 'The first prompt will wait for the model to finish loading.'
    };
  }
  return {
    tone: 'ok',
    title: 'Judging is running. Every prompt is being checked.',
    detail: `${m.judging.model} on this machine. Nothing leaves it.`
  };
}

function enginePage() {
  const m = state.models;
  const a = state.adjudicator;
  const st = engineStatus(m);
  const chosen = a?.model ?? 'default';
  const picked = (a?.choices ?? []).find((c) => c.id === chosen);
  // The chosen seat is not always the one answering: choosing the larger model
  // is what starts its download, and until that lands the default is still
  // judging. Only for a seat somebody opted into — a machine with nothing
  // downloaded at all already says so in the banner above the whole console,
  // and repeating it here produced the sentence "Qwen3 1.7B keeps judging
  // until the download finishes" about the model that was missing.
  const fallback = (a?.choices ?? []).find((c) => c.id === 'default');
  const waiting = Boolean(picked && !picked.onDisk && picked.id !== 'default');

  return `<div class="sheet settings">
    <div class="headline">
      <span class="dot ${st.tone}"></span>
      <div>
        <div class="t">${esc(st.title)}</div>
        ${st.detail ? `<div class="m">${esc(st.detail)}</div>` : ''}
      </div>
    </div>

    ${m?.runtime && !m.runtime.ok ? `<div class="section">
      <div class="label">What is wrong</div>
      <div class="banner bad">
        <b>The weights are here. The worker that runs them will not start.</b>
        <pre class="code">${esc(m.runtime.path ?? 'bare-runtime not found')}
${esc(m.runtime.detail)}</pre>
      </div>
    </div>` : ''}

    <div class="section">
      <div class="label">The model that judges</div>
      <div class="note">Every prompt your team sends goes through this model before it reaches anything else.</div>

      ${a ? `<div class="seats">
        ${a.choices.map((c) => `<button type="button" class="seat${c.id === chosen ? ' on' : ''}" data-seat="${esc(c.id)}">
          <span class="top">
            <span class="name">${esc(c.label)}</span>
            <span class="${c.onDisk ? 'have' : 'want'}">${c.onDisk ? 'on disk' : 'not downloaded'} · ${(c.approxMB / 1000).toFixed(1)} GB</span>
          </span>
          <span class="trade">${esc(c.trade)}</span>
          <span class="speed">${esc(c.perDecision)}</span>
        </button>`).join('')}
      </div>` : '<div class="note">Could not read which model is in the seat.</div>'}

      ${a?.overriddenByEnv ? `<div class="banner warn">
        <b>The environment is setting this.</b> <code>WARDEN_MODEL_ADJUDICATOR</code> wins over what you pick here,
        and <b>${esc(a.inForce)}</b> is what answers.
      </div>` : waiting ? `<div class="banner warn">
        <b>These weights are not on this disk yet.</b>
        ${esc(fallback?.label ?? 'The smaller model')} keeps judging until the download finishes.
        <div class="banner-act">
          <button type="button" class="btn primary js-get-models">Download it · ${(picked.approxMB / 1000).toFixed(1)} GB</button>
          <span class="note">Warden restarts on its own when it finishes.</span>
        </div>
      </div>` : ''}
    </div>

    <div class="section">
      <div class="label">Everything else it needs</div>
      ${m ? `<div class="models">
        ${m.models.filter((x) => x.role !== 'adjudicator').map((x) => `<div class="model ${x.onDisk ? 'have' : 'off'}">
          <span class="role">${esc(x.role)}</span>
          <span class="file">${esc(x.name)}</span>
          <span class="state">${x.onDisk
            ? `on disk${x.bytes ? ` · ${(x.bytes / 1e9).toFixed(2)} GB` : ''}`
            : x.fetchable === false ? 'off — no download exists' : 'not downloaded'}</span>
        </div>`).join('')}
      </div>` : ''}
      <div class="note">The OCR weights have no download; they arrive over the peer registry or not at all, which is why attachments have never been measured.</div>
    </div>

    <div class="section">
      <div class="label">Not part of judging</div>
      <div class="elsewhere">
        <span>Rules are drafted by <b>${esc(m?.drafting.model ?? 'this machine')}</b> through ${esc(m?.drafting.where ?? 'this machine')}, which never sees an employee prompt.</span>
        <button type="button" class="btn" data-go="compiler">Change it</button>
      </div>
    </div>
  </div>`;
}

/**
 * The one button that fetches weights, wherever it appears.
 *
 * Was inline in the shell's bind pass, which meant the Engine screen could not
 * offer a download without duplicating it — and a second copy of a button that
 * relaunches the app is exactly the thing that drifts.
 */
export function bindGetModels() {
  for (const models of document.querySelectorAll('#getModels, .js-get-models')) {
    // Its own label, because there are two of these and they do not say the
    // same thing: the banner offers all of them, the panel offers the missing
    // ones. Restoring a hard-coded string put the banner's words on the panel.
    const label = models.textContent;
    models.onclick = async () => {
    models.disabled = true;
    models.textContent = 'Starting the download…';
    const { ok, j } = await api('/api/gateway/leave-demo', { method: 'POST' });
    if (!ok) {
      models.disabled = false;
      models.textContent = label;
      // The one failure worth naming: no shell to do it, so say what to run.
      models.insertAdjacentHTML('afterend',
        `<span class="note bad">${esc(j?.error ?? 'could not start the download')}</span>`);
      return;
    }
    // The shell relaunches the app from under us, so there is nothing after
    // this to render. Saying so beats a button that looks stuck.
    models.textContent = 'Downloading. Warden will restart on its own…';
    };
  }
}

function bindEngine() {
  for (const seat of document.querySelectorAll('[data-seat]')) {
    seat.onclick = async () => {
      const model = seat.dataset.seat;
      if (model === (state.adjudicator?.model ?? 'default')) return;
      seat.disabled = true;
      const { ok, j } = await api('/api/settings/adjudicator', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model })
      });
      seat.disabled = false;
      if (!ok) {
        seat.insertAdjacentHTML('afterend', `<span class="note bad">${esc(readable(j) ?? 'could not change it')}</span>`);
        return;
      }
      await refreshAdjudicator();
      await refreshCompiler();
      render();
    };
  }
  // The download button is the same one the banner and the panel have always
  // used: it hands off to the desktop shell, which relaunches into the
  // first-run screen and fetches whatever is missing, the chosen seat included.
  bindGetModels();
}

VIEWS.engine = {
  body: enginePage,
  bind: bindEngine
};
