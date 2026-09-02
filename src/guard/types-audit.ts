/** Shape of an audit-log entry, shared by the log writer and the API. */
import type { Decision } from './types.js';

/**
 * What of a decision is persisted. `maskedPrompt` is deliberately absent: the
 * log stores the prompt's hash, and keeping the text — even secret-masked —
 * would quietly turn the governance record into a transcript of everything
 * employees typed, which is the exposure the README promises the log is not.
 */
export type AuditedDecision = Omit<Decision, 'maskedPrompt'>;

export type AuditEntry = {
  auditId: string;
  ts: string;
  actor: { id: string; role: string };
  promptHash: string;
  decision: AuditedDecision;
  /** sha256(prevHash + this entry, minus this field). Chains the log. */
  entryHash: string;
  prevHash: string;
};

/**
 * An administrator changed something.
 *
 * In the same file and the same hash chain as the decisions, because the
 * question an incident asks is "what happened, in order" and two logs cannot
 * answer that — and because a chain that covers only the decisions leaves the
 * edits to the rules that produced them unprotected, which is the wrong half.
 *
 * `action` is the method and path and nothing else. No body: a request to
 * `/api/people/:id/key` carries a credential and one to `/api/policy/ratify`
 * carries rule text, and this log's whole promise is that it is not a
 * transcript. What changed is recoverable from the policy's own version hash;
 * who and when is what was missing.
 */
export type AdminAuditEntry = {
  auditId: string;
  ts: string;
  actor: { id: string; role: string };
  kind: 'admin';
  action: string;
  /** HTTP status the route answered with, so refusals are legible too. */
  status: number;
  entryHash: string;
  prevHash: string;
};
