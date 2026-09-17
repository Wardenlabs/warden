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
 * That writes ~/.warden/credentials.json (0600), which is where the key lives
 * and what every other copy of it is written from.
 *
 * Or by hand, in ~/.zshrc or ~/.bashrc:
 *   export WARDEN_URL=http://192.168.1.42:8080   # the gateway machine
 *   export WARDEN_API_KEY=wk-fede-8b1d40e2       # issued by your admin
 *
 * An exported value still wins over the file, so a second gateway is one
 * command away; `warden-hook --status` says when a copy has drifted from it.
 *
 * The key is the whole identity. There is no name to set and no role to set:
 * your admin decides what your key means and can change it without you touching
 * anything here — and a role you could set yourself would be a role you could
 * use to pick the rules that judge you. A key this gateway does not recognise is
 * refused outright, which is also how revoking one works.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `~/.warden/credentials.json` — where the key lives, and the one place it is
 * authoritative.
 *
 * Before this there were three copies and no original: the shell profile, the
 * `env` block of `~/.claude/settings.json`, and whatever was exported in the
 * terminal you happened to be in. Nothing said which was right, so when they
 * disagreed the terminal was judged as one person and the desktop app as
 * another — or the app was refused outright with a key the person could see
 * was correct in their shell, and no message anywhere connected the two.
 *
 * The copies do not go away, and cannot: a Claude Code opened from the Dock
 * never sourced a profile, and its `env` block is static JSON that cannot
 * point at a file. What changes is that they stop being originals. `--fix`
 * writes this file first and rewrites the copies from it, and `--status`
 * names any copy that has drifted instead of leaving somebody to find it by
 * being refused. See docs/specs/wiring-and-unwiring.md §7.
 */
const CREDENTIALS_PATH = join(homedir(), '.warden', 'credentials.json');

function readCredentials() {
  try {
    const raw = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    const url = typeof raw.url === 'string' ? raw.url : '';
    const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey : '';
    const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : '';
    return url || apiKey ? { url, apiKey, updatedAt } : null;
  } catch {
    // A missing file is the ordinary case on a machine set up before this
    // existed, and an unreadable one must not take the hook down with it:
    // either way the environment still answers, and that is the older path.
    return null;
  }
}

/**
 * Write the source of truth, `0600`, in a directory only its owner can enter.
 *
 * The mode is set at creation rather than after, so there is no instant where
 * the file exists and is world-readable. Returns what went wrong, or null.
 */
function writeCredentials({ url, apiKey }) {
  try {
    mkdirSync(dirname(CREDENTIALS_PATH), { recursive: true, mode: 0o700 });
    const body = JSON.stringify({ url, apiKey, updatedAt: new Date().toISOString() }, null, 2) + '\n';
    writeFileSync(CREDENTIALS_PATH, body, { mode: 0o600 });
    return null;
  } catch (err) {
    return err?.message ?? String(err);
  }
}

const CREDENTIALS = readCredentials();
/*
 * Environment first, so an override still works — somebody testing against a
 * second gateway sets the variable for one command and means it. Then the
 * file. `||` and not `??`: an empty string is somebody who unset it, not
 * somebody who chose "".
 */
const WARDEN_URL = process.env.WARDEN_URL || CREDENTIALS?.url || 'http://localhost:8080';
const API_KEY = process.env.WARDEN_API_KEY || CREDENTIALS?.apiKey || '';

/*
 * How long the hook waits for `/health` before treating the gateway as gone.
 *
 * This is a security parameter for the same reason the decision deadline is,
 * and a sharper one: the health call is where the hook learns the decision
 * deadline and whether the gateway fails closed, and a health call that times
 * out never reaches the decision at all. It was 2 s, which is generous for a
 * gateway on the LAN. Measured on 2026-09-06 against a Cloudflare quick
 * tunnel, three consecutive `/health` calls took 2.70 s, 2.16 s and 1.95 s,
 * so a laptop wired exactly as the onboarding sheet says failed open on every
 * prompt — "Warden unreachable, prompt allowed unchecked" in 2 s, with a
 * gateway that was up and answering. A hook that looks installed and never
 * judges is the worst shape SECURITY.md describes. 10 s costs nothing on the
 * happy path (the call returns when it returns) and is small against the 90 s
 * decision deadline it sits in front of.
 */
const DEFAULT_HEALTH_TIMEOUT_MS = 10_000;
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
// Extraction, queued analysis, cancellation grace and response delivery have
// separate budgets. An attachment must not inherit the shorter text deadline.
const DEFAULT_DOCUMENT_TIMEOUT_MS = 240_000;

/**
 * The other half of that deadline: what `--fix` writes into Claude Code's
 * hook entry, in seconds, so the harness does not kill the hook before Warden
 * has answered. Claude Code's own default for this event is 30 s.
 */
const CLAUDE_CODE_HOOK_TIMEOUT_S = 300;

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
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 24 * 1024 * 1024) throw new Error('The hook event exceeds the 24 MB input limit.');
    chunks.push(chunk);
  }
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
    contentText(payload.parts ?? payload.content ?? payload.prompt ?? payload.input);

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
  return messages.filter((m) => m?.role === 'user').map((m) => contentText(m.content)).join('\n\n') || undefined;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((p) => p?.type === 'text' || p?.type === 'input_text').map((p) => {
    if (typeof p.text !== 'string') throw new Error('A text content part is malformed.');
    return p.text;
  }).join('\n');
}

/**
 * Only explicit file references supplied by the calling integration are read.
 * A path mentioned in prose is not permission to crawl the employee's disk.
 * Files become bounded inline bytes on this machine: sending a local path to a
 * gateway on another computer would inspect the wrong file, or no file at all.
 * Keep this inside the standalone hook so employees still install one file.
 */
