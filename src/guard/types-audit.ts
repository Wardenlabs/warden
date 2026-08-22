/** Shape of an audit-log entry, shared by the log writer and the API. */
import type { Decision } from './types.js';

export type AuditEntry = {
  auditId: string;
  ts: string;
  actor: { id: string; role: string };
  promptHash: string;
  decision: Decision;
  /** sha256(prevHash + this entry, minus this field). Chains the log. */
  entryHash: string;
  prevHash: string;
};
