/** Runtime diagnostics. Model choices live together on the Models screen. */
import { esc, post, state } from './core.js';
import { feedback, pageHead, statusText } from './ui.js';
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
  const tone = { ok: 'success', warn: 'attention', bad: 'error' }[status.tone];
  return `<div class="sheet">
    ${pageHead({ title: 'Runtime details', crumbs: [{ label: 'Models', go: 'models' }] })}
    <div class="reading settings-page">
      ${feedback({ tone, title: status.title, body: esc(status.detail), icon: tone === 'error' })}
      ${m?.runtime?.ok === false ? `<section class="settings-task"><h2 class="section-title">Runtime error</h2><p class="section-lede">The local model worker could not start.</p><pre class="code">${esc(m.runtime.path ?? 'Runtime not found')}
${esc(m.runtime.detail)}</pre></section>` : ''}
      <section class="settings-task">
        <h2 class="section-title">Model files on this gateway</h2>
        <!-- Was the header's second line. A page that genuinely has to explain
             itself explains itself in the reading column, under the heading it
             is about. -->
        <p class="section-lede">What the gateway is running, and the model files it found on this machine.</p>
        ${m ? `<div class="table runtime-table" role="table" aria-label="Model files">
          <div class="thead" role="row"><span>Job</span><span>Model</span><span>On disk</span></div>
          ${m.models.map((model) => `<div class="trow" role="row"><span>${esc(model.role === 'adjudicator' ? 'analyzer' : model.role)}</span><span class="mono cell-clip">${esc(modelLabel(model.name))}</span><span>${model.onDisk ? statusText(`On disk${model.bytes ? ` · ${(model.bytes / 1e9).toFixed(2)} GB` : ''}`, 'allow') : `<span class="cell-muted">${model.fetchable === false ? 'Optional · not installed' : 'Not downloaded'}</span>`}</span></div>`).join('')}
        </div>` : '<p class="section-lede">Model inventory is unavailable. Refresh Models to try again.</p>'}
        <p class="table-foot">Text documents are read directly. Scans and images use the document reader’s offline OCR; this inventory lists the guard’s QVAC models.</p>
        ${m?.models.some((model) => !model.onDisk && model.fetchable !== false) ? state.canLeaveDemo ? '<div><button type="button" class="btn js-get-models">Download missing models</button></div>' : '<p class="table-foot">Run <code>pnpm run setup</code> on the gateway to download missing built-in models.</p>' : ''}
      </section>
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
        `<span class="form-note --block">${esc(j?.error ?? 'could not start the download')}</span>`);
      return;
    }
    // The shell relaunches the app from under us, so there is nothing after
    // this to render. Saying so beats a button that looks stuck.
    models.textContent = 'Downloading. Warden will restart on its own…';
    };
  }
}

VIEWS.engine = { railParent: 'models', body: enginePage, bind: bindGetModels };