function documentAttachments(payload) {
  const entries = [];
  if (payload.attachments !== undefined) {
    if (!Array.isArray(payload.attachments)) throw new Error('Attachments must be a list.');
    entries.push(...payload.attachments);
  }
  const collections = [payload.parts, payload.content, payload.prompt, payload.input];
  if (Array.isArray(payload.messages)) {
    collections.push(...payload.messages.filter((m) => m?.role === 'user').map((m) => m.content));
  }
  for (const parts of collections) {
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part?.type === 'text' || part?.type === 'input_text') continue;
      if (part?.type === 'file' || part?.type === 'input_file') entries.push(part.file ?? part);
      else if (part?.type === 'image_url' || part?.type === 'input_image') {
        entries.push({ url: typeof part.image_url === 'string' ? part.image_url : part.image_url?.url, name: part.name });
      } else if ((part?.type === 'image' || part?.type === 'document') && part.source) {
        entries.push({ ...part.source, mimeType: part.source.media_type, name: part.title ?? part.name });
      } else throw new Error(`The content part "${String(part?.type ?? 'unknown').slice(0, 60)}" cannot be inspected.`);
    }
  }
  if (entries.length > 5) throw new Error('Send at most five attachments at a time.');
  let total = 0;
  return entries.map((entry, index) => {
    if (typeof entry === 'string') entry = { path: entry };
    if (!entry || typeof entry !== 'object') throw new Error('An attachment is malformed.');
    let name = entry.name ?? entry.filename;
    let mimeType = entry.mimeType ?? entry.mime_type ?? entry.mime ?? entry.media_type;
    let data = entry.data ?? entry.file_data;
    let filePath = entry.path;
    if (typeof entry.url === 'string') {
      if (entry.url.startsWith('file:')) filePath = fileURLToPath(entry.url);
      else if (entry.url.startsWith('data:')) data = entry.url;
      else throw new Error('Remote attachment URLs cannot be inspected. Attach the file itself.');
    }
    let bytes;
    if (typeof filePath === 'string') {
      const path = resolve(typeof payload.cwd === 'string' ? payload.cwd : process.cwd(), filePath);
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size < 1 || stat.size > 8 * 1024 * 1024) {
          throw new Error('Each attachment must be a regular file between 1 byte and 8 MB.');
        }
        const buffer = Buffer.alloc(stat.size + 1);
        let read = 0;
        while (read < buffer.length) {
          const count = readSync(fd, buffer, read, buffer.length - read, null);
          if (!count) break;
          read += count;
        }
        if (read !== stat.size || fstatSync(fd).mtimeMs !== stat.mtimeMs) {
          throw new Error('An attachment changed while being read. Send it again.');
        }
        bytes = buffer.subarray(0, read);
        name ??= basename(path);
      } finally {
        closeSync(fd);
      }
    } else {
      if (typeof data !== 'string') throw new Error('An attachment has no readable file bytes.');
      if (data.startsWith('data:')) {
        const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(data);
        if (!match) throw new Error('Attachment data URLs must contain base64 bytes.');
        mimeType = match[1];
        data = match[2];
      }
      if (data.length > Math.ceil(8 * 1024 * 1024 / 3) * 4 || data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(data)) {
        throw new Error('An attachment is too large or has invalid base64 bytes.');
      }
      bytes = Buffer.from(data, 'base64');
      if (bytes.toString('base64') !== data) throw new Error('An attachment has invalid base64 bytes.');
    }
    total += bytes.length;
    if (!bytes.length || bytes.length > 8 * 1024 * 1024 || total > 16 * 1024 * 1024) {
      throw new Error('Attachments must be nonempty, at most 8 MB each and 16 MB together.');
    }
    const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'application/pdf': 'pdf', 'text/plain': 'txt' })[mimeType];
    name ??= `attachment-${index + 1}${extension ? `.${extension}` : ''}`;
    if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('An attachment has an invalid filename.');
    return { name: basename(name), ...(mimeType ? { mimeType } : {}), data: bytes.toString('base64') };
  });
}

function refuseUninspected(message) {
  const reason = `Warden could not inspect this request. ${message}`;
  process.stderr.write(`${reason}\n`);
  process.stdout.write(JSON.stringify({ continue: false, stopReason: reason, decision: 'block', reason, systemMessage: reason }));
  process.exitCode = 2;
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

  const rule = res.firedRules?.[0];
  const t = STRINGS[refusalLanguage(rule)];
  const lines = [res.verdict === 'BLOCK' ? t.blocked : t.held];

  if (rule) {
    lines.push('');
    // The administrator's own sentence when they did not write in English; the
    // judge's English otherwise. One language per screen, whichever it is.
    lines.push(...wrap(rule.ruleTextLocal || rule.ruleText));

    if (rule.guidance) {
      lines.push('');
      lines.push(`   ${t.instead}`);
      lines.push(...wrap(rule.guidance));
    } else if (rule.reason) {
      lines.push(...wrap(rule.reason));
    }

    if (rule.allowedExamples?.length) {
      lines.push('');
      lines.push(`   ${t.wouldPass}`);
      for (const example of rule.allowedExamples) lines.push(`     · ${example}`);
    }

    const others = (res.firedRules?.length ?? 1) - 1;
    if (others > 0) {
      lines.push('');
      lines.push(`   ${t.others(others)}`);
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
        lines.push(`   ${t.tellReviewer}`);
        lines.push(`     warden-hook --note ${res.auditId}`);
      } else {
        lines.push(`   ${t.rewrite}`);
        lines.push(`     warden-hook --rewrite ${res.auditId}`);
        lines.push(`     ${t.pasteAgain}`);
        lines.push('');
        lines.push(`   ${t.wrong}`);
        lines.push(`     warden-hook --note ${res.auditId}`);
      }
    }
  } else if (res.explanation) {
    lines.push('');
    for (const part of String(res.explanation).split('\n')) lines.push(...wrap(part));
  }

  if (res.verdict === 'ESCALATE') {
    lines.push('');
    for (const line of t.queued) lines.push(`   ${line}`);
  }
  if (res.maskedSpans?.length) {
    lines.push('');
    lines.push(`   ${t.masked(res.maskedSpans.length)}`);
  }

  lines.push('');
  lines.push(`   ${t.audit(res.auditId)}`);
  return lines.join('\n');
}

/**
 * One language per refusal.
 *
 * The rule's text is English for the judge, and its guidance and examples are
 * in whatever language the administrator wrote — so a Spanish rule used to
 * arrive as an English sentence, Spanish advice and English scaffolding on
 * one screen. The scaffolding now follows the rule: the language is read off
 * the guidance, which is the part the administrator wrote for people. A rule
 * with no guidance and no local text is English, and so is everything else.
 */
function refusalLanguage(rule) {
  const sample = `${rule?.guidance ?? ''} ${rule?.ruleTextLocal ?? ''} ${(rule?.allowedExamples ?? []).join(' ')}`;
  if (!sample.trim()) return 'en';
  const spanish = (sample.match(/[áéíóúñ¿¡]|\b(el|la|los|las|de|del|que|para|con|una|un|no|es|si|pod[eé]s|necesit[aá]s)\b/gi) ?? []).length;
  const words = sample.split(/\s+/).length;
  return spanish / words > 0.08 ? 'es' : 'en';
}

