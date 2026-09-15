/** Runtime diagnostics. Model choices live together on the Models screen. */
import { esc, post, state } from './core.js';
import { modelLabel } from './format.js';
import { VIEWS } from './views.js';

function engineStatus(m) {
  if (!m) return { tone: 'bad', title: 'The gateway is not answering.', detail: 'Return to Models and refresh the connection.' };
  if (m.mock) return { tone: 'warn', title: 'Demo mode is active.', detail: 'A stand-in is answering in place of the models. These verdicts do not measure the real analyzer.' };
  if (m.runtime?.ok === false || m.state === 'failed') return { tone: 'bad', title: 'The analyzer is unavailable.', detail: 'Rules that cannot be evaluated are held for review. Check the runtime error below.' };
  if (m.state !== 'ready') return { tone: 'warn', title: 'The analyzer will load when needed.', detail: 'The first request may wait while the local model starts.' };
  return { tone: 'ok', title: 'Local analysis is running.', detail: `${modelLabel(m.judging.model)} is checking requests on this machine.` };
}

function enginePage() {
  const m = state.models;
  const status = engineStatus(m);
  return `<div class="sheet settings">
    <button type="button" class="btn --link" data-go="models">Back to Models</button>
    <div class="headline"><span class="dot ${status.tone}" aria-hidden="true"></span><div><div class="t">${esc(status.title)}</div><div class="m">${esc(status.detail)}</div></div></div>
    ${m?.runtime?.ok === false ? `<div class="section"><div class="label">Runtime error</div><div class="banner bad"><b>The local model worker could not start.</b><pre class="code">${esc(m.runtime.path ?? 'Runtime not found')}
${esc(m.runtime.detail)}</pre></div></div>` : ''}
    <div class="section"><div class="label">Model files on this gateway</div>
      ${m ? `<div class="models">${m.models.map((model) => `<div class="model ${model.onDisk ? 'have' : 'off'}"><span class="role">${esc(model.role === 'adjudicator' ? 'analyzer' : model.role)}</span><span class="file">${esc(modelLabel(model.name))}</span><span class="state">${model.onDisk ? `On disk${model.bytes ? ` · ${(model.bytes / 1e9).toFixed(2)} GB` : ''}` : model.fetchable === false ? 'Optional · not installed' : 'Not downloaded'}</span></div>`).join('')}</div>` : '<p class="note">Model inventory is unavailable. Refresh Models to try again.</p>'}
      <p class="note">Text documents are read directly. Scans and images use the document reader’s offline OCR; this inventory lists the guard’s QVAC models.</p>
      ${m?.models.some((model) => !model.onDisk && model.fetchable !== false) ? state.canLeaveDemo ? '<button type="button" class="btn js-get-models">Download missing models</button>' : '<p class="note">Run <code>pnpm run setup</code> on the gateway to download missing built-in models.</p>' : ''}
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
    const { ok, j } = await post('/api/gateway/leave-demo');
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

VIEWS.engine = { railParent: 'models', body: enginePage, bind: bindGetModels };
