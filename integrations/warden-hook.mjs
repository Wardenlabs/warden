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

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const WARDEN_URL = process.env.WARDEN_URL ?? 'http://localhost:8080';
const API_KEY = process.env.WARDEN_API_KEY ?? '';

const DEFAULT_HEALTH_TIMEOUT_MS = 2000;
/*
 * The deadline after which the hook gives up and lets the prompt through
 * unchecked.
 *
 * It fails open, which is documented in SECURITY.md as a deliberate trade and
 * is the reason this number is a security parameter rather than a comfort
 * setting: every second under the adjudicator's real latency is a second in
 * which the guard stops guarding, silently, on the path an employee actually
 * uses.
 *
 * 30 s was calibrated against the 1.7B, which answers in a few. The optional
 * 8B adjudicator was measured at 46 s on four CPU cores, so on that seat the
 * old default did not judge slowly — it did not judge at all. 90 s covers it
 * with room for a cold load, and still sits inside Claude Code's own hook
 * timeout once that is raised alongside it (integrations/claude-code/settings.json).
 * Both halves are needed: the harness kills the hook on its own clock, and a
 * hook killed by the harness also fails open.
 *
 * The cost is a person waiting. That is the trade being made here, out loud.
 */
const DEFAULT_DECISION_TIMEOUT_MS = 90_000;

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
/**
 * What this session has cost so far, read off the tool's own transcript.
 *
 * Claude Code hands the hook a `transcript_path`, and every assistant turn in
 * that file carries the provider's own `usage` block. So these are real counts
 * rather than an estimate of the prompt — which matters, because the thing an
 * admin wants capped is what the provider bills, and Warden never sees the
 * provider on this path.
 *
 * It is also a file on the employee's machine, which they can edit. That is the
 * honest limit of this control and it is documented where the gateway reads it.
 *
 * Measured at 149 ms over a 44 MB, 2724-turn transcript — the largest on the
 * machine this was written on. That is noise against the decision deadline, but
 * the bound below exists so a pathological file cannot put the employee's
 * keystroke path behind a disk read.
 *
 * Never throws. A transcript that cannot be read means Warden cannot see the
 * spend, and the gateway is told nothing rather than told zero — the two are
 * different, and only one of them is a lie.
 */
const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;

