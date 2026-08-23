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
 * Install:
 *   curl -o ~/.warden-hook.mjs https://raw.githubusercontent.com/MartinPuli/operations-aleph/main/integrations/warden-hook.mjs
 *   chmod +x ~/.warden-hook.mjs
 *
 * Configure (in ~/.zshrc or ~/.bashrc):
 *   export WARDEN_URL=http://192.168.1.42:8080   # the gateway machine
 *   export WARDEN_USER=fede
 *   export WARDEN_ROLE=analyst                   # only used if you are not in the directory
 *
 * WARDEN_ROLE is a fallback, not a claim the gateway honours. Anyone the admin
 * has added to the directory is judged under the role set there, because a role
 * an employee can edit in their own shell profile is a role they could use to
 * pick which rules apply to them.
 */

const WARDEN_URL = process.env.WARDEN_URL ?? 'http://localhost:8080';
const USER = process.env.WARDEN_USER ?? 'unknown';
/** Fallback only — the gateway's directory overrides this for known users. */
const ROLE = process.env.WARDEN_ROLE ?? 'employee';

/**
 * This sits in the developer's keystroke path; past this we get out of the way.
 * Validated, because `Number(garbage)` is NaN and `setTimeout(fn, NaN)` fires
 * on the next tick — a typo'd env var would make every prompt "time out"
 * instantly and sail through unchecked.
 */
const RAW_TIMEOUT = Number(process.env.WARDEN_TIMEOUT_MS);
const TIMEOUT_MS = Number.isFinite(RAW_TIMEOUT) && RAW_TIMEOUT > 0 ? RAW_TIMEOUT : 8000;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Which tool called us, and what the person typed.
 *
 * Inferred from the payload rather than configured, because the alternative is
 * an employee setting a flag per tool and getting it wrong silently. Claude
 * Code's hook events carry `hook_event_name` (and the prompt under `prompt`),
 * which is definitive; Codex also sends `prompt` but no event name; anything
 * wiring itself up through a plugin can say so with `source`.
 *
 * The tool name matters beyond the refusal shape: it is what the gateway
 * records as "seen using", so misattributing it would corrupt an observed fact
 * the console displays.
 *
 * The generic shapes at the bottom are what make "any tool" more than a slogan:
 * a wrapper someone writes in an afternoon only has to put the text on stdin
 * under one of the obvious names.
 */
function detect(payload) {
  const text =
    firstString(payload.prompt, payload.user_input, payload.message, payload.text, payload.input) ??
    lastUserMessage(payload.messages) ??
    '';

  // An explicit source wins: a plugin knows what it is, and guessing from the
  // field name would call OpenCode "codex" because both use `prompt`.
  if (typeof payload.source === 'string' && payload.source) {
    return { tool: payload.source, prompt: text };
  }
  // Claude Code identifies its events; `prompt` alone is how Codex looks.
  if (typeof payload.hook_event_name === 'string' || typeof payload.transcript_path === 'string') {
    return { tool: 'claude-code', prompt: text };
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
  // A caller that opens the hook and never closes stdin would otherwise park
  // us in the keystroke path forever. Unref'd, so it cannot itself keep the
  // process alive — it only fires if something else already is.
  const watchdog = setTimeout(() => {
    process.stderr.write('⚠ warden-hook: no event arrived on stdin. Prompt allowed unchecked.\n');
    process.exit(0);
  }, TIMEOUT_MS * 2);
  watchdog.unref?.();

  const raw = await readStdin();
  clearTimeout(watchdog);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Not an event we recognise. Staying out of the way beats guessing.
    return;
  }

  const { tool, prompt } = detect(payload);
  if (!prompt.trim()) return;

  let res;
  const controller = new AbortController();
  // Cleared in `finally`: now that the process exits naturally instead of via
  // process.exit(), a timer left armed on the failure path would hold the
  // process open for the full timeout after the answer is already known.
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
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
    if (!http.ok) throw new Error(`gateway returned ${http.status}`);
    res = await http.json();
  } catch (err) {
    /**
     * The one place this deliberately fails open.
     *
     * Everywhere inside Warden, an unusable answer escalates. Here it would
     * mean a crashed gateway bricking every developer's CLI at once, and a
     * gateway that can strand the whole team gets uninstalled the first morning
     * it does. Warn loudly, let the prompt through, and let the missing
     * heartbeat be the alert on the admin's side.
     */
    process.stderr.write(
      `⚠ Warden unreachable at ${WARDEN_URL} (${err?.message ?? err}). Prompt allowed unchecked.\n`
    );
    return;
  } finally {
    clearTimeout(timer);
  }

  // Only an explicit BLOCK or ESCALATE stops the prompt. A 200 whose body is
  // not a verdict — a half-upgraded gateway, a shape change, an error page that
  // happens to parse — is a gateway *bug*, and the contract above says gateway
  // failures fail open with a warning. Falling through to the refusal path on
  // `verdict: undefined` would brick every developer's CLI on a malformed
  // response, which is the exact outcome the fail-open exists to prevent.
  // Silence on the happy path, though: a gateway that comments on every prompt
  // becomes noise people learn to scroll past.
  if (res?.verdict !== 'BLOCK' && res?.verdict !== 'ESCALATE') {
    if (res?.verdict !== 'ALLOW') {
      process.stderr.write('⚠ Warden returned no verdict. Prompt allowed unchecked.\n');
    }
    return;
  }

  const message = render(res);
  process.stderr.write(message + '\n');

  /**
   * One JSON shape with every key a supported tool reads: Claude Code stops on
   * `decision: "block"` (and `continue: false` + `stopReason`), Codex reads
   * `decision`/`reason`, and a tool that recognises none of them falls back to
   * the exit code — which is why the non-zero exit below must always happen.
   * Extra keys are inert to a tool that ignores them, so branching per tool
   * only created ways to send the wrong shape.
   */
  process.stdout.write(
    JSON.stringify({ continue: false, stopReason: message, decision: 'block', reason: message }) + '\n'
  );

  // `process.exitCode` rather than `process.exit()`: exit() abandons buffered
  // stdout/stderr, and on a pipe — which a hook's streams always are — that
  // can drop the refusal text and the JSON both, leaving the tool a bare exit
  // code and the employee no explanation.
  process.exitCode = 2;
}

main().catch((err) => {
  // A crash in the hook must never take the employee's tool down with it.
  process.stderr.write(`⚠ warden-hook error: ${err?.message ?? err}\n`);
  process.exitCode = 0;
});