const STRINGS = {
  en: {
    blocked: '⛔ Blocked by Warden',
    held: '⏸ Held for review by Warden',
    instead: 'What to do instead',
    wouldPass: 'These would go through',
    others: (n) => `${n} other rule${n > 1 ? 's' : ''} also matched.`,
    tellReviewer: 'The reviewer cannot see what you asked. Tell them why:',
    rewrite: 'Warden can try to rewrite this so it goes through:',
    pasteAgain: '(paste the same prompt, then Ctrl-D)',
    wrong: 'Think it was wrong? Say so:',
    queued: ['Waiting on an administrator. Not a refusal:', 'when they answer, ask again and it is judged on its own.'],
    masked: (n) => `Note: Warden masked ${n} secret(s) before checking.`,
    audit: (id) => `Audit ${id} · quote this if you think it is wrong`
  },
  es: {
    blocked: '⛔ Bloqueado por Warden',
    held: '⏸ Retenido para revisión por Warden',
    instead: 'Qué hacer en cambio',
    wouldPass: 'Esto sí pasaría',
    others: (n) => `${n} regla${n > 1 ? 's' : ''} más también coincidió.`,
    tellReviewer: 'Quien revisa no ve lo que pediste. Contale por qué:',
    rewrite: 'Warden puede intentar reescribirlo para que pase:',
    pasteAgain: '(pegá el mismo prompt y después Ctrl-D)',
    wrong: '¿Te parece que estuvo mal? Decilo:',
    queued: ['Esperando a un administrador. No es un rechazo:', 'cuando respondan, volvé a pedirlo y se juzga por sí mismo.'],
    masked: (n) => `Nota: Warden enmascaró ${n} secreto(s) antes de revisar.`,
    audit: (id) => `Auditoría ${id} · citá esto si te parece que estuvo mal`
  }
};

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
 * `--only <id>` — narrow `--fix` and `--unfix` to one tool.
 *
 * Both modes already take a list and dispatch by id; the CLI just never had a
 * way to hand them a shorter one. The console needs it: "This device" offers
 * Connect and Unwire per row, and wiring every tool because somebody pressed
 * one button is not what the button said.
 *
 * Returns the full list when the flag is absent, so every existing invocation
 * behaves exactly as before, and `null` for an id that is not a tool — which
 * the caller turns into a refusal. Falling back to "all of them" on a typo is
 * the expensive direction of that mistake: `--unfix --only clade-code` would
 * quietly unwire the machine.
 */
function onlyAgents() {
  const at = process.argv.indexOf('--only');
  if (at === -1) return detectAgents();
  const wanted = process.argv[at + 1];
  const chosen = detectAgents().filter((agent) => agent.id === wanted);
  return chosen.length ? chosen : null;
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

  // Claude Code kills a UserPromptSubmit command hook at 30 seconds unless the
  // entry says otherwise (it used to be 60), and a hook it kills is a prompt
  // that goes through unjudged: the output is discarded and the prompt reaches
  // the model. Warden's text deadline is 90 s, while documents have 240 s
  // for extraction and queued analysis, so an entry without a timeout is a
  // guard that silently stops guarding on exactly the machines where it is
  // slow. The shipped settings now allow 300 s; repair both the older 120 s
  // entry and entries that an earlier --fix wrote without any timeout.
  const ours = list.flatMap((entry) => entry?.hooks ?? []).find((h) => String(h?.command ?? '').includes('warden-hook'));
  const entryOk = Boolean(ours) && ours.timeout >= CLAUDE_CODE_HOOK_TIMEOUT_S;

  // Hooks inherit Claude Code's environment, and a Claude Code opened from
  // the desktop app or the Dock never sourced a shell profile. So the URL and
  // key the install script wrote to ~/.zshrc are invisible to the hook there:
  // with no URL it asks localhost:8080, finds nothing, and fails open, on a
  // laptop that looks wired. On 2026-09-06 that was the whole reason a
  // desktop app judged nothing until the same two values were put in the
  // `env` block of settings.json by hand, which is where Claude Code
  // documents that variables for hooks go. So what this process was handed
  // is written there too. It is the key in a second file, in the same home
  // directory, read by the same person; the alternative was a guard that
  // guarded the terminal and not the app.
  //
  // Since F6 the values written here are the resolved ones — the environment
  // if this shell has it, otherwise `~/.warden/credentials.json` — rather than
  // `process.env` alone. That is what makes this block a copy rather than a
  // fourth opinion: run `--fix` from a terminal that never sourced a profile
  // and it still writes the right key, because it reads the file.
  const env = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env : {};
  const wanted = {};
  for (const [name, value] of [['WARDEN_URL', WARDEN_URL], ['WARDEN_API_KEY', API_KEY]]) {
    if (value && env[name] !== value) wanted[name] = value;
  }
  if (entryOk && Object.keys(wanted).length === 0) return null;

  if (!backup(file)) return 'backup failed, so nothing was written';
  if (!entryOk) {
    if (ours) ours.timeout = CLAUDE_CODE_HOOK_TIMEOUT_S;
    else list.push({ hooks: [{ type: 'command', command: `node ${hookPath()}`, timeout: CLAUDE_CODE_HOOK_TIMEOUT_S }] });
  }
  settings.env = { ...env, ...wanted };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return ours ? REPAIRED : null;
}

/** A fixer's answer when the tool was wired already and it fixed the entry rather than adding one. */
const REPAIRED = Symbol('repaired');

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

  /*
   * The source of truth is written before anything derived from it.
   *
   * Only when this run actually has a key: `--fix` is also how somebody
   * repairs a timeout on a machine that is already set up, and running it from
   * a terminal with nothing exported must not blank the file every copy is
   * about to be rewritten from.
   */
  if (API_KEY) {
    const failed = writeCredentials({ url: WARDEN_URL, apiKey: API_KEY });
    if (failed) process.stdout.write(`  ✗ ${'credentials'.padEnd(12)} could not be written to ${CREDENTIALS_PATH} (${failed})\n`);
    else process.stdout.write(`  ✓ ${'credentials'.padEnd(12)} ${CREDENTIALS_PATH}, 0600 — the copies below are written from it\n`);
  }

  const fixers = { 'claude-code': fixClaudeCode, codex: fixCodex, opencode: fixOpenCode };

  for (const agent of agents) {
    const fix = fixers[agent.id];
    if (!agent.installed || !agent.governable || !fix) continue;
    // A wired tool is still run through its fixer, because an entry written
    // before the timeout existed is wired and wrong at once; the fixer says
    // which by returning REPAIRED, and leaves a correct entry untouched.
    let outcome;
    try {
      outcome = await fix();
    } catch (err) {
      outcome = err?.message ?? String(err);
    }
    const name = agent.name.padEnd(12);
    if (outcome === REPAIRED) {
      process.stdout.write(`  ✓ ${name} was wired but incomplete; timeout set to ${CLAUDE_CODE_HOOK_TIMEOUT_S} s and the gateway address and key put in its env, restart it to pick this up\n`);
    } else if (agent.wired) {
      process.stdout.write(`  · ${name} already wired, left alone\n`);
    } else if (outcome) {
      process.stdout.write(`  ✗ ${name} ${outcome}\n`);
    } else {
      process.stdout.write(`  ✓ ${name} wired, restart it to pick this up\n`);
    }
  }

  const cursor = agents.find((a) => a.id === 'cursor');
  if (cursor?.installed) {
    process.stdout.write(`  — ${cursor.name.padEnd(12)} nothing to wire: ${cursor.how}\n`);
  }
  process.stdout.write('\n');
}

