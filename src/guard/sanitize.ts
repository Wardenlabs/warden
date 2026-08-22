/**
 * Pass -1 — find secrets and mask them before anything else sees the text.
 *
 * Runs first, ahead of every model call, because the point is that a leaked
 * credential never reaches inference, never reaches an upstream provider, and
 * never lands in the audit log. Masking after the fact would be theatre.
 *
 * No model here. Detection is patterns and entropy, which is both instant and
 * unbypassable by anything written in the message.
 */
import type { MaskedSpan } from './types.js';

type Pattern = { kind: MaskedSpan['kind']; re: RegExp; label: string };

/**
 * Ordered most-specific first: a GitHub token also looks like a high-entropy
 * string, and naming it precisely produces a better message for the employee.
 */
const PATTERNS: Pattern[] = [
  { kind: 'api-key', label: 'OpenAI key',    re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'api-key', label: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'api-key', label: 'GitHub token',  re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { kind: 'api-key', label: 'AWS key id',    re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: 'api-key', label: 'Slack token',   re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'api-key', label: 'Google key',    re: /\bAIza[A-Za-z0-9_-]{35}\b/g },
  { kind: 'token',   label: 'JWT',           re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: 'token',   label: 'private key',   re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  // Anchored on digits at both ends so it cannot swallow the following space —
  // an earlier version turned "…332211 es del cliente" into "…]es del cliente".
  { kind: 'card',    label: 'card number',   re: /\b\d(?:[ -]?\d){12,18}\b/g },
  { kind: 'email',   label: 'email',         re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g }
];

/** Shannon entropy in bits per character. */
function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Catch credentials that match no known vendor format.
 *
 * A long mixed-case alphanumeric run with high entropy is either a secret or a
 * hash, and neither belongs in a prompt. The 3.5-bit floor and 24-character
 * minimum are set to clear ordinary prose and identifiers — English text sits
 * near 4 bits per character but rarely produces unbroken 24-character runs, and
 * base64-ish secrets sit well above.
 */
const HIGH_ENTROPY = /\b[A-Za-z0-9+/_-]{24,}\b/g;
const ENTROPY_FLOOR = 3.5;

/** Words that look secret-ish but are ordinary in a work message. */
const ALLOWLIST = /^(?:[A-Za-z]+(?:[A-Z][a-z]+)+|[a-z]+(?:_[a-z]+)+|[A-Za-z]+-[A-Za-z-]+)$/;

export type SanitizeResult = {
  /** The text to use everywhere downstream. */
  masked: string;
  spans: MaskedSpan[];
};

/**
 * Replace anything that looks like a credential with a labelled placeholder.
 *
 * The placeholder names what was found so the assistant can still reason about
 * the request ("rotate this key") without ever holding the value, and so the
 * employee understands what happened.
 */
export function sanitize(text: string): SanitizeResult {
  // Every match is located against the *original* text, then replacements are
  // applied back-to-front. Replacing as we scan would shift every subsequent
  // offset by the length difference, so recorded spans would point at the wrong
  // place in the text the caller still holds — and those offsets are what a UI
  // would use to highlight what was masked.
  type Hit = { kind: MaskedSpan['kind']; start: number; end: number; raw: string; label: string };
  const hits: Hit[] = [];

  const claim = (start: number, end: number) =>
    hits.some((h) => start < h.end && end > h.start);

  for (const { kind, re, label } of PATTERNS) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      // Patterns run most-specific first, so an earlier, better-named match
      // wins any overlap.
      if (claim(start, end)) continue;
      if (kind === 'card' && !isPlausibleCard(m[0])) continue;
      hits.push({ kind, start, end, raw: m[0], label });
    }
  }

  for (const m of text.matchAll(HIGH_ENTROPY)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (claim(start, end)) continue;
    if (ALLOWLIST.test(m[0])) continue;
    if (entropy(m[0]) < ENTROPY_FLOOR) continue;
    hits.push({ kind: 'high-entropy', start, end, raw: m[0], label: 'possible secret' });
  }

  hits.sort((a, b) => a.start - b.start);

  let masked = '';
  let cursor = 0;
  for (const h of hits) {
    masked += text.slice(cursor, h.start) + `[REDACTED:${h.label}]`;
    cursor = h.end;
  }
  masked += text.slice(cursor);

  return {
    masked,
    spans: hits.map((h) => ({ kind: h.kind, start: h.start, end: h.end, preview: preview(h.raw) }))
  };
}

/**
 * Luhn check, so order numbers and long IDs are not mistaken for cards.
 *
 * A false positive here redacts something the employee legitimately needs,
 * which erodes trust in the gateway faster than a missed card would.
 */
function isPlausibleCard(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * A fragment for the audit trail — enough to recognise which secret was hit,
 * never enough to use it. The raw value is not retained anywhere.
 */
function preview(secret: string): string {
  return secret.length <= 8
    ? `${secret.slice(0, 2)}…`
    : `${secret.slice(0, 4)}…${secret.slice(-2)}`;
}
