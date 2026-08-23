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