/**
 * `warden-hook --unfix` — the counterpart `--fix` never had.
 *
 * Until this existed there was no supported way out. Somebody whose gateway had
 * stopped, or who was holding a key another installation had issued, had every
 * prompt refused by a hook they could not turn off, and the only remedy anybody
 * found was to hunt through `~/.claude/settings.json` by hand or uninstall
 * Warden entirely. A guard with no off switch does not get trusted with the
 * on switch; it gets removed. See `docs/prd/wiring-and-unwiring.md` §2.
 *
 * The rules it keeps, which are the reason this is careful rather than short:
 *
 * - **It removes only what Warden put there.** Other hooks, other events, other
 *   environment variables and other TOML sections survive untouched. Every
 *   unwiring is read-modify-write on the parsed file, never a rewrite from a
 *   template.
 * - **A file it cannot parse is a file it does not touch**, and it says so.
 *   The alternative — guessing at broken JSON — is how somebody loses a config
 *   they spent a year building.
 * - **It backs up first**, `<file>.warden-bak`, including before a delete.
 * - **Unwiring is not uninstalling.** `~/.warden-hook.mjs` stays, the shell
 *   profile stays, and the gateway's rules, people and audit log are not this
 *   command's business. `--unfix --purge` may exist later; it is out of scope
 *   in the spec that asked for this.
 *
 * Each unwirer returns `{ error }` when it declined, or `{ removed, kept, note }`
 * describing what it did — `removed` empty means there was nothing of ours.
 */
function unfixClaudeCode() {
  const file = join(homedir(), '.claude', 'settings.json');
  if (!existsSync(file)) return { removed: [], note: 'no settings.json here' };

  let settings;
  try {
    settings = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { error: `settings.json is not valid JSON (${err?.message ?? err}) — left untouched` };
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    return { error: 'settings.json is not an object — left untouched' };
  }

  const removed = [];
  const kept = [];
  const isOurs = (h) => String(h?.command ?? '').includes('warden-hook');

  const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks) ? settings.hooks : null;
  const list = hooks && Array.isArray(hooks.UserPromptSubmit) ? hooks.UserPromptSubmit : null;
  if (list) {
    const survivors = [];
    let ours = 0;
    let theirs = 0;
    for (const entry of list) {
      const inner = Array.isArray(entry?.hooks) ? entry.hooks : null;
      const mine = inner ? inner.filter(isOurs) : [];
      // An entry holding nothing of ours — including one whose shape this does
      // not recognise — is copied across exactly as it was found.
      if (mine.length === 0) { survivors.push(entry); theirs += inner ? inner.length : 1; continue; }
      ours += mine.length;
      const rest = inner.filter((h) => !isOurs(h));
      if (rest.length) { survivors.push({ ...entry, hooks: rest }); theirs += rest.length; }
    }
    if (ours) {
      removed.push(`${ours} UserPromptSubmit hook${ours === 1 ? '' : 's'}`);
      if (survivors.length) hooks.UserPromptSubmit = survivors;
      else delete hooks.UserPromptSubmit;
    }
    if (theirs) kept.push(`${theirs} UserPromptSubmit hook${theirs === 1 ? '' : 's'} that are not Warden's`);
  }
  if (hooks) {
    const otherEvents = Object.keys(hooks).filter((event) => event !== 'UserPromptSubmit');
    if (otherEvents.length) kept.push(`the ${otherEvents.join(', ')} hook${otherEvents.length === 1 ? '' : 's'}`);
    else if (Object.keys(hooks).length === 0) delete settings.hooks;
  }

  // The two variables `--fix` writes here because a Claude Code opened from the
  // Dock never sourced a shell profile. They come out the same way they went in.
  const env = settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env : null;
  if (env) {
    const mine = ['WARDEN_URL', 'WARDEN_API_KEY'].filter((name) => name in env);
    for (const name of mine) delete env[name];
    if (mine.length) removed.push(mine.join(' and '));
    const rest = Object.keys(env);
    if (rest.length) kept.push(`${rest.length} other environment variable${rest.length === 1 ? '' : 's'}`);
    else if (mine.length) delete settings.env;
  }

  if (removed.length === 0) return { removed: [], kept, note: "nothing of Warden's was in it" };
  if (!backup(file)) return { error: 'backup failed, so nothing was written' };
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return { removed, kept };
}

/**
 * Codex keeps its hooks in TOML, and this edits the text rather than parsing it.
 *
 * There is no TOML parser here and adding one for this would be a dependency in
 * the single file whose whole argument is that it has none. What makes text
 * surgery safe enough is that `--fix` writes a block it marks with a comment,
 * so this removes exactly the marked region and nothing else. A file that
 * mentions `warden-hook` without that marker was wired by hand or by a version
 * that did not mark it: this refuses to guess, leaves the file alone, and says
 * which lines to remove. Refusing is recoverable; a bad guess at somebody's
 * config is not.
 */
const CODEX_MARK = '# Added by warden-hook --fix';

function unfixCodex() {
  const file = join(homedir(), '.codex', 'config.toml');
  if (!existsSync(file)) return { removed: [], note: 'no config.toml here' };

  const body = readFileSync(file, 'utf8');
  if (!body.includes('warden-hook')) return { removed: [], note: "nothing of Warden's was in it" };

  const lines = body.split('\n');
  const start = lines.findIndex((line) => line.startsWith(CODEX_MARK));
  if (start === -1) {
    return { error: `it mentions warden-hook but not in a block this wrote, so it was left untouched — remove the [[hooks.UserPromptSubmit]] block naming warden-hook in ${file} by hand` };
  }

  // The block runs to the next section header after the inner `.hooks` table,
  // which is where whatever Codex configures next begins.
  let end = start + 1;
  let passedInner = false;
  while (end < lines.length) {
    const line = lines[end].trim();
    if (line.startsWith('[')) {
      if (passedInner) break;
      if (line.startsWith('[[hooks.UserPromptSubmit.hooks]]')) passedInner = true;
    }
    end++;
  }
  // Trailing blank lines belong to the block, not to what follows it.
  while (end > start && lines[end - 1].trim() === '') end--;

  const cut = lines.slice(start, end).join('\n');
  if (!cut.includes('warden-hook')) {
    return { error: `the marked block does not name warden-hook, which is not a shape this understands — ${file} was left untouched` };
  }

  if (!backup(file)) return { error: 'backup failed, so nothing was written' };
  const rest = [...lines.slice(0, start), ...lines.slice(end)];
  writeFileSync(file, rest.join('\n').replace(/\n{3,}$/, '\n'));
  const leftover = rest.join('\n').includes('warden-hook');
  return {
    removed: ['the UserPromptSubmit block'],
    kept: leftover ? ['another mention of warden-hook this did not write — check it by hand'] : []
  };
}

/**
 * OpenCode's plugin is a whole file, so unwiring is deleting it.
 *
 * "Only if it is the one Warden wrote" is checked against the file's content
 * and not against the copy the gateway serves today: a gateway upgraded since
 * the plugin was installed serves a newer one, and comparing the two would
 * refuse to remove a file this very tool had written. A file at the path Warden
 * chose that names Warden's own environment variable is Warden's. The backup
 * is what makes that judgement safe to be wrong about — the file is copied to
 * `.warden-bak` before it goes, so getting it back is a `mv`.
 */
function unfixOpenCode() {
  const file = join(homedir(), '.config', 'opencode', 'plugin', 'warden.js');
  if (!existsSync(file)) return { removed: [], note: 'no plugin file here' };

  let body;
  try {
    body = readFileSync(file, 'utf8');
  } catch (err) {
    return { error: `could not read ${file} (${err?.message ?? err}) — left in place` };
  }
  if (!body.includes('WARDEN_API_KEY') && !body.includes('warden-hook')) {
    return { error: `${file} does not look like the plugin Warden writes — left in place, remove it by hand if you want it gone` };
  }

  if (!backup(file)) return { error: 'backup failed, so nothing was deleted' };
  try {
    unlinkSync(file);
  } catch (err) {
    return { error: `could not delete ${file} (${err?.message ?? err})` };
  }
  return { removed: ['the plugin file'], kept: [] };
}

