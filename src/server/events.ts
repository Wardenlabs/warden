/**
 * The live decision stream, and the prompt text that goes with it.
 *
 * The console's right-hand trace subscribes here. Decisions are pushed as they
 * happen by the routes that produce them via `emitDecision`.
 */
import type { Request, Response } from 'express';
import { remember as rememberPromptText, textFor as promptTextFor } from '../audit/prompts.js';
import { isMock } from '../qvac/index.js';
import { withoutDocumentText } from '../documents/index.js';

const sseClients = new Set<Response>();

/** Hold one browser on the stream until it goes away. */
export function openEventStream(req: Request, res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ mock: isMock() })}\n\n`);
  sseClients.add(res);
  const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(keepalive);
    sseClients.delete(res);
  });
}

/**
 * Prompt text for the console, held in `audit/prompts.ts` with an expiry.
 *
 * The audit log deliberately does not keep prompt text — `recordDecision`
 * strips it, because a log that kept it would be a transcript of everything
 * employees typed, and the log's own header promises it is not one. That is
 * still true and does not move.
 *
 * It is the wrong answer for the screen, though: an operations lead watching a
 * block happen has no way to see what was blocked, and a row that reads "—"
 * looks like a bug rather than a promise being kept. This used to be answered
 * by a Map of the last 300, in the server file, emptied by every restart —
 * which is not a retention policy but an accident of process lifetime, and one
 * nobody could put in writing for the people being logged.
 *
 * It is now a store with a date on it: masked text only, seven days by
 * default, expiry checked on every read so a file that outlived its sweep
 * cannot serve anything, and `WARDEN_PROMPT_RETENTION_DAYS=0` for a deployment
 * that wants nothing on disk at all.
 */
function rememberPrompt(decision: unknown): void {
  if (!decision || typeof decision !== 'object') return;
  const d = decision as { auditId?: unknown; maskedPrompt?: unknown };
  if (typeof d.auditId !== 'string' || typeof d.maskedPrompt !== 'string') return;
  rememberPromptText(d.auditId, d.maskedPrompt);
}

/** Put the text back on entries the store still holds and has not expired. */
export function withRememberedPrompts(entries: unknown): unknown {
  if (!Array.isArray(entries)) return entries;
  return entries.map((e) => {
    const entry = e as { auditId?: unknown; decision?: Record<string, unknown> };
    if (typeof entry.auditId !== 'string' || !entry.decision) return e;
    const text = promptTextFor(entry.auditId);
    if (text === undefined) return e;
    return { ...entry, decision: { ...entry.decision, maskedPrompt: text } };
  });
}

/**
 * Broadcast a decision to every connected trace viewer.
 *
 * `envelope` is for the console and goes beside the decision, never inside it.
 * The `Decision` is what the hook is answered with and what the audit log is
 * built from; neither needs to know which tool asked, and adding a field there
 * to satisfy a screen is how an audit record grows columns nobody audits.
 *
 * `source` exists because the first-run flow has to tell "a request arrived
 * from the tool this person just connected" from "a request arrived". Without
 * it the screen celebrates on any traffic at all, and tells somebody their
 * setup is verified when what it saw was a different tool entirely. See
 * docs/specs/first-run-and-theme.md §4.2.
 *
 * `late` is the gateway noticing its own slowness: a decision that took longer
 * than the hook's deadline reached the hook after it had already let the
 * prompt through. Nothing about the verdict changes — it is recorded and it is
 * real — but the prompt it describes was not actually guarded, and the flow's
 * "Warden did not respond" outcome is the one screen that can say so.
 */
export function emitDecision(decision: unknown, envelope?: { source?: string; late?: boolean }): void {
  if (decision && typeof decision === 'object') decision = withoutDocumentText(decision);
  rememberPrompt(decision);
  const payload = `data: ${JSON.stringify({ type: 'decision', decision, ...envelope })}\n\n`;
  for (const client of sseClients) {
    // One dead viewer must not turn a finished guard decision into a 500.
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}
