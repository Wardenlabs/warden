/** Transient browser attachments. Only metadata enters the chat transcript. */
import { $, api, esc, state } from './core.js';
import { fileSize } from './format.js';
import { render } from './render.js';

const defaults = {
  limits: { files: 5, fileBytes: 8 * 1024 ** 2, totalBytes: 16 * 1024 ** 2 },
  formats: ['pdf', 'docx', 'txt', 'md', 'csv', 'png', 'jpg', 'jpeg', 'webp', 'bmp'].map((extension) => ({ extension }))
};
let capabilities = null;
let selected = [];
let errors = [];
let reading = false;
let nextId = 0;

export async function loadDocumentCapabilities() {
  try {
    const result = await api('/api/documents/capabilities');
    capabilities = result.ok ? result.j : null;
  } catch { capabilities = null; }
  if (state.view === 'simulator') render();
}

export const documentsBusy = () => reading;
export const selectedAttachments = () => selected.map(({ name, mimeType, data }) => ({ name, mimeType, data }));
export const selectedMetadata = () => selected.map(({ name, mimeType, bytes }) => ({ name, mimeType, bytes }));
export function clearDocuments() { selected = []; errors = []; }

/** The HTTP check has no stage stream, so describe the work without guessing
 * whether extraction or an individual rule has already finished. */
export function documentReviewPendingMarkup(documents = [], sending = false) {
  if (!sending || !documents.length) return '';
  return '<div class="msg" role="status" aria-live="polite"><div class="who">Warden</div><div class="why"><b>Reading and reviewing documents…</b><div>Files are read first, then checked against the rules. Several rules or a busy analyzer can make this take a few minutes.</div></div></div>';
}

/** Model timeouts are separate from unreadable files. Only the actual reading
 * reports can establish that extraction (including OCR) completed. */
export function documentAnalysisNotice(decision) {
  const documents = decision.documents ?? [];
  if (!documents.length) return '';
  const errors = (decision.passes ?? []).filter((pass) => pass.failedClosed && String(pass.pass).startsWith('adjudicate:')).map((pass) => String(pass.detail?.error ?? ''));
  const timedOut = errors.some((error) => /^Document analysis\b.*timed out/i.test(error));
  const cancelled = errors.some((error) => /^Document analysis\b.*cancelled/i.test(error));
  const legacy = errors.some((error) => /^Document judgement was cancelled or timed out/i.test(error));
  if (!timedOut && !cancelled && !legacy) return '';
  const reading = documents.every((document) => document.status === 'read')
    ? 'The files were read. '
    : 'Document reading results are shown separately below. ';
  const analysis = timedOut ? 'Policy analysis ran out of time' : cancelled ? 'Policy analysis was cancelled' : 'Policy analysis did not finish';
  return `<div><b>${analysis}.</b> ${reading}Not every part and rule was checked, so this request was not cleared.</div><div>Try again after other checks finish. If this keeps happening, check the analyzer in <button type="button" class="linkbtn" data-go="models">Models</button>.</div>`;
}