function unfixMode(agents) {
  process.stdout.write('\nUnwiring what Warden wired\n\n');
  const unfixers = { 'claude-code': unfixClaudeCode, codex: unfixCodex, opencode: unfixOpenCode };
  let touched = 0;

  for (const agent of agents) {
    const unfix = unfixers[agent.id];
    if (!unfix) continue;
    // Run whether or not the detector called it wired: the detector looks for
    // the hook entry, and the `env` block `--fix` also writes can outlive it.
    let outcome;
    try {
      outcome = unfix();
    } catch (err) {
      outcome = { error: err?.message ?? String(err) };
    }
    const name = agent.name.padEnd(12);
    if (outcome.error) {
      process.stdout.write(`  ✗ ${name} ${outcome.error}\n`);
    } else if (outcome.removed.length === 0) {
      process.stdout.write(`  · ${name} ${outcome.note ?? 'nothing to remove'}\n`);
    } else {
      touched++;
      process.stdout.write(`  ✓ ${name} removed ${outcome.removed.join(', ')}, restart it to pick this up\n`);
    }
    for (const left of outcome.kept ?? []) {
      process.stdout.write(`    ${' '.repeat(12)} left alone: ${left}\n`);
    }
  }

  // What this deliberately did not do, said out loud, because somebody running
  // it to stop being judged needs to know their key is still on this machine.
  process.stdout.write('\n  Still here, because unwiring is not uninstalling:\n');
  process.stdout.write(`    · this hook, at ${hookPath()}\n`);
  process.stdout.write('    · WARDEN_URL and WARDEN_API_KEY in your shell profile, if the install script put them there\n');
  if (CREDENTIALS) process.stdout.write(`    · your key, at ${CREDENTIALS_PATH} — delete that file to remove it from this machine\n`);
  process.stdout.write(`    · every backup, at <file>.warden-bak\n`);
  if (touched) process.stdout.write('\n  Run --fix to wire it back.\n');
  process.stdout.write('\n');
}

/**
 * `warden-hook --status` — the three questions nobody could ask.
 *
 * Asked in this order because each one only means something once the one before
 * it is answered. "My key is not recognised" is a different problem depending on
 * whether there is a gateway at all, and on *which* gateway answered — that is
 * the whole of `docs/prd/wiring-and-unwiring.md` §0, where a perfectly good key
 * was refused by a second Warden that happened to be holding port 8080.
 *
 * It writes nothing and judges nothing. Exit 0 only when all three are good, so
 * this can be the line in a setup script that decides whether to keep going.
 */
async function statusMode(timeoutMs) {
  const out = (line = '') => process.stdout.write(line + '\n');
  out('\nWarden on this machine');
  out();

  // 1 — Is there a gateway, and which one?
  out(`  gateway    ${WARDEN_URL}`);
  let health = null;
  let reason = '';
  try {
    health = await requestJson(`${WARDEN_URL}/health`, { method: 'GET' }, timeoutMs, validateHealth);
  } catch (err) {
    reason = err?.message ?? String(err);
  }
  if (health) {
    const where = health.installation;
    out(`             answering as "${where?.label ?? 'an installation that does not name itself'}"${where?.version ? ` (v${where.version})` : ''}`);
    // Present because this call came from the same machine. It is the line that
    // tells two installations apart when both answer to "localhost:8080".
    if (where?.dataDir) out(`             its people, keys and rules are in ${where.dataDir}`);
    if (health.mode === 'baseline') out('             ⚠ running in baseline mode: the guard is switched off');
  } else {
    out(`             ✗ no answer (${reason})`);
    // The fail-open, said out loud. It is the sentence SECURITY.md has always
    // carried and the one nobody reads until the morning it matters.
    const failClosed = readState()[WARDEN_URL]?.failClosed === true;
    out(failClosed
      ? '             this gateway was last seen set to fail closed, so prompts are being REFUSED'
      : '             while it is down, every prompt goes through UNCHECKED');
  }

  // 2 — Does it know me?
  out();
  out(`  key        ${API_KEY ? `set, ending ${API_KEY.slice(-4)}` : 'NOT set'}`);
  let identity = null;
  if (health && API_KEY) {
    try {
      identity = await requestJson(
        `${WARDEN_URL}/api/identity`,
        { method: 'GET', headers: { authorization: `Bearer ${API_KEY}` } },
        timeoutMs,
        (value) => {
          if (!value || typeof value !== 'object' || typeof value.id !== 'string') throw new Error('identity response is invalid');
          return value;
        }
      );
      out(`             recognised as ${identity.name} (${identity.id}), role "${identity.role}"`);
      // The one state in which everything else on this page says "fine" and
      // nothing is being checked. It has to be said here or --status becomes a
      // report that the wiring is perfect on a machine that is not guarded.
      if (identity.paused) {
        const until = identity.pausedUntil ? `until ${identity.pausedUntil}` : 'until somebody turns it back on';
        out(`             ⏸ Warden is PAUSED for you ${until}`);
        out('             prompts go through without being checked against any rule');
      }
    } catch (err) {
      out(`             ✗ this gateway does not recognise it (${err?.message ?? err})`);
      out(`             a key is only valid in the installation that issued it — claim one at ${WARDEN_URL} under Team → People`);
    }
  } else if (!API_KEY) {
    out('             every prompt will be refused until WARDEN_API_KEY is set');
  } else {
    out('             not checked, because the gateway did not answer');
  }

  // 3 — What is wired, and is it holding the same key?
  out();
  out('  tools');
  const agents = detectAgents();
  const governable = agents.filter((a) => a.installed && a.governable);
  for (const agent of agents) {
    const mark = !agent.installed ? '·' : agent.wired ? '✓' : agent.governable ? '○' : '—';
    const state = !agent.installed
      ? 'not found'
      : agent.wired
        ? 'wired'
        : agent.governable
          ? 'installed, NOT wired — run --fix'
          : 'installed, and cannot be wired here';
    out(`    ${mark} ${agent.name.padEnd(12)} ${state}`);
  }

  /*
   * The second key, and why it is checked here.
   *
   * `--fix` writes WARDEN_API_KEY into the `env` block of
   * ~/.claude/settings.json as well as the shell profile, because a Claude Code
   * opened from the Dock never sourced a profile. Two copies of a credential is
   * two things that can disagree, and when they do, the terminal is judged as
   * one person and the app as another — or the app is refused outright with a
   * key the person can see is correct in their shell. Nothing said so.
   *
   * Reconciling them is F6 of the spec. Noticing is this cheap and is most of
   * the value.
   */
  const drifted = keyCopies();
  const mismatched = drifted.length > 0;
  if (mismatched) {
    out();
    out('    ⚠ the copies of your key do not agree, so the same person is judged as two');
    for (const copy of drifted) out(`      ${copy.where} ends ${copy.value.slice(-4)}, ${copy.against} ends ${copy.expected.slice(-4)}`);
    out('      run --fix from a shell holding the key you want; it rewrites every copy from the file');
  } else if (!CREDENTIALS) {
    out();
    out(`    · no ${CREDENTIALS_PATH} yet — the key is only in your profile and in each tool`);
    out('      run --fix once to write it; after that the copies are derived from it');
  }

  const wiredAny = governable.some((a) => a.wired);
  // A pause is not a fault — somebody chose it, deliberately, and it has their
  // name on it. It is still not "good": this command exists so a script and a
  // person can both ask "is this machine guarded", and while it is paused the
  // answer is no. Its own line below says which of the two it is.
  const paused = identity?.paused === true;
  const good = Boolean(health) && Boolean(identity) && wiredAny && !mismatched && !paused;
  out();
  if (good) out('  ✓ a gateway, a key it knows, and at least one tool wired to it');
  else if (!health) out('  ✗ no gateway is answering, so nothing is being judged');
  else if (!identity) out('  ✗ the gateway is up but does not know this key');
  else if (!wiredAny) out('  ✗ nothing on this machine is wired — run --fix');
  else if (mismatched) out('  ✗ the wiring disagrees with itself about which key to use');
  else out('  ⏸ wired and connected, but paused — nothing is being checked until it is turned back on');
  out();
  process.exitCode = good ? 0 : 1;
}

