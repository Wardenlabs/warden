/**
 * Limits by role: the one save both editors go through.
 *
 * A role's daily limit is edited on Team → Roles and its session ceilings on
 * Models, where the notion of a token lives. They are one row in the policy and
 * one `PUT /api/quotas/:role`, and that route is an upsert of the whole row: a
 * field left out is removed, and a row with no daily limit is removed entirely,
 * ceilings with it. So each editor sends what it changed on top of what the row
 * already holds, and the one case where the API will drop something — clearing
 * the daily limit of a role with ceilings — is said by the editor before it is
 * saved (docs/specs/console-redesign-v2-api-gaps.md).
 *
 * The save goes through the policy like any ratified change — quotas are inside
 * the policy hash, so raising a ceiling re-versions the policy and lands in the
 * audit trail. That is why these are editors with a Save rather than fields that
 * write as you type: changing what a team may spend should have to be meant.
 */
import { post, state } from './core.js';
import { refreshPolicy } from './data.js';

export const QUOTA_FIELDS = ['maxRequestsPerDay', 'maxSessionOutputTokens', 'maxContextTokens', 'maxPromptChars'];

export const quotaOf = (role) => state.policy.quotas?.find((q) => q.role === role) ?? { role };

/** A field's value from a text box: blank is "no limit", which the API spells as absent. */
export function limitValue(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isInteger(n) && n > 0 ? n : NaN;
}

/**
 * Save `changes` over the role's current row. Returns `{ ok, error }`.
 * `NaN` in a change is a value that is not a positive whole number.
 */
export async function saveQuota(role, changes) {
  if (Object.values(changes).some((v) => Number.isNaN(v))) return { ok: false, error: 'Use a whole number above zero, or leave it blank for no limit.' };
  const current = quotaOf(role);
  const body = Object.fromEntries(QUOTA_FIELDS.map((k) => [k, k in changes ? changes[k] : current[k] ?? null]));
  const { ok, j } = await post(`/api/quotas/${encodeURIComponent(role)}`, body, { method: 'PUT' })
    .catch(() => ({ ok: false, j: { error: 'Warden could not be reached.' } }));
  if (!ok) return { ok: false, error: j?.error ?? 'The limit could not be saved.' };
  await refreshPolicy();
  return { ok: true };
}

/** The editors bind themselves now; this stays so an older caller is a no-op, not a throw. */
export function bindLimits() {}
