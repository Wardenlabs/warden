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

const DEFAULT_HEALTH_TIMEOUT_MS = 2000;
const DEFAULT_DECISION_TIMEOUT_MS = 30_000;

function timeoutFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number, got "${raw}"`);
  }
  return value;
}

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
    firstString(payload.prompt, payload.user_input, payload.message, payload.text, payload.input) ??
    lastUserMessage(payload.messages) ??
    '';

  // An explicit source wins: a plugin knows what it is, and guessing from the
  // field name would call OpenCode "codex" because both use `prompt`.
  if (typeof payload.source === 'string' && payload.source) {
    return { tool: payload.source, prompt: text };
  }
  // Claude Code names its own events, and carries the text under `prompt` —
  // the same field Codex uses. Keying on `user_input` first sent every real
  // Claude Code prompt down the Codex branch, which put the wrong tool on
  // somebody's page in a console that reports these as observed facts.
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

    /**
     * The way out of the dead end.
     *
     * "Can try" and not "will": the gateway refuses to rewrite anything whose
     * phrasing reached for the assistant's own instructions, and it shows a
     * suggestion only if that suggestion passes the same check. Promising one
     * here and then not producing it would be the second refusal in a row,
     * which is worse than not offering.
     *
     * Nothing is written to disk to make this work. The prompt is typed again
     * on stdin, which is also what proves to the gateway that this is the
     * request that was blocked — it matches what you send against the hash in
     * the audit entry, the only form of it that was ever stored.
     */
    if (res.auditId) {
      lines.push('');
      if (res.verdict === 'ESCALATE') {
        // A held prompt has no rewrite to offer — nobody has refused it, so
        // there is nothing to route around. What the reviewer lacks is context:
        // the audit log kept this prompt's hash, not its text.
        lines.push('   The reviewer cannot see what you asked. Tell them why:');
        lines.push(`     warden-hook --note ${res.auditId}`);
      } else {
        lines.push('   Warden can try to rewrite this so it goes through:');
        lines.push(`     warden-hook --rewrite ${res.auditId}`);
        lines.push('     (paste the same prompt, then Ctrl-D)');
        lines.push('');
        lines.push('   Think it was wrong? Say so:');
        lines.push(`     warden-hook --note ${res.auditId}`);
      }
    }
  } else if (res.explanation) {
    lines.push('');
    for (const part of String(res.explanation).split('\n')) lines.push(...wrap(part));
  }

  if (res.verdict === 'ESCALATE') {
    lines.push('');
    lines.push('   Queued for an administrator. You have not been refused —');
    lines.push('   when they answer, ask again and it is judged on its merits.');
  }
  if (res.maskedSpans?.length) {
    lines.push('');
    lines.push(`   Note: ${res.maskedSpans.length} secret(s) were masked before checking.`);
  }

  lines.push('');
  lines.push(`   Audit ${res.auditId} · quote this if you think it is wrong`);
  return lines.join('\n');
}

async function requestJson(url, init, timeoutMs, validate, recoverHttpError) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const http = await fetch(url, { ...init, signal: controller.signal });
    // Keep the controller live through body consumption and validation. A
    // server that sends headers and then stalls must not bypass the deadline.
    const raw = await http.text();
    let value;
    let invalidJson = false;
    try {
      value = JSON.parse(raw);
    } catch {
      invalidJson = true;
    }
    if (!http.ok) {
      const recovered = recoverHttpError?.(http, invalidJson ? undefined : value);
      if (recovered !== undefined) return validate(recovered);
      throw new Error(`gateway returned ${http.status}`);
    }
    if (invalidJson) throw new Error('gateway returned invalid JSON');
    return validate(value);
  } finally {
    clearTimeout(timer);
  }
}

function validateHealth(value) {
  if (!value || typeof value !== 'object' || value.ok !== true) {
    throw new Error('gateway health response is invalid');
  }
  return value;
}

function validateDecision(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('gateway decision is not an object');
  }
  if (!['ALLOW', 'ESCALATE', 'BLOCK'].includes(value.verdict)) {
    throw new Error('gateway decision has an invalid verdict');
  }
  if (typeof value.auditId !== 'string' || !value.auditId.trim()) {
    throw new Error('gateway decision has no audit id');
  }
  if (value.firedRules !== undefined && !Array.isArray(value.firedRules)) {
    throw new Error('gateway decision has invalid fired rules');
  }
  return value;
}

/**
 * Why there is no suggestion, in the terminal.
 *
 * The same set the console renders, composed from the code the gateway sent.
 * Nothing here is generated: these are a fixed handful of outcomes, and a
 * sentence per outcome written once beats a sentence per refusal written by a
 * model that is slower and less accurate than this object.
 */
const REWRITE_REFUSALS = {
  'no-honest-rewrite':
    "There is no honest rewrite of this one — the phrasing reached for the assistant's own instructions.",
  'no-rule': 'No specific rule fired, so there is nothing to rewrite against.',
  'too-long': 'Too long to restate. Ask for the part you actually need.',
  'model-unavailable': 'The local model could not answer. Nothing is suggested rather than guessed.',
  'nothing-left': 'Nothing legitimate was left once the part the rule prohibits was taken out.',
  'still-blocked': 'What it came up with did not pass the same check, so it is not being shown.',
  quota: 'Daily limit reached, so the suggestion could not be re-checked.',
  'already-rewritten': 'This block has already been rewritten once.'
};

/**
 * `warden-hook --rewrite <auditId>` — ask for a version that would go through.
 *
 * Run by hand, never by a tool: this is the employee choosing to follow up on a
 * refusal they just read. It prints to stdout and exits 0 whatever the answer,
 * because it is not judging anything — the decision it is about was made and
 * recorded some seconds ago.
 */
async function rewriteMode(auditId, decisionTimeoutMs) {
  const prompt = (await readStdin()).trim();
  if (!prompt) {
    process.stderr.write('⚠ warden-hook --rewrite: paste the blocked prompt on stdin, then Ctrl-D.\n');
    return;
  }

  let res;
  try {
    res = await requestJson(
      `${WARDEN_URL}/api/guard/rewrite`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ prompt, auditId }),
      },
      decisionTimeoutMs,
      (value) => {
        if (!value || typeof value !== 'object') throw new Error('gateway returned a non-object');
        return value;
      },
      // A refusal here is an answer, not a transport failure: the gateway says
      // 403 for a decision that is not yours and 409 for a second rewrite, and
      // both deserve their own sentence rather than "unreachable".
      (_http, value) => (value && typeof value === 'object' ? value : undefined)
    );
  } catch (err) {
    process.stderr.write(`⚠ Warden unreachable at ${WARDEN_URL} (${err?.message ?? err}).\n`);
    return;
  }

  if (res.suggestion) {
    process.stdout.write(
      [
        '',
        '✎ Warden suggests:',
        '',
        ...wrap(res.suggestion),
        '',
        `   Checked against the same policy before being shown — it came back ALLOW${res.auditId ? ` (audit ${res.auditId})` : ''}.`,
        ''
      ].join('\n') + '\n'
    );
    return;
  }

  const why = REWRITE_REFUSALS[res.reason] ?? res.error ?? 'No suggestion.';
  process.stdout.write(['', '✎ No suggestion.', '', ...wrap(why), ''].join('\n') + '\n');
}

/**
 * `warden-hook --note <auditId>` — say something about a decision.
 *
 * One endpoint, two meanings, decided by what happened rather than by a second
 * flag: on a block it is "this was wrong", on a held prompt it is the context
 * the reviewer does not have. Both end up in front of the same administrator,
 * next to the same audit id.
 *
 * This is the only thing an employee types that Warden keeps. The audit log
 * stores prompts as hashes on purpose; a note escapes that because they chose
 * to write it, about their own request, for a person to read.
 */
async function noteMode(auditId, decisionTimeoutMs) {
  const note = (await readStdin()).trim();
  if (!note) {
    process.stderr.write('⚠ warden-hook --note: type your note on stdin, then Ctrl-D.\n');
    return;
  }

  let res;
  try {
    res = await requestJson(
      `${WARDEN_URL}/api/guard/appeal`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ auditId, note }),
      },
      decisionTimeoutMs,
      (value) => {
        if (!value || typeof value !== 'object') throw new Error('gateway returned a non-object');
        return value;
      },
      (_http, value) => (value && typeof value === 'object' ? value : undefined)
    );
  } catch (err) {
    process.stderr.write(`⚠ Warden unreachable at ${WARDEN_URL} (${err?.message ?? err}).\n`);
    return;
  }

  process.stdout.write(
    res.error
      ? ['', '✎ Not recorded.', '', ...wrap(res.error), ''].join('\n') + '\n'
      : ['', '✎ Sent. Your administrator sees it next to this decision.', ''].join('\n') + '\n'
  );
}

async function main() {
  const healthTimeoutMs = timeoutFromEnv('WARDEN_HEALTH_TIMEOUT_MS', DEFAULT_HEALTH_TIMEOUT_MS);
  const decisionTimeoutMs = timeoutFromEnv('WARDEN_TIMEOUT_MS', DEFAULT_DECISION_TIMEOUT_MS);

  // Run by a person, not by a tool, so it takes its input as a prompt on stdin
  // rather than a hook event — and it never blocks anything.
  for (const [flag, run] of [['--rewrite', rewriteMode], ['--note', noteMode]]) {
    const at = process.argv.indexOf(flag);
    if (at === -1) continue;
    const auditId = process.argv[at + 1];
    if (!auditId) {
      process.stderr.write(`⚠ warden-hook ${flag} needs the audit id Warden printed.\n`);
      return;
    }
    return run(auditId, decisionTimeoutMs);
  }

  // Both timeouts above bound a request; neither bounds the wait for the event
  // itself. A caller that opens the hook and never closes stdin would park us
  // in the developer's keystroke path indefinitely. Unref'd, so it cannot keep
  // the process alive on its own — it only fires if something else already is.
  const watchdog = setTimeout(() => {
    process.stderr.write('⚠ warden-hook: no event arrived on stdin. Prompt allowed unchecked.\n');
    process.exit(0);
  }, decisionTimeoutMs);
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
  try {
    await requestJson(
      `${WARDEN_URL}/health`,
      { method: 'GET' },
      healthTimeoutMs,
      validateHealth
    );
    res = await requestJson(
      `${WARDEN_URL}/api/guard/check`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${API_KEY}`
        },
        body: JSON.stringify({ prompt, source: tool })
      },
      decisionTimeoutMs,
      validateDecision,
      (http, value) => {
        if (http.status !== 401 && http.status !== 403) return undefined;
        const body = value && typeof value === 'object' ? value : {};
        return {
          ...body,
          verdict: 'BLOCK',
          auditId: typeof body.auditId === 'string' && body.auditId ? body.auditId : 'no-key',
          error: typeof body.error === 'string' ? body.error : 'unknown_api_key',
          explanation:
            typeof body.explanation === 'string'
              ? body.explanation
              : 'This gateway did not recognise your Warden API key.'
        };
      }
    );
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
    return;
  }

  // Silence on the happy path. A gateway that comments on every prompt becomes
  // noise people learn to scroll past.
  if (res.verdict === 'ALLOW') return;

  const message = render(res);
  process.stderr.write(message + '\n');

  /**
   * One object carrying every key a supported tool is documented to read, sent
   * whatever the tool. Branching per tool only created ways to send the wrong
   * shape — the `claude-code` branch omitted `decision` and `stopReason`, which
   * are what that tool actually stops on — while an extra key is inert to a
   * tool that ignores it. The non-zero exit below is still the part that must
   * always happen, because it is the one signal every caller understands.
   */
  process.stdout.write(
    JSON.stringify({ continue: false, stopReason: message, decision: 'block', reason: message }) + '\n'
  );

  process.exitCode = 2;
}

main().catch((err) => {
  // A crash in the hook must never take the employee's tool down with it.
  process.stderr.write(`⚠ warden-hook error: ${err?.message ?? err}\n`);
  process.exitCode = 0;
});