function readUsage(payload, tool) {
  const path = typeof payload?.transcript_path === 'string' ? payload.transcript_path : '';
  if (!path) return undefined;

  try {
    if (statSync(path).size > MAX_TRANSCRIPT_BYTES) return undefined;

    let outputTokens = 0;
    let last = null;
    let model;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      // Most lines are user turns and tool results. Skipping them before
      // JSON.parse is what keeps this in the tens of milliseconds.
      if (!line || line.indexOf('"usage"') === -1) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // a half-written trailing line is normal on a live session
      }
      const u = entry?.type === 'assistant' ? entry?.message?.usage : null;
      if (!u) continue;
      outputTokens += u.output_tokens ?? 0;
      last = u;
      // The model sits beside the token counts in the same entry, and the
      // governance record could not previously answer "what is my company
      // sending, and to what". Taken from the most recent assistant turn
      // rather than the first: a session that switched models is described by
      // the one it is on now.
      if (typeof entry?.message?.model === 'string') model = entry.message.model;
    }

    if (!last) return undefined;

    // Context is the last turn, not a sum: it is how full the window is now.
    // Summing it would count the same cached prefix once per turn and produce a
    // number in the tens of millions that means nothing.
    const contextTokens =
      (last.input_tokens ?? 0) +
      (last.cache_read_input_tokens ?? 0) +
      (last.cache_creation_input_tokens ?? 0);

    return { outputTokens, contextTokens, source: tool, ...(model ? { model } : {}) };
  } catch {
    return undefined;
  }
}

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
    lines.push('   Queued for an administrator. You have not been refused,');
    lines.push('   when they answer, ask again and it is judged on its merits.');
  }
  if (res.maskedSpans?.length) {
    lines.push('');
    lines.push(`   Note: Warden masked ${res.maskedSpans.length} secret(s) before checking.`);
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
  if (value.warnings !== undefined && !Array.isArray(value.warnings)) {
    return 'warnings must be an array when present';
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
    "There is no honest rewrite of this one, because the phrasing reached for the assistant's own instructions.",
  'no-rule': 'No specific rule fired, so there is nothing to rewrite against.',
  'too-long': 'Too long to restate. Ask for the part you actually need.',
  'model-unavailable': 'The local model could not answer. Nothing is suggested rather than guessed.',
  'nothing-left': 'Nothing legitimate was left once the part the rule prohibits was taken out.',
  'still-blocked': 'What it came up with did not pass the same check, so Warden is not showing it.',
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
        `   Checked against the same policy before being shown, and it came back ALLOW${res.auditId ? ` (audit ${res.auditId})` : ''}.`,
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

/* ── which agents are on this machine ─────────────────────────────────────
 *
 * `warden-hook --detect` looks at the disk and says which coding agents are
 * installed here and which of them Warden is actually wired into.
 *
 * It lives in the hook because the hook is the only part of Warden that runs
 * on the employee's machine. The gateway cannot answer this question — it is
 * on somebody else's computer, and it learns a tool exists only when a prompt
 * turns up from one, which is `activity.ts`: a liveness view, and one that
 * stays empty for exactly the tool nobody wired up. That is the case worth
 * catching, and it is the one an inventory built from traffic can never see.
 *
 * Read-only, and never a blocker. It touches config files, prints, and exits
 * 0 whatever it finds — the failure mode of a detector that guessed wrong and
 * refused something would be far worse than the failure mode of one that says
 * "not found" about a tool sitting somewhere unusual.
 *
 * What it does NOT do is decide anything. It cannot tell the gateway who you
 * are, and nothing here is sent anywhere: identity is the API key and only the
 * API key, and a list of installed programs is not an identity.
 */

/** Does this file exist and contain all of these strings? */
function fileMentions(path, ...needles) {
  try {
    const body = readFileSync(path, 'utf8');
    return needles.every((needle) => body.includes(needle));
  } catch {
    return false;
  }
}

/**
 * Where each agent keeps its configuration, and what "wired" looks like there.
 *
 * Several candidate paths per tool rather than one, because a wrong single
 * guess reports "not installed" for something the employee is looking at. The
 * marker is `warden-hook` in the file that would carry the hook — matching the
 * command rather than a filename, so it still detects an installation that put
 * the hook somewhere other than the home directory.
 */
const AGENTS = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    homes: ['.claude', '.claude.json'],
    wired: () => fileMentions(join(homedir(), '.claude', 'settings.json'), 'UserPromptSubmit', 'warden-hook'),
    how: 'add the UserPromptSubmit hook to ~/.claude/settings.json',
    governable: true
  },
  {
    id: 'codex',
    name: 'Codex',
    homes: ['.codex'],
    wired: () => fileMentions(join(homedir(), '.codex', 'config.toml'), 'hooks.UserPromptSubmit', 'warden-hook'),
    how: 'add [[hooks.UserPromptSubmit]] to ~/.codex/config.toml',
    governable: true
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    homes: [join('.config', 'opencode'), join('.local', 'share', 'opencode')],
    wired: () => existsSync(join(homedir(), '.config', 'opencode', 'plugin', 'warden.js')),
    how: 'copy warden.js into ~/.config/opencode/plugin/',
    governable: true
  },
  {
    id: 'cursor',
    name: 'Cursor',
    homes: ['.cursor', join('Library', 'Application Support', 'Cursor'), join('AppData', 'Roaming', 'Cursor')],
    // Nothing to look for. Cursor has no prompt hook, so there is no wiring on
    // this machine that could govern it — the only path is the gateway's
    // OpenAI-compatible endpoint, which needs an API key and therefore cannot
    // govern a Cursor subscription at all. Saying "not wired" would imply a
    // step somebody forgot.
    wired: () => false,
    how: 'no prompt hook — OPENAI_BASE_URL + a per-employee key, which needs an API key rather than a subscription',
    governable: false
  }
];

function detectAgents() {
  const home = homedir();
  return AGENTS.map((agent) => {
    const found = agent.homes.map((h) => join(home, h)).find((path) => existsSync(path)) ?? null;
    return {
      id: agent.id,
      name: agent.name,
      installed: found !== null,
      at: found,
      governable: agent.governable,
      wired: found !== null && agent.governable ? agent.wired() : false,
      how: agent.how
    };
  });
}