/** Stable server reasons need a recovery sentence where a person sees the file. */
export function documentReason(reason) {
  const messages = {
    'encrypted-document': 'This document is password-protected. Export an unlocked copy and try again.',
    'document-page-limit': 'The document has too many pages. Split it into smaller documents and check each part.',
    'document-text-limit': 'The document contains too much text for one check. Split it into smaller documents.',
    'document-reader-busy': 'The document reader is busy. Wait for the current requests to finish, then try again.',
    'document-reader-timeout': 'The document reader ran out of time. Try a smaller document or a clearer scan.',
    'document-reader-unavailable': 'The document reader could not start. Check the gateway and try again.',
    'document-reader-failed': 'The document reader stopped before finishing. Try exporting a new copy.',
    'empty-document': 'No readable content was found. Check the file and try again.',
    'empty-document-page': 'A page could not be read completely. Export a clearer copy and try again.',
    'ocr-empty': 'No text could be read from this image. Try a clearer scan or a document with selectable text.',
    'ocr-low-confidence': 'The scan could not be read reliably. Use a clearer image or a document with selectable text.',
    'image-pixel-limit': 'This image is too large to process. Reduce its dimensions and try again.',
    'animated-image-unsupported': 'Animated images are not supported. Export a still image and try again.',
    'external-document-content': 'This file depends on external content. Export a self-contained document and try again.',
    'embedded-document-unsupported': 'This file contains embedded documents. Attach those documents separately.',
    'active-document-unsupported': 'This file contains active content. Export a static PDF or text document.',
    'document-type-mismatch': 'The file contents do not match its type. Export it in a supported format.',
    'invalid-text-encoding': 'The text encoding could not be read. Save the document as UTF-8 and try again.',
    'unsupported-document-format': 'This format is not supported. Use PDF, DOCX, text or a supported image.',
    'unsupported-image-format': 'This image format is not supported. Use PNG, JPEG, WebP or BMP.',
    'cancelled': 'Reading was cancelled. Check the document again when you are ready.'
  };
  return messages[reason] ?? (String(reason).includes(' ') ? String(reason) : 'The file could not be read completely. Export a new copy in a supported format and try again.');
}

/** File type text is content, never an icon or a guessed extraction result. */
export function documentMetadataMarkup(documents = [], { submitted = false } = {}) {
  if (!documents.length) return '';
  return `<ul class="document-records" aria-label="${submitted ? 'Attached documents' : 'Document reading results'}">${documents.map((document) => {
    const unreadable = document.status === 'unreadable';
    const status = submitted ? 'Attached' : unreadable ? 'Could not read' : document.status === 'read' ? 'Read' : 'Not checked';
    return `<li class="document-record"><div class="document-record-title"><b>${esc(document.name || 'Document')}</b><span class="model-status${unreadable ? ' warn' : document.status === 'read' ? ' good' : ''}">${status}</span></div><div class="model-metadata"><span>${fileSize(document.bytes ?? 0)}</span>${document.pages ? `<span>${document.pages} ${document.pages === 1 ? 'page' : 'pages'}</span>` : ''}${document.chars != null ? `<span>${Number(document.chars).toLocaleString()} characters</span>` : ''}${document.method ? `<span>${({ text: 'Text', pdf: 'PDF text', docx: 'Word text', ocr: 'Offline OCR', mixed: 'Text and offline OCR' })[document.method] ?? esc(document.method)}</span>` : ''}${document.redactions ? `<span>${document.redactions} ${document.redactions === 1 ? 'secret' : 'secrets'} masked</span>` : ''}</div>${document.reason ? `<p class="note ${unreadable ? 'warn' : ''}">${esc(documentReason(document.reason))}</p>` : ''}</li>`;
  }).join('')}</ul>`;
}

