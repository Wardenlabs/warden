#!/usr/bin/env node
/**
 * warden-hook — the only file an employee needs.
 *
 * Claude Code and Codex both fire a `UserPromptSubmit` hook when someone
 * presses Enter, before the prompt is sent anywhere. This reads that event,
 * asks the company's Warden gateway, and either stays out of the way or kills
 * the prompt.
 *
 * Zero dependencies, single file, plain Node. That is deliberate: the guard
 * itself is a service with models and a policy store, but the thing every
 * employee installs has to be something they can curl and forget. Anything
 * heavier does not get rolled out.
 *
 * Install — your admin gives you the link, which already has your key in it:
 *   curl -fsSL http://192.168.1.42:8080/install/<you> | sh
 *
 * Or by hand, in ~/.zshrc or ~/.bashrc:
 *   export WARDEN_URL=http://192.168.1.42:8080   # the gateway machine
 *   export WARDEN_API_KEY=wk-fede-8b1d40e2       # issued by your admin
 *
 * The key is the whole identity. There is no name to set and no role to set:
 * your admin decides what your key means and can change it without you touching
 * anything here — and a role you could set yourself would be a role you could
 * use to pick the rules that judge you. A key this gateway does not recognise is
 * refused outright, which is also how revoking one works.
 */

const WARDEN_URL = process.env.WARDEN_URL ?? 'http://localhost:8080';
const API_KEY = process.env.WARDEN_API_KEY ?? '';

/** This sits in the developer's keystroke path; past this we get out of the way. */
const TIMEOUT_MS = Number(process.env.WARDEN_TIMEOUT_MS ?? 8000);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Which tool called us, and what the person typed.
 *
 * Inferred from the payload rather than configured, because the alternative is
 * an employee setting a flag per tool and getting it wrong silently. Claude Code
 * sends `user_input`, Codex sends `prompt`, and anything wiring itself up
 * through a plugin can say so with `source`.
 *
 * The generic shapes at the bottom are what make "any tool" more than a slogan:
 * a wrapper someone writes in an afternoon only has to put the text on stdin
 * under one of the obvious names.
 */
function detect(payload) {
  const text =
    firstString(payload.user_input, payload.prompt, payload.message, payload.text, payload.input) ??
    lastUserMessage(payload.messages) ??
    '';

  // An explicit source wins: a plugin knows what it is, and guessing from the
  // field name would call OpenCode "codex" because both use `prompt`.
  if (typeof payload.source === 'string' && payload.source) {
    return { tool: payload.source, prompt: text };
  }
  if (typeof payload.user_input === 'string') return { tool: 'claude-code', prompt: text };
  if (typeof payload.prompt === 'string') return { tool: 'codex', prompt: text };
  return { tool: text ? 'generic' : 'unknown', prompt: text };
}

function firstString(...values) {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v;
  return undefined;
}

/** OpenAI-shaped payloads: judge the last thing the person actually said. */
function lastUserMessage(messages) {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user' && typeof m.content === 'string') return m.content;
  }
  return undefined;
}

/**
 * What the employee sees in their own terminal.
 *
 * This is the entire product from their side, and a refusal that only says
 * "blocked by policy" is a dead end — it leaves them holding a question with
 * nowhere to take it, and the second time it happens they start working around
 * the gateway. So the block names the rule, says what to do instead, and shows
 * two nearby requests that would have gone through.
 *
 * Wrapped, because these land in a narrow terminal pane and an unwrapped
 * paragraph is one nobody reads.
 */
function wrap(text, indent = '   ', width = 76) {
  const out = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    if (line && (line + ' ' + word).length > width) {
      out.push(indent + line);
      line = word;
    } else {
      line = line ? line + ' ' + word : word;
    }
  }
  if (line) out.push(indent + line);
  return out;
}