/**
 * `warden-hook --detect --fix` — wire this hook into whatever is installed.
 *
 * The detector answers "which of my tools is governed"; without this the
 * answer to "none of them" was a paragraph of instructions per tool, which is
 * three files an employee edits by hand on the day they are least equipped to
 * edit them. This does it, for the tools that can be done.
 *
 * Rules it does not break:
 *
 * - **It adds, never replaces.** Claude Code's settings are merged as JSON and
 *   every other hook in the file survives; Codex's TOML is appended to. A
 *   config that already mentions `warden-hook` is left completely alone, so
 *   running this twice is the same as running it once.
 * - **It backs up first.** `<file>.warden-bak` next to the original, before a
 *   byte is written. Somebody letting a tool edit their editor config should
 *   get the old one back with a `mv`.
 * - **It never claims to have done what it did not.** Every path prints what
 *   changed or why it could not, and a failure on one tool does not stop the
 *   others.
 *
 * Cursor is absent on purpose and always will be: there is no local wiring
 * that governs it. That is not a step this could take and forgot to.
 */

/** Copy a file to `<path>.warden-bak` before touching it. */
function backup(path) {
  try {
    if (existsSync(path)) copyFileSync(path, `${path}.warden-bak`);
    return true;
  } catch (err) {
    process.stderr.write(`   could not back up ${path}: ${err?.message ?? err}\n`);
    return false;
  }
}

/** This file, as it was actually invoked — the path the tools should call. */
function hookPath() {
  return process.argv[1] ?? join(homedir(), '.warden-hook.mjs');
}

function fixClaudeCode() {
  const file = join(homedir(), '.claude', 'settings.json');
  let settings = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      return `settings.json is not valid JSON (${err?.message ?? err}) — fix it, then run this again`;
    }
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    return 'settings.json is not an object, left alone';
  }

  const hooks = (settings.hooks ??= {});
  const list = Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : (hooks.UserPromptSubmit = []);
  if (JSON.stringify(list).includes('warden-hook')) return null;

  if (!backup(file)) return 'backup failed, so nothing was written';
  list.push({ hooks: [{ type: 'command', command: `node ${hookPath()}` }] });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return null;
}

function fixCodex() {
  const file = join(homedir(), '.codex', 'config.toml');
  const body = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (body.includes('warden-hook')) return null;

  if (!backup(file)) return 'backup failed, so nothing was written';
  const block = [
    '',
    '# Added by warden-hook --fix. Remove this block to stop routing prompts',
    '# through Warden; the file next to this one ending .warden-bak is what it',
    '# looked like before.',
    '[[hooks.UserPromptSubmit]]',
    '',
    '[[hooks.UserPromptSubmit.hooks]]',
    'type = "command"',
    `command = "node ${hookPath()}"`,
    ''
  ].join('\n');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body.endsWith('\n') || body === '' ? body + block : body + '\n' + block);
  return null;
}

/**
 * OpenCode needs a plugin file, and the plugin is fetched rather than embedded.
 *
 * A copy of it pasted in here would be a second source of that file, and the
 * two would disagree within a release — the same reason the hook itself is
 * served by the gateway instead of vendored into the install script.
 */
async function fixOpenCode() {
  const file = join(homedir(), '.config', 'opencode', 'plugin', 'warden.js');
  if (existsSync(file) ) return null;

  let source;
  try {
    const res = await fetch(`${WARDEN_URL}/integrations/opencode/warden.js`, {
      signal: AbortSignal.timeout(10_000)
    });
    if (!res.ok) throw new Error(`gateway answered ${res.status}`);
    source = await res.text();
  } catch (err) {
    return `could not fetch the plugin from ${WARDEN_URL} (${err?.message ?? err})`;
  }

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
  return null;
}

async function fixMode(agents) {
  process.stdout.write('\nWiring what can be wired\n\n');
  const fixers = { 'claude-code': fixClaudeCode, codex: fixCodex, opencode: fixOpenCode };

  for (const agent of agents) {
    const fix = fixers[agent.id];
    if (!agent.installed || !agent.governable || !fix) continue;
    if (agent.wired) {
      process.stdout.write(`  · ${agent.name.padEnd(12)} already wired, left alone\n`);
      continue;
    }
    let problem;
    try {
      problem = await fix();
    } catch (err) {
      problem = err?.message ?? String(err);
    }
    process.stdout.write(
      problem
        ? `  ✗ ${agent.name.padEnd(12)} ${problem}\n`
        : `  ✓ ${agent.name.padEnd(12)} wired, restart it to pick this up\n`
    );
  }

  const cursor = agents.find((a) => a.id === 'cursor');
  if (cursor?.installed) {
    process.stdout.write(`  — ${cursor.name.padEnd(12)} nothing to wire: ${cursor.how}\n`);
  }
  process.stdout.write('\n');
}