/**
 * Every copy of the key that disagrees with the one it is a copy of.
 *
 * With a credentials file, that file is what each copy is measured against —
 * it is the original and the rest are derived from it. Without one, the
 * comparison is the older, weaker one this check started as: the shell against
 * Claude Code's `env` block, which at least catches the case that sent
 * somebody hunting for a bad key when the real problem was two good ones.
 *
 * Nothing here prints a whole key. The last four characters are enough to tell
 * two apart and not enough to use, and `--status` output ends up pasted into
 * chat threads by people asking for help.
 */
function keyCopies() {
  const claudeEnvKey = readClaudeEnvKey();
  const source = CREDENTIALS?.apiKey ?? '';
  const drifted = [];
  if (source) {
    const shellKey = process.env.WARDEN_API_KEY ?? '';
    if (shellKey && shellKey !== source) drifted.push({ where: 'this shell', value: shellKey, against: CREDENTIALS_PATH, expected: source });
    if (claudeEnvKey && claudeEnvKey !== source) drifted.push({ where: '~/.claude/settings.json', value: claudeEnvKey, against: CREDENTIALS_PATH, expected: source });
    return drifted;
  }
  if (claudeEnvKey && API_KEY && claudeEnvKey !== API_KEY) {
    drifted.push({ where: '~/.claude/settings.json', value: claudeEnvKey, against: 'this shell', expected: API_KEY });
  }
  return drifted;
}

/** The key `--fix` wrote into Claude Code's env block, or null if there is none. */
function readClaudeEnvKey() {
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'));
    const value = settings?.env?.WARDEN_API_KEY;
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
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

/**
 * A window with the refusal, for the desktop app.
 *
 * Claude Code inside the Claude desktop app runs this hook like the terminal
 * does and records the block the same way — its transcript carries the whole
 * refusal as a system warning with `preventContinuation`, beside a user
 * message marked `isMeta` — and then draws none of it: the person sees their
 * prompt vanish and a spinner. Observed on 2026-09-06 with `reason`,
 * `stopReason` and `systemMessage` all set to the refusal; the app rendered
 * nothing. Until it does, the one surface this hook can reach on that machine
 * is the operating system, so under the desktop app it opens a dialog with
 * the refusal: osascript on macOS, a WinForms message box through PowerShell
 * on Windows, zenity, kdialog or notify-send on Linux, whichever is there.
 * The app is recognisable by the `CLAUDE_CODE_ENTRYPOINT` it hands its hooks.
 *
 * Detached and never awaited. A dialog that waited for OK would hold this
 * process past Claude Code's own deadline, and a hook it cancels is a prompt
 * that goes through — the exact opposite of a block. Failing to open one is
 * silent: the block already happened and the exit code is the guarantee;
 * this is only the message.
 */
function showDesktopCard(text) {
  if (process.env.CLAUDE_CODE_ENTRYPOINT !== 'claude-desktop') return;
  const cmd = desktopCardCommand(text);
  if (!cmd) return;
  try {
    const child = spawn(cmd.file, cmd.args, { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...cmd.env } });
    child.unref();
  } catch {
    /* the block stands without it */
  }
}

/**
 * The one dialog each platform has without installing anything. macOS has
 * osascript; Windows has PowerShell and the WinForms message box; a Linux
 * desktop has zenity or kdialog depending on which one it grew up with, and
 * notify-send everywhere a notification daemon runs. The refusal is passed
 * as an argument or through the environment, never spliced into a script
 * string: it contains quotes, newlines and whatever the administrator wrote
 * in a rule, and this hook is running on the employee's own account.
 */
function desktopCardCommand(text) {
  if (process.platform === 'darwin') {
    return {
      file: 'osascript',
      args: [
        '-e', 'on run argv',
        '-e', 'display dialog (item 1 of argv) with title (item 2 of argv) buttons {"OK"} default button 1 with icon stop',
        '-e', 'end run',
        text,
        'Warden'
      ]
    };
  }
  if (process.platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: [
        '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
        'Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show($env:WARDEN_CARD_TEXT, "Warden", "OK", "Stop")'
      ],
      env: { WARDEN_CARD_TEXT: text }
    };
  }
  const found = (name) => (process.env.PATH ?? '').split(':').some((dir) => dir && existsSync(join(dir, name)));
  if (found('zenity')) return { file: 'zenity', args: ['--error', '--no-wrap', '--title=Warden', `--text=${text}`] };
  if (found('kdialog')) return { file: 'kdialog', args: ['--title', 'Warden', '--error', text] };
  if (found('notify-send')) return { file: 'notify-send', args: ['-u', 'critical', 'Warden', text] };
  return null;
}

/**
 * What this machine last learned from the gateway, remembered across runs.
 *
 * `failClosed` is stated by the gateway on `/health`, which is exactly the call
 * that fails when the gateway is down — so learning it only from a live
 * response means never knowing it at the one moment it decides anything. The
 * first version of this shipped with that hole: an administrator set
 * `WARDEN_FAIL_CLOSED=1`, the gateway went down, and every hook cheerfully
 * failed open because it had forgotten to ask while it still could.
 *
 * So it is remembered from the last successful contact and applied during the
 * next outage, which is how HSTS works and for the same reason. Keyed by
 * gateway URL, because pointing a machine at a different Warden must not
 * inherit the last one's policy.
 *
 * A machine that has never reached this gateway has nothing remembered and
 * fails open. That is the only answer available and it is worth being plain
 * about: this closes the door for a team that has been running, not for a
 * laptop being set up while the gateway is already down.
 *
 * Best effort in both directions — an unreadable or unwritable state file must
 * never stop a prompt, since the whole point is to not be the thing that
 * breaks somebody's morning.
 */
