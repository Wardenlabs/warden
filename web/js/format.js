/**
 * Turning records into words: hashes, times, rule names, audiences, avatars, the clipboard, and Enter-to-send.
 */
import { $, esc, state } from './core.js';

// ── formatting ───────────────────────────────────────────────────────────────

export const shortHash = (h) => (h ? String(h).slice(0, 8) : '—');
export const dayKey = (ts) => String(ts).slice(0, 10);

export function dayLabel(key) {
  const today = dayKey(new Date().toISOString());
  if (key === today) return 'Today';
  if (key === new Date(Date.now() - 86400000).toISOString().slice(0, 10)) return 'Yesterday';
  return new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export const hhmm = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
export const clip = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
export const plural = (n, one, many) => `${n} ${n === 1 ? one : (many ?? `${one}s`)}`;

/**
 * A rule's name in words.
 *
 * `r-customer-pii` is an identifier, and an identifier in a list is a thing a
 * non-technical reader skips. Seeded rules carry a meaningful slug; rules
 * compiled at runtime get a generated id, and for those the opening clause of
 * the rule reads better than the id ever would.
 */
const ACRONYMS = { pii: 'PII', api: 'API', ceo: 'CEO', hr: 'HR', id: 'ID', kyc: 'KYC', sso: 'SSO' };
const GENERATED_ID = /^r-(preset|draft|\d)/;

export function ruleName(ruleOrId) {
  const rule = typeof ruleOrId === 'string' ? ruleById(ruleOrId) : ruleOrId;
  const id = typeof ruleOrId === 'string' ? ruleOrId : ruleOrId?.id;

  if (id && /^r-/.test(id) && !GENERATED_ID.test(id)) {
    return id.slice(2).split('-').filter(Boolean)
      .map((w) => ACRONYMS[w] ?? w).join(' ')
      .replace(/^./, (c) => c.toUpperCase());
  }
  return clip(String(rule?.text ?? '').split(/[.;—]/)[0], 48) || id || 'rule';
}

/** Initials on a neutral disc. No photo service and no generated hue: eight
 *  tinted avatars competing with three verdict colours is why nothing on the
 *  old console read at a glance. */
export function avatar(person, big = false) {
  const initials = String(person?.name ?? '?').split(/\s+/)
    .map((w) => w.match(/\p{L}/u)?.[0] ?? '')
    .filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';
  return `<span class="avatar${big ? ' lg' : ''}">${esc(initials)}</span>`;
}

export const personById = (id) => state.company.employees.find((e) => e.id === id) ?? null;
export const actorName = (actor) => personById(actor?.id)?.name ?? actor?.id ?? 'unknown';

/** `@id` means nothing to a reader; resolve it to a name. */
export function audienceLabel(appliesTo) {
  if (!appliesTo?.length) return 'nobody';
  if (appliesTo.includes('*')) return 'everyone';
  return appliesTo
    .map((t) => (t.startsWith('@') ? (personById(t.slice(1))?.name ?? `${t.slice(1)} (removed)`) : t))
    .join(', ');
}

export const isPersonal = (rule) => rule.appliesTo?.some((t) => t.startsWith('@'));
const ruleById = (id) => state.policy.rules.find((r) => r.id === id) ?? null;

export const TOOL_NAMES = {
  'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor',
  opencode: 'OpenCode', generic: 'other tool', proxy: 'API'
};

/**
 * Copy to clipboard, with a fallback that actually matters here.
 *
 * The console is normally opened over the LAN at http://192.168.x.x, which is
 * not a secure context, and `navigator.clipboard` is undefined there.
 */
export async function copyText(text, btn) {
  let ok = false;
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); ok = true; }
  } catch { /* fall through to the textarea trick */ }

  if (!ok) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.className = 'offscreen';
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

/**
 * Enter sends, Shift+Enter writes a newline.
 *
 * Both composers used to want Cmd or Ctrl held down, which is the shortcut a
 * text editor teaches and not the one a chat does. Every box on this screen
 * looks like a chat, so people press Enter, and Enter did nothing but grow the
 * textarea by one line.
 *
 * `isComposing` is checked because an IME uses Enter to accept a candidate:
 * without it, typing anything through a Japanese or Korean keyboard sends the
 * message halfway through the word.
 */
export function sendOnEnter(el, send) {
  if (!el) return;
  el.onkeydown = (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    send();
  };
}