function detectMode() {
  const agents = detectAgents();
  const hookAt = [join(homedir(), '.warden-hook.mjs'), join(homedir(), '.config', 'warden', 'hook.mjs')]
    .find((path) => existsSync(path)) ?? null;

  if (process.argv.includes('--json')) {
    process.stdout.write(
      JSON.stringify(
        {
          hook: hookAt,
          gateway: WARDEN_URL,
          keySet: API_KEY.length > 0,
          agents
        },
        null,
        2
      ) + '\n'
    );
    return;
  }

  const lines = ['', 'Agents on this machine', ''];
  for (const agent of agents) {
    const mark = !agent.installed ? '·' : agent.wired ? '✓' : agent.governable ? '○' : '—';
    const state = !agent.installed
      ? 'not found'
      : agent.wired
        ? 'governed by Warden'
        : agent.governable
          ? `installed, NOT governed: ${agent.how}`
          : `installed, and cannot be governed on a subscription — ${agent.how}`;
    lines.push(`  ${mark} ${agent.name.padEnd(12)} ${state}`);
    if (agent.installed && agent.at) lines.push(`    ${' '.repeat(12)} ${agent.at}`);
  }

  lines.push('');
  lines.push(`  hook       ${hookAt ?? 'not found, so this file is not installed where the tools look for it'}`);
  lines.push(`  gateway    ${WARDEN_URL}`);
  // Whether a key is set, never the key. Printing it would put a credential in
  // whatever the employee pastes this output into.
  lines.push(`  key        ${API_KEY ? 'set' : 'NOT set, so every prompt will be refused by the gateway'}`);
  lines.push('');
  lines.push('  ✓ governed   ○ installed but not wired   — cannot be governed here   · not found');
  lines.push('');

  process.stdout.write(lines.join('\n'));
}

async function main() {
  const healthTimeoutMs = timeoutFromEnv('WARDEN_HEALTH_TIMEOUT_MS', DEFAULT_HEALTH_TIMEOUT_MS);
  const decisionTimeoutMs = timeoutFromEnv('WARDEN_TIMEOUT_MS', DEFAULT_DECISION_TIMEOUT_MS);

  // Run by a person, not by a tool, so it takes its input as a prompt on stdin
  // rather than a hook event — and it never blocks anything.
  // Takes no audit id and judges nothing: it reads this machine and prints.
  // `--fix` writes, and only to the three tools that have local wiring.
  if (process.argv.includes('--detect') || process.argv.includes('--fix')) {
    detectMode();
    if (process.argv.includes('--fix')) {
      await fixMode(detectAgents());
      // Re-read from disk so the closing inventory is what is actually there
      // now, not what this process believes it wrote.
      detectMode();
    }
    return;
  }

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

  // Read before the gateway call so a slow disk shows up in our own timing
  // rather than eating into the decision deadline.
  const usage = readUsage(payload, tool);

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
        body: JSON.stringify({ prompt, source: tool, usage })
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

  /**
   * Silence on the happy path. A gateway that comments on every prompt becomes
   * noise people learn to scroll past.
   *
   * The exception is a rule the admin set to `warn`: it fired, it did not stop
   * anything, and staying quiet about it would waste the one thing that makes
   * warning worth having over deleting the rule. Printed to stderr and exiting
   * zero, so the prompt goes through untouched — this is a note beside the
   * work, not a gate in front of it.
   */
  if (res.verdict === 'ALLOW') {
    const warnings = Array.isArray(res.warnings) ? res.warnings : [];
    if (warnings.length > 0) {
      const lines = ['', `⚠ Warden: allowed, with a note`, ''];
      for (const w of warnings.slice(0, 2)) {
        lines.push(...wrap(`Rule: "${w.ruleText ?? w.ruleId ?? 'unnamed rule'}"`));
        if (w.guidance) lines.push(...wrap(`If that applies here: ${w.guidance}`));
      }
      if (warnings.length > 2) lines.push(`   (${warnings.length - 2} more)`);
      lines.push('', `   Nothing was blocked. Audit ${res.auditId ?? '—'}`, '');
      process.stderr.write(lines.join('\n') + '\n');
    }
    return;
  }

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
