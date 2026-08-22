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

/** This sits in the developer's keystroke path; past this we get out of the way. */
const TIMEOUT_MS = Number(process.env.WARDEN_TIMEOUT_MS ?? 8000);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Which tool called us, inferred from the payload rather than configured.
 * Claude Code sends `user_input`; Codex sends `prompt`.
 */
function detect(payload) {
  if (typeof payload.user_input === 'string') return { tool: 'claude-code', prompt: payload.user_input };
  if (typeof payload.prompt === 'string') return { tool: 'codex', prompt: payload.prompt };
  return { tool: 'unknown', prompt: '' };
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
        'x-warden-user': USER,
        'x-warden-role': ROLE
      },
      body: JSON.stringify({ prompt, source: tool }),
      signal: controller.signal
    });
    clearTimeout(timer);
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
    process.exit(0);
  }

  // Silence on the happy path. A gateway that comments on every prompt becomes
  // noise people learn to scroll past.
  if (res.verdict === 'ALLOW') process.exit(0);

  const message = render(res);
  process.stderr.write(message + '\n');

  if (tool === 'codex') {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: message }) + '\n');
  } else {
    process.stdout.write(JSON.stringify({ continue: false, reason: message }) + '\n');
  }

  process.exit(2);
}

main().catch((err) => {
  // A crash in the hook must never take the employee's tool down with it.
  process.stderr.write(`⚠ warden-hook error: ${err?.message ?? err}\n`);
  process.exit(0);
});