const STATE_PATH = join(homedir(), '.warden-hook.state.json');

function readState() {
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function rememberGateway(url, failClosed) {
  writeState((state) => {
    state[url] = { ...(state[url] ?? {}), failClosed: failClosed === true, at: new Date().toISOString() };
  });
}

/** Read, mutate, write. Best effort: a read-only home never stops a prompt. */
function writeState(mutate) {
  try {
    const state = readState();
    mutate(state);
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  } catch {
    /* a read-only home is not a reason to refuse a prompt */
  }
}

/**
 * Which machine this is, without telling the gateway which machine this is.
 *
 * The console has to be able to say "Ana has Warden on two laptops and one of
 * them stopped reporting in March", and that needs a stable key per machine.
 * The hostname is stable and is also personal data — `ana-macbook` is a name —
 * so what travels as the key is `sha256(hostname + salt)` cut to 16 hex, with
 * the salt generated once here and never sent. Nobody holding the id can walk
 * it back to a hostname, not even by guessing hostnames, because they do not
 * have the salt.
 *
 * The hostname itself travels too, as `name`, because an administrator looking
 * at a list of machines needs to know which one is which. The difference is
 * where each one is allowed to land: the name goes to the device inventory that
 * the console reads, and the id is what would go into the audit log if a
 * decision ever needed a machine attached to it. See `src/policy/devices.ts`.
 *
 * A home directory that cannot be written gets a fresh salt every run, so the
 * machine looks like a new one each time. That is a degraded inventory and not
 * a broken guard, which is the right way round.
 */
function machineIdentity() {
  const state = readState();
  let salt = typeof state['machineSalt'] === 'string' ? state['machineSalt'] : '';
  if (!/^[0-9a-f]{32}$/.test(salt)) {
    salt = randomBytes(16).toString('hex');
    writeState((next) => { next['machineSalt'] = salt; });
  }
  const name = hostname();
  return { id: createHash('sha256').update(`${salt}:${name}`).digest('hex').slice(0, 16), name };
}

/**
 * This file's own bytes, as its version.
 *
 * There is no version string in here and putting one in would be a number
 * somebody forgets to bump on the release where it mattered. What the console
 * actually needs to answer is "is this laptop running the hook this gateway
 * serves, or one from four releases ago" — and the gateway has the file it
 * serves, so comparing digests answers it exactly, for free, and cannot drift.
 */
function hookVersion() {
  try {
    return createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex').slice(0, 12);
  } catch {
    return undefined;
  }
}

/**
 * Tell the gateway what this machine found when it looked at itself.
 *
 * Wiring is the one fact the gateway can never check: it cannot read an
 * employee's home directory. So it is reported — after `--fix`, after
 * `--unfix`, and piggybacked on an ordinary check at most once an hour. Never
 * as a heartbeat. A background process that phones home on its own schedule is
 * a different product from a hook that runs when somebody presses Enter, and
 * the moment it exists somebody has to explain what it sends while they sleep.
 *
 * Failure is silent by design. This is inventory for a screen; it must never be
 * the reason a prompt is delayed or refused, and there is no version of "your
 * request was stopped because we could not update a dashboard" worth shipping.
 */
async function reportWiring(timeoutMs = 5_000) {
  if (!API_KEY) return;
  try {
    const machine = machineIdentity();
    const tools = detectAgents()
      .filter((agent) => agent.installed && agent.governable)
      .map((agent) => ({ id: agent.id, wired: agent.wired, how: agent.how }));
    await requestJson(
      `${WARDEN_URL}/api/devices/report`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ machine, tools, hookVersion: hookVersion() })
      },
      timeoutMs,
      (value) => value
    );
    writeState((state) => { state[WARDEN_URL] = { ...(state[WARDEN_URL] ?? {}), reportedAt: Date.now() }; });
  } catch {
    /* inventory is never a reason to be in somebody's way */
  }
}

/** An hour since the last report to this gateway, or never. */
function reportIsDue() {
  const last = readState()[WARDEN_URL]?.reportedAt;
  return !(typeof last === 'number' && Date.now() - last < 60 * 60 * 1000);
}