export function documentComposer() {
  const { limits, formats } = capabilities ?? defaults;
  const accept = formats.map((format) => `.${format.extension.replace(/^\./, '')}`).join(',');
  return `<div class="document-composer" id="documentDropzone" aria-busy="${reading}">
    <div class="document-attach-row"><input id="documentFiles" class="sr-only" type="file" accept="${esc(accept)}" multiple aria-label="Attach documents" aria-describedby="documentLimits"${state.sending || reading ? ' disabled' : ''}><button type="button" class="btn --link" id="attachDocuments"${state.sending || reading ? ' disabled' : ''}><svg class="ui-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m7 11 5-5a2 2 0 0 1 3 3l-6 6a4 4 0 0 1-6-6l6-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>Attach files</button><span class="note" id="documentLimits">or drop here · ${limits.files} files · ${fileSize(limits.fileBytes)} each</span></div>
    <p class="document-formats">PDF, Word, text, scans and images · ${fileSize(limits.totalBytes)} total</p>
    ${selected.length ? `<ul class="document-selection" aria-label="Files ready to check">${selected.map((file) => `<li><span class="document-extension" aria-hidden="true">${esc(file.name.split('.').pop().slice(0, 5).toUpperCase())}</span><div><b>${esc(file.name)}</b><span class="note">${fileSize(file.bytes)} · ${state.sending ? 'Checking with your prompt' : 'Ready to check'}</span></div><button type="button" class="btn --link" data-remove-document="${file.id}" aria-label="Remove ${esc(file.name)}"${state.sending || reading ? ' disabled' : ''}><svg class="ui-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button></li>`).join('')}</ul>` : ''}
    <div id="documentFeedback" aria-live="polite">${reading ? '<p class="note" role="status">Preparing attachments…</p>' : ''}${errors.map((error) => `<p class="note bad" role="alert">${esc(error)}</p>`).join('')}</div>
    ${selected.length ? '<p class="document-privacy">Read locally before policy checks. An unreadable document is held for review.</p>' : ''}
  </div>`;
}

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(new Error(`Could not open ${file.name}. Choose it again.`));
    reader.onabort = () => reject(new Error(`Reading ${file.name} was cancelled.`));
    reader.readAsDataURL(file);
  });
}

async function addFiles(files) {
  if (state.sending || reading || !files.length) return;
  const { limits, formats } = capabilities ?? defaults;
  const extensions = new Set(formats.map((format) => format.extension.replace(/^\./, '').toLowerCase()));
  errors = []; reading = true; render();
  try {
    for (const file of files) {
      const extension = file.name.split('.').pop().toLowerCase();
      if (!extensions.has(extension)) { errors.push(`${file.name}: this format is not supported. Choose PDF, DOCX, text or an image.`); continue; }
      if (!file.size) { errors.push(`${file.name} is empty. Choose a file with content.`); continue; }
      if (file.size > limits.fileBytes) { errors.push(`${file.name} exceeds the ${fileSize(limits.fileBytes)} per-file limit.`); continue; }
      if (selected.some((item) => item.name === file.name && item.bytes === file.size && item.lastModified === file.lastModified)) { errors.push(`${file.name} is already attached.`); continue; }
      if (selected.length >= limits.files) { errors.push(`Only ${limits.files} files can be checked at once. Remove a file before adding ${file.name}.`); continue; }
      if (selected.reduce((sum, item) => sum + item.bytes, 0) + file.size > limits.totalBytes) { errors.push(`${file.name} would exceed the ${fileSize(limits.totalBytes)} total limit. Remove a file and try again.`); continue; }
      try { selected.push({ id: ++nextId, name: file.name, mimeType: file.type || undefined, bytes: file.size, lastModified: file.lastModified, data: await readBase64(file) }); }
      catch (error) { errors.push(error.message); }
    }
  } finally { reading = false; if (state.view === 'simulator') { render(); $('attachDocuments')?.focus(); } }
}

export function bindDocuments() {
  if ($('attachDocuments')) $('attachDocuments').onclick = () => $('documentFiles')?.click();
  if ($('documentFiles')) $('documentFiles').onchange = (event) => void addFiles(Array.from(event.target.files));
  for (const button of document.querySelectorAll('[data-remove-document]')) button.onclick = () => { selected = selected.filter((file) => file.id !== Number(button.dataset.removeDocument)); errors = []; render(); $('attachDocuments')?.focus(); };
  const zone = $('documentDropzone');
  if (!zone) return;
  for (const eventName of ['dragenter', 'dragover']) zone.addEventListener(eventName, (event) => { if (!event.dataTransfer?.types.includes('Files')) return; event.preventDefault(); if (!state.sending && !reading) zone.classList.add('dragging'); });
  zone.addEventListener('dragleave', (event) => { if (!zone.contains(event.relatedTarget)) zone.classList.remove('dragging'); });
  zone.addEventListener('drop', (event) => { event.preventDefault(); zone.classList.remove('dragging'); void addFiles(Array.from(event.dataTransfer?.files ?? [])); });
}
