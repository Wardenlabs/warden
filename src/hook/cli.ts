#!/usr/bin/env node
/**
 * `warden-hook` — the bridge between an employee's coding agent and the guard.
 *
 * Claude Code and Codex both fire a `UserPromptSubmit` hook when the employee
 * presses Enter, before the prompt is sent anywhere. That is the only
 * interception point that works regardless of how the tool authenticates: a
 * subscription plan logs in over OAuth and talks to a fixed endpoint, so there
 * is no base URL to redirect, but the hook still runs locally first.
 *
 * The whole program is: read JSON on stdin, ask the guard, exit 0 or 2.
 *
 * Usage (configured by the tool, not run by hand):
 *   echo '{"user_input":"..."}' | warden-hook
 */
import { stdin } from 'node:process';

/** Where the guard lives. Point at another machine's gateway over the LAN. */
const WARDEN_URL = process.env['WARDEN_URL'] ?? 'http://localhost:8080';

/** Identity, supplied by whoever installed the hook. */
const USER = process.env['WARDEN_USER'] ?? 'unknown';
const ROLE = process.env['WARDEN_ROLE'] ?? 'employee';

/**
 * The guard sits in the employee's keystroke path, so a slow check is a broken
 * tool. Past this, we let the prompt through rather than make someone wait.
 */
const TIMEOUT_MS = Number(process.env['WARDEN_TIMEOUT_MS'] ?? 8000);

type Verdict = 'ALLOW' | 'ESCALATE' | 'BLOCK';

type GuardResponse = {
  verdict: Verdict;
  auditId: string;
  explanation: string;
  firedRules: { ruleId: string; ruleText: string; reason: string }[];
  maskedSpans: { kind: string }[];
};

/** Which tool called us, inferred from the payload rather than configured. */
type Tool = 'claude-code' | 'codex' | 'unknown';

function detect(payload: Record<string, unknown>): { tool: Tool; prompt: string } {
  if (typeof payload['user_input'] === 'string') {
    return { tool: 'claude-code', prompt: payload['user_input'] };
  }
  if (typeof payload['prompt'] === 'string') {
    return { tool: 'codex', prompt: payload['prompt'] };
  }
  return { tool: 'unknown', prompt: '' };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** What the employee reads in their terminal. Names the rule, not just "denied". */
function blockMessage(res: GuardResponse): string {
  const lines = [`⛔ Blocked by Warden`];
  const rule = res.firedRules[0];
  if (rule) {
    lines.push(`   Rule: ${rule.ruleText}`);
    if (rule.reason) lines.push(`   Why:  ${rule.reason}`);
  } else if (res.explanation) {
    lines.push(`   ${res.explanation}`);
  }
  if (res.maskedSpans.length > 0) {
    lines.push(`   Note: ${res.maskedSpans.length} secret(s) were masked before checking.`);
  }
  lines.push(`   Audit: ${res.auditId}`);
  return lines.join('\n');
}

function escalateMessage(res: GuardResponse): string {
  const rule = res.firedRules[0];
  return [
    `⏸ Held for review by Warden`,
    rule ? `   Rule: ${rule.ruleText}` : `   ${res.explanation}`,
    `   An administrator has been notified. Audit: ${res.auditId}`
  ].join('\n');
}

async function main(): Promise<void> {
  const raw = await readStdin();

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Not something we recognise. Staying out of the way beats guessing.
    process.exit(0);
  }

  const { tool, prompt } = detect(payload);
  if (!prompt.trim()) process.exit(0);

  let res: GuardResponse;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const http = await fetch(`${WARDEN_URL}/api/guard/check`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-warden-user': USER,
        'x-warden-role': ROLE
      },
      body: JSON.stringify({ prompt, source: tool }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!http.ok) throw new Error(`guard returned ${http.status}`);
    res = (await http.json()) as GuardResponse;
  } catch (err) {
    /**
     * The one place in Warden that fails open.
     *
     * Everywhere else, an unusable answer escalates. Here it would mean a
     * crashed daemon silently bricking every developer's CLI, and a gateway
     * that can strand the whole team gets uninstalled the first morning it
     * does. Warn loudly on stderr, let the prompt through, and let the missing
     * heartbeat be the alert.
     */
    process.stderr.write(
      `⚠ Warden unreachable at ${WARDEN_URL} (${err instanceof Error ? err.message : err}). ` +
      `Prompt allowed unchecked.\n`
    );
    process.exit(0);
  }

  if (res.verdict === 'ALLOW') {
    // Silence on the happy path. A gateway that comments on every prompt
    // becomes noise people learn to skip past.
    process.exit(0);
  }

  const message = res.verdict === 'BLOCK' ? blockMessage(res) : escalateMessage(res);
  process.stderr.write(message + '\n');

  if (tool === 'codex') {
    // Codex reads a decision object from stdout; the reason surfaces in its UI.
    process.stdout.write(JSON.stringify({ decision: 'block', reason: message }) + '\n');
  } else {
    // Claude Code honours `continue: false` with a reason, and treats exit 2
    // as a hard block regardless. Emitting both covers either path.
    process.stdout.write(JSON.stringify({ continue: false, reason: message }) + '\n');
  }

  process.exit(2);
}

main().catch((err: unknown) => {
  // A crash in the hook must not take the employee's tool with it.
  process.stderr.write(`⚠ warden-hook error: ${err instanceof Error ? err.message : err}\n`);
  process.exit(0);
});