async function main() {
  // The gateway itself, compiling a rule through a CLI on this machine. That
  // CLI runs this hook like any other prompt, and judging the compiler's own
  // prompt refused it: it is a paragraph about prohibitions and overriding
  // instructions. Nothing to check here — the text came from the
  // administrator's console, not from a person typing at a tool — so it
  // passes, silently, and the compile gets its JSON back.
  if (process.env.WARDEN_INTERNAL === '1') return;

  const healthTimeoutMs = timeoutFromEnv('WARDEN_HEALTH_TIMEOUT_MS', DEFAULT_HEALTH_TIMEOUT_MS);
  let decisionTimeoutMs = timeoutFromEnv('WARDEN_TIMEOUT_MS', DEFAULT_DECISION_TIMEOUT_MS);
  // Whether an unreachable gateway refuses. Stated by the gateway on /health
  // and remembered here from the last time it answered, because the outage is
  // when it matters and the outage is when it cannot be asked.
  let failClosed = readState()[WARDEN_URL]?.failClosed === true;

  // Run by a person, not by a tool, so it takes its input as a prompt on stdin
  // rather than a hook event — and it never blocks anything.
  // Takes no audit id and judges nothing: it reads this machine and prints.
  // `--fix` writes, and only to the three tools that have local wiring.
  // Reads this machine and the gateway, writes nothing, and is the one mode
  // with a meaningful exit code — a setup script can branch on it.
  if (process.argv.includes('--status')) return statusMode(healthTimeoutMs);

  if (process.argv.includes('--fix') && process.argv.includes('--unfix')) {
    process.stderr.write('⚠ warden-hook: --fix and --unfix are opposites. Pick one.\n');
    process.exitCode = 1;
    return;
  }

  if (process.argv.includes('--detect') || process.argv.includes('--fix') || process.argv.includes('--unfix')) {
    const chosen = onlyAgents();
    if (chosen === null) {
      process.stderr.write(`⚠ warden-hook: --only needs one of ${AGENTS.map((a) => a.id).join(', ')}.\n`);
      process.exitCode = 1;
      return;
    }
    detectMode();
    if (process.argv.includes('--fix')) {
      await fixMode(chosen);
      // Re-read from disk so the closing inventory is what is actually there
      // now, not what this process believes it wrote.
      detectMode();
      // Wiring just changed, and this is the moment the console is most likely
      // to be open: somebody is watching to see whether it worked.
      await reportWiring();
    }
    if (process.argv.includes('--unfix')) {
      unfixMode(chosen);
      detectMode();
      // Especially here. Somebody unwiring and then vanishing from the console
      // is exactly the picture that has to say "not wired" rather than "went
      // quiet", and the gateway learns the difference only if it is told.
      await reportWiring();
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

  let raw;
  try { raw = await readStdin(); }
  catch (err) { clearTimeout(watchdog); return refuseUninspected(err?.message ?? 'The input could not be read.'); }
  clearTimeout(watchdog);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Not an event we recognise. Staying out of the way beats guessing.
    return;
  }

  let detected;
  let attachments;
  try {
    detected = detect(payload);
    attachments = documentAttachments(payload);
  } catch (err) {
    return refuseUninspected(err?.message ?? 'An attachment could not be read.');
  }
  const { tool, prompt } = detected;
  if (!prompt.trim() && !attachments.length) return;

  // Read before the gateway call so a slow disk shows up in our own timing
  // rather than eating into the decision deadline.
  const usage = readUsage(payload, tool);

  let res;
  try {
    const health = await requestJson(
      `${WARDEN_URL}/health`,
      { method: 'GET' },
      healthTimeoutMs,
      validateHealth
    );
    // The gateway's number beats this machine's. The deadline decides when the
    // hook stops checking and lets the prompt through, so leaving it to each
    // employee's shell profile put a security parameter in the hands of the
    // person it constrains — and the failure is silent in both directions: too
    // short and they stop being checked, too long and they wait without
    // knowing why. An administrator who raises it for a slower adjudicator now
    // reaches every laptop on its next prompt. `WARDEN_TIMEOUT_MS` still works
    // for a gateway too old to answer, and for debugging.
    const stated = health?.deadlines?.decisionMs;
    if (Number.isFinite(stated) && stated > 0) decisionTimeoutMs = stated;
    // Extraction (45 s), analysis (180 s), cancellation grace (5 s), and
    // response delivery need their own budget. A shorter ordinary deadline
    // must not cancel the request before its document decision can arrive.
    if (attachments.length) {
      const documentMs = health?.deadlines?.documentMs;
      decisionTimeoutMs = Math.max(decisionTimeoutMs, DEFAULT_DOCUMENT_TIMEOUT_MS,
        Number.isFinite(documentMs) && documentMs > 0 ? documentMs : 0);
    }
    // Read on the health call so it is known before the decision can fail. A
    // gateway that never answered leaves this false, which is the fail-open
    // default and the only answer available: refusing on the basis of a policy
    // nobody stated would brick a CLI over a typo'd URL.
    failClosed = health?.failClosed === true;
    rememberGateway(WARDEN_URL, failClosed);
    /*
     * The hourly wiring report, started here rather than after the decision.
     *
     * It overlaps a call that takes orders of magnitude longer — a small POST
     * against a 90-second adjudication — so the person waits for nothing, and
     * on the other fifty-nine minutes it does not run at all. After the
     * decision it would have been pure added latency on somebody's keystroke;
     * before the health call it would have run against a gateway not yet known
     * to be up.
     *
     * Not awaited, and it never rejects: inventory for a screen must not be
     * able to delay, refuse, or crash a prompt. Its own deadline bounds how
     * long it can keep the process alive after the verdict is delivered.
     */
    if (reportIsDue()) reportWiring();
    res = await requestJson(
      `${WARDEN_URL}/api/guard/check`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${API_KEY}`
        },
        // The machine travels with every check because that sighting is what
        // tells "this laptop has been quiet since March" from "this laptop has
        // never once connected", and it is the only thing that clears the mark
        // a key rotation leaves. It is an id and a hostname; nothing about it
        // reaches the audit log, which stores hashes.
        body: JSON.stringify({ prompt, source: tool, usage, machine: machineIdentity(), ...(attachments.length ? { attachments } : {}) })
      },
      decisionTimeoutMs,
      validateDecision,
      (http, value) => {
        if (![400, 401, 403, 413, 415, 422].includes(http.status)) return undefined;
        const body = value && typeof value === 'object' ? value : {};
        return {
          ...body,
          verdict: 'BLOCK',
          auditId: typeof body.auditId === 'string' && body.auditId ? body.auditId : 'no-key',
          error: typeof body.error === 'string' ? body.error : 'unknown_api_key',
          explanation:
            typeof body.explanation === 'string'
              ? body.explanation
              : [401, 403].includes(http.status) ? 'This gateway did not recognise your Warden API key.' : 'The gateway could not inspect this request. Check its size and file formats.'
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
    if (failClosed) {
      // The administrator asked for this gateway to be a gate rather than a
      // recommendation, so an unreachable one refuses. Same shape as any other
      // block: exit 2 with a reason the tool will show.
      const reason = [
        '🛡 Warden could not be reached, and this gateway is set to refuse when that happens.',
        '',
        `   ${WARDEN_URL} — ${err?.message ?? err}`,
        '',
        '   Nothing about your prompt was judged. Ask your administrator whether the',
        '   gateway is up; there is no way around this from here.'
      ].join('\n');
      process.stderr.write(`${reason}\n`);
      showDesktopCard(reason);
      process.stdout.write(
        JSON.stringify({ continue: false, stopReason: reason, decision: 'block', reason, systemMessage: reason })
      );
      process.exitCode = 2;
      return;
    }
    process.stderr.write(
      `⚠ Warden unreachable at ${WARDEN_URL} (${err?.message ?? err}). Prompt allowed unchecked.\n`
    );
    return;
  }

  // A prompt-submit hook cannot replace file bytes inside its caller. The
  // proxy can forward masked extractions, but here an original secret-bearing
  // attachment would still leave after an ALLOW. Ask for a cleaned file.
  if (res?.verdict === 'ALLOW' && attachments.length) {
    if (!Array.isArray(res.documents) || res.documents.length !== attachments.length || res.documents.some((d, i) =>
      d?.status !== 'read' || d.sha256 !== createHash('sha256').update(Buffer.from(attachments[i].data, 'base64')).digest('hex') ||
      !Number.isInteger(d.redactions) || d.redactions < 0
    )) {
      return refuseUninspected('The gateway did not confirm inspecting every attachment. Update Warden or send the document through its console.');
    }
    if (res.documents.some((d) => d.redactions > 0)) {
      return refuseUninspected('An attachment contains credentials. Remove them from the original file before sending it.');
    }
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
  showDesktopCard(message);

  /**
   * One object carrying every key a supported tool is documented to read, sent
   * whatever the tool. Branching per tool only created ways to send the wrong
   * shape — the `claude-code` branch omitted `decision` and `stopReason`, which
   * are what that tool actually stops on — while an extra key is inert to a
   * tool that ignores it. The non-zero exit below is still the part that must
   * always happen, because it is the one signal every caller understands.
   *
   * `systemMessage` is the refusal one more time, for the surfaces that show
   * nothing else. In the terminal, Claude Code prints `reason` (or stderr) when
   * it erases the prompt. The desktop app does not: the prompt vanished and
   * the person saw no rule, no guidance and no audit id, which is a block with
   * every reason to appeal it removed. Claude Code documents `systemMessage`
   * as the one field that reaches the person on every platform, so the same
   * text goes there too. A tool that does not know the key ignores it.
   */
  process.stdout.write(
    JSON.stringify({
      continue: false,
      stopReason: message,
      decision: 'block',
      reason: message,
      systemMessage: message
    }) + '\n'
  );

  process.exitCode = 2;
}

main().catch((err) => {
  // A crash in the hook must never take the employee's tool down with it.
  process.stderr.write(`⚠ warden-hook error: ${err?.message ?? err}\n`);
  process.exitCode = 0;
});
