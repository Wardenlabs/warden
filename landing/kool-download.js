import { captureAttribution, getAttribution } from './vendor/kool/browser.mjs';

const INSTALLERS = new Map([
  ['https://github.com/Wardenlabs/warden/releases/latest/download/Warden-arm64.dmg', 'macos'],
  ['https://github.com/Wardenlabs/warden/releases/latest/download/Warden-Setup.exe', 'windows'],
]);
const mounted = new WeakMap();
const opaqueId = /^[a-zA-Z0-9_-]{1,128}$/;

function doNotTrack(win) {
  const value = win.navigator?.doNotTrack || win.doNotTrack || win.navigator?.msDoNotTrack;
  return ['1', 'yes'].includes(String(value).toLowerCase());
}

/** Keep GitHub links usable until a trusted activation can submit the download. */
export function initKoolDownloads(environment = {}) {
  const win = environment.window || globalThis.window;
  const doc = environment.document || win?.document;
  if (!win || !doc || doNotTrack(win)) return { destroy() {} };
  if (mounted.has(doc)) return mounted.get(doc);

  let storage;
  try { storage = win.localStorage ?? null; } catch { storage = null; }
  const options = () => ({ storage, ...(environment.now ? { now: environment.now() } : {}) });
  // Capture once on arrival: a later download must not renew the attribution window.
  captureAttribution({ ...options(), url: win.location.href });

  const handled = new WeakSet(), forms = new Set();
  const activate = event => {
    if (event.isTrusted !== true || event.defaultPrevented || event.cancelable === false
      || handled.has(event) || doNotTrack(win) || event.altKey) return;
    if (!((event.type === 'click' && event.button === 0)
      || (event.type === 'auxclick' && event.button === 1))) return;

    let form;
    try {
      const element = event.target?.closest ? event.target : event.target?.parentElement;
      const link = element?.closest('a[href]');
      const platform = INSTALLERS.get(link?.href);
      if (!platform || link.hasAttribute('download')) return;
      const target = (link.getAttribute('target') || '_self').toLowerCase();
      if (!['_self', '_blank'].includes(target)) return;
      const action = new URL('/api/download', win.location.href);
      if (!['http:', 'https:'].includes(action.protocol)) return;

      const eventId = win.crypto.randomUUID();
      if (!opaqueId.test(eventId)) return;
      const clickId = getAttribution(options());
      const fields = { platform, eventId };
      if (typeof clickId === 'string' && opaqueId.test(clickId)) fields.clickId = clickId;

      form = doc.createElement('form');
      form.hidden = true;
      form.method = 'POST';
      form.action = action.href;
      form.enctype = 'application/x-www-form-urlencoded';
      form.target = target === '_blank' || event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1
        ? '_blank' : '_self';
      form.rel = 'noopener';
      for (const [name, value] of Object.entries(fields)) {
        const field = doc.createElement('input');
        field.type = 'hidden'; field.name = name; field.value = value;
        form.append(field);
      }
      doc.body.append(form);
      // A native navigation survives page unload. Its 303 response starts the installer download.
      win.HTMLFormElement.prototype.submit.call(form);
    } catch {
      try { form?.remove(); } catch { /* The original anchor remains the fallback. */ }
      return;
    }

    event.preventDefault();
    handled.add(event);
    forms.add(form);
    // Do not detach immediately: browsers may still be processing the native submission.
    try { win.setTimeout(() => { form.remove(); forms.delete(form); }, 60_000); } catch { /* Cleaned on destroy. */ }
  };

  // Existing analytics observes the unchanged anchor during its capture-phase listener.
  doc.addEventListener('click', activate);
  doc.addEventListener('auxclick', activate);
  const controller = {
    destroy() {
      doc.removeEventListener('click', activate);
      doc.removeEventListener('auxclick', activate);
      for (const form of forms) form.remove();
      forms.clear(); mounted.delete(doc);
    },
  };
  mounted.set(doc, controller);
  return controller;
}