function render(res) {
  // An unrecognised key is not a policy decision and must not read like one —
  // the person needs to know it is their credential, not something they typed.
  if (res.error === 'unknown_api_key' || res.auditId === 'no-key') {
    return [
      '🔑 Warden did not recognise your API key',
      '',
      ...wrap(res.explanation ?? 'Ask your administrator for a current key.'),
      '',
      '   Set it with: export WARDEN_API_KEY=wk-…'
    ].join('\n');
  }

  const lines = [res.verdict === 'BLOCK' ? '⛔ Blocked by Warden' : '⏸ Held for review by Warden'];
  const rule = res.firedRules?.[0];

  if (rule) {
    lines.push('');
    lines.push(...wrap(rule.ruleText));

    if (rule.guidance) {
      lines.push('');
      lines.push('   What to do instead');
      lines.push(...wrap(rule.guidance));
    } else if (rule.reason) {
      lines.push(...wrap(rule.reason));
    }

    if (rule.allowedExamples?.length) {
      lines.push('');
      lines.push('   These would go through');
      for (const example of rule.allowedExamples) lines.push(`     · ${example}`);
    }

    const others = (res.firedRules?.length ?? 1) - 1;
    if (others > 0) {
      lines.push('');
      lines.push(`   ${others} other rule${others > 1 ? 's' : ''} also matched.`);
    }
  } else if (res.explanation) {
    lines.push('');
    for (const part of String(res.explanation).split('\n')) lines.push(...wrap(part));
  }

  if (res.verdict === 'ESCALATE') {
    lines.push('');
    lines.push('   Queued for an administrator. You have not been refused.');
  }
  if (res.maskedSpans?.length) {
    lines.push('');
    lines.push(`   Note: ${res.maskedSpans.length} secret(s) were masked before checking.`);
  }

  lines.push('');
  lines.push(`   Audit ${res.auditId} · quote this if you think it is wrong`);
  return lines.join('\n');
}

async function main() {
  const raw = await readStdin();

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Not an event we recognise. Staying out of the way beats guessing.
    process.exit(0);
  }

  const { tool, prompt } = detect(payload);
  if (!prompt.trim()) process.exit(0);

  let res;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const http = await fetch(`${WARDEN_URL}/api/guard/check`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${API_KEY}`
      },
      body: JSON.stringify({ prompt, source: tool }),
      signal: controller.signal
    });
    clearTimeout(timer);

    /**
     * A rejected credential is an answer, not a failure.
     *
     * This is the line that separates the two error paths, and getting it wrong
     * either way is bad. A gateway that cannot be reached must not brick every
     * developer's CLI — that is the fail-open case below. But a gateway that
     * answered, and answered "I do not know this key", has governed the request:
     * treating that as an outage would mean revoking somebody's key silently
     * granted them unlimited access, which is the opposite of revocation.
     */
    if (http.status === 401 || http.status === 403) {
      res = await http.json().catch(() => ({
        verdict: 'BLOCK',
        auditId: 'no-key',
        explanation: 'This gateway did not recognise your Warden API key.'
      }));
    } else if (!http.ok) {
      throw new Error(`gateway returned ${http.status}`);
    } else {
      res = await http.json();
    }
  } catch (err) {
    /**
     * The one place this deliberately fails open.
     *
     * Everywhere inside Warden, an unusable answer escalates. Here it would
     * mean a crashed gateway bricking every developer's CLI at once, and a
     * gateway that can strand the whole team gets uninstalled the first morning
     * it does. Warn loudly, let the prompt through, and let the missing
     * heartbeat be the alert on the admin's side.
     *
     * Note this catch no longer swallows a rejected key: that is handled above
     * as the answer it is.
     */
    process.stderr.write(
      `⚠ Warden unreachable at ${WARDEN_URL} (${err?.message ?? err}). Prompt allowed unchecked.\n`
    );
    process.exit(0);
  }

  // Silence on the happy path. A gateway that comments on every prompt becomes
  // noise people learn to scroll past.
  if (res.verdict === 'ALLOW') process.exit(0);

  const message = render(res);
  process.stderr.write(message + '\n');

  /**
   * Each tool reads a different refusal shape, and a tool that does not
   * recognise the one it gets falls back to the exit code — which is why
   * `exit 2` below is the part that must always happen.
   */
  if (tool === 'codex') {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: message }) + '\n');
  } else if (tool === 'claude-code') {
    process.stdout.write(JSON.stringify({ continue: false, reason: message }) + '\n');
  } else {
    // Unknown callers get both keys. Neither is harmful to a tool that ignores
    // it, and one of them is probably the one it reads.
    process.stdout.write(
      JSON.stringify({ continue: false, decision: 'block', reason: message }) + '\n'
    );
  }

  process.exit(2);
}

main().catch((err) => {
  // A crash in the hook must never take the employee's tool down with it.
  process.stderr.write(`⚠ warden-hook error: ${err?.message ?? err}\n`);
  process.exit(0);
});
