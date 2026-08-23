/**
 * The OpenAI-compatible front door.
 *
 * Tools that let you set a base URL — Cursor, Open WebUI, any script using the
 * OpenAI SDK — point here and get policy enforcement without a line of code
 * changing on their side. This is the secondary path; the hook (src/hook/cli.ts)
 * is what covers tools authenticated by subscription, where no base URL exists
 * to redirect.
 *
 * Identity arrives as an API key, because that is the one credential field
 * every client already has. Per-employee Warden keys also mean the company's
 * real upstream credential never leaves this machine: an employee cannot go
 * around the gateway, because they have nothing to go around it with.
 */
import type { Request, Response } from 'express';
import { evaluate } from '../guard/pipeline.js';
import { screenOutput, screensOutput } from '../guard/output.js';
import { normalizeUntrusted } from '../guard/isolate.js';
import { sanitize } from '../guard/sanitize.js';
import type { Actor, Decision } from '../guard/types.js';
import { actorForCredential } from '../policy/people.js';
import { loadPolicy, rulesForActor } from '../policy/store.js';
import { adapter } from '../qvac/index.js';

/** The local model that answers allowed prompts. Cloud is out by track rules. */
const UPSTREAM = process.env['WARDEN_UPSTREAM'] ?? 'http://localhost:11434';
const UPSTREAM_KEY = process.env['WARDEN_UPSTREAM_KEY'] ?? 'not-needed-locally';
const UPSTREAM_MODEL = process.env['WARDEN_UPSTREAM_MODEL'] ?? 'warden';

/**
 * `baseline` puts the rules in the model's system prompt and turns the guard
 * off — what a team ships without this project. The red-team harness runs both
 * modes over the same corpus, and the gap between them is the result we report.
 */
const MODE = process.env['WARDEN_MODE'] === 'baseline' ? 'baseline' : 'warden';

/**
 * Resolve the caller — the API key, and nothing else.
 *
 * There used to be a header fallback here for the web console's person
 * switcher. It is gone: two ways to say who you are means the weaker one is the
 * one that gets used, and the weaker one was a header any client could set. The
 * console now sends the selected person's key, which has the useful side effect
 * of exercising the same path an employee's tool does.
 */
function resolveActor(req: Request): Actor | null {
  const employee = actorForCredential(req.header('authorization'));
  return employee ? { id: employee.id, role: employee.role } : null;
}

/** Rules folded into a system prompt — the baseline everyone else ships. */
function baselineSystemPrompt(actor: Actor): string {
  // Every rule, both sides: this is a system prompt governing a whole
  // conversation, not one direction of it, and the baseline is what a team
  // ships when they have no gateway — they would paste all of them.
  const rules = rulesForActor(loadPolicy(), actor, 'any')
    .map((r) => `- ${r.text}`)
    .join('\n');
  return `You are a company assistant. Follow these rules at all times:\n${rules}`;
}

export async function handleChatCompletion(
  req: Request,
  res: Response,
  emit: (decision: unknown) => void
): Promise<void> {
  const actor = resolveActor(req);
  if (!actor) {
    res.status(401).json({
      error: { code: 'invalid_api_key', message: 'Unknown Warden API key. Ask your administrator for one.' }
    });
    return;
  }

  const body = req.body as {
    messages?: { role: string; content: string }[];
    stream?: boolean;
    model?: string;
  };
  const messages = body.messages ?? [];
  // Every user turn is judged, not just the last one. An OpenAI-compatible
  // client resends the whole history, so "put the payload in turn one and say
  // 'continue' in turn two" would otherwise walk straight past the guard while
  // the raw turn-one text still reached the model.
  const userTurns = messages.filter((m) => m.role === 'user' && typeof m.content === 'string');
  const prompt = userTurns.map((m) => m.content).join('\n\n');

  let outbound = messages;

  if (MODE === 'warden') {
    const decision: Decision = await evaluate(adapter(), { actor, prompt }, loadPolicy());
    emit(decision);

    if (decision.verdict === 'BLOCK') {
      const quotaHit = decision.quota && decision.quota.limit > 0 && decision.quota.used >= decision.quota.limit;
      res.status(quotaHit ? 429 : 403).json({
        error: {
          code: quotaHit ? 'quota_exceeded' : 'policy_block',
          message: decision.explanation,
          rule: decision.firedRules[0]?.ruleText,
          auditId: decision.auditId,
          ...(quotaHit ? { used: decision.quota?.used, limit: decision.quota?.limit } : {})
        }
      });
      return;
    }

    if (decision.verdict === 'ESCALATE') {
      res.status(202).json({
        escalationId: decision.auditId,
        message: decision.explanation,
        rule: decision.firedRules[0]?.ruleText
      });
      return;
    }

    // Only an explicit ALLOW is forwarded. Falling through on "not BLOCK and
    // not ESCALATE" would make any unexpected verdict value fail open, and the
    // one invariant of this design is that nothing fails in that direction.
    if (decision.verdict !== 'ALLOW') {
      res.status(202).json({ escalationId: decision.auditId, message: decision.explanation });
      return;
    }

    // Forward the masked text, never the original. A credential the employee
    // pasted must not reach the model just because the request was allowed —
    // and it can sit in any turn of the history, so each user turn is masked,
    // not only the newest.
    outbound = messages.map((m) =>
      m.role === 'user' && typeof m.content === 'string'
        ? { ...m, content: sanitize(normalizeUntrusted(m.content)).masked }
        : m
    );
  } else {
    outbound = [{ role: 'system', content: baselineSystemPrompt(actor) }, ...messages];
  }

  const payload = { ...body, messages: outbound, model: body.model ?? UPSTREAM_MODEL };

  /**
   * Screening the answer costs the stream, so it is bought only when the policy
   * asks for it.
   *
   * There is no version of this that streams. Tokens leave as they arrive, and
   * a rule that fires on the last sentence cannot recall the first — so an
   * answer that is going to be judged has to be complete before anyone reads
   * it. A policy with no output-scoped rules never pays that, and relays token
   * by token exactly as before.
   */
  if (MODE === 'warden' && screensOutput(loadPolicy(), actor)) {
    await forwardScreened(res, payload, actor, emit);
    return;
  }

  await forward(res, payload);
}

/**
 * Relay, but hold the answer until it has been judged.
 *
 * The upstream call is made non-streaming whatever the client asked for,
 * because a screened answer has to exist in full before it can be screened. A
 * client that wanted a stream still gets one — the approved answer is emitted
 * as a single chunk followed by `[DONE]`, which is a valid, if short, stream.
 */
async function forwardScreened(
  res: Response,
  payload: { messages: unknown[]; model: string; stream?: boolean },
  actor: Actor,
  emit: (decision: unknown) => void
): Promise<void> {
  const wantsStream = payload.stream === true;

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${UPSTREAM}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${UPSTREAM_KEY}` },
      body: JSON.stringify({ ...payload, stream: false })
    });
  } catch (err) {
    res.status(502).json({
      error: {
        code: 'upstream_unreachable',
        message:
          `Could not reach the model at ${UPSTREAM}. ` +
          `Start it with: npx @qvac/cli serve openai  (${err instanceof Error ? err.message : err})`
      }
    });
    return;
  }

  const raw = await upstream.text();
  if (!upstream.ok) {
    // Upstream's own error, passed through untouched. Judging it would be
    // judging a failure message as if the model had said it.
    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.setHeader('content-type', contentType);
    res.send(raw);
    return;
  }

  let answer: string;
  let parsed: { choices?: { message?: { content?: string } }[] };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
    answer = parsed.choices?.[0]?.message?.content ?? '';
  } catch {
    res.status(502).json({
      error: { code: 'upstream_unparseable', message: 'The model returned something this gateway could not read.' }
    });
    return;
  }

  const decision = await screenOutput(adapter(), { actor, text: answer, policy: loadPolicy() });
  emit(decision);

  // Same shape the input path refuses with, so a client handles one refusal
  // and gets both. ESCALATE holds it too: an answer nobody has cleared is not
  // an answer to show, and unlike a held prompt there is nothing lost by
  // waiting — the request is already paid for and the text already exists.
  if (decision.verdict !== 'ALLOW') {
    res.status(decision.verdict === 'BLOCK' ? 403 : 202).json({
      error: {
        code: decision.verdict === 'BLOCK' ? 'policy_block_output' : 'policy_escalate_output',
        message: decision.explanation,
        rule: decision.firedRules[0]?.ruleText,
        auditId: decision.auditId,
        side: 'output'
      }
    });
    return;
  }

  if (!wantsStream) {
    res.status(200).type('application/json').send(raw);
    return;
  }

  res.status(200).setHeader('content-type', 'text/event-stream');
  const chunk = {
    id: `chatcmpl-${decision.auditId}`,
    object: 'chat.completion.chunk',
    model: payload.model,
    choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: 'stop' }]
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * Relay to the upstream model, streaming straight through.
 *
 * Real clients stream, so buffering the whole response would make the gateway
 * feel broken even when it is working.
 */
async function forward(res: Response, payload: unknown): Promise<void> {
  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${UPSTREAM}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${UPSTREAM_KEY}` },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    res.status(502).json({
      error: {
        code: 'upstream_unreachable',
        message:
          `Could not reach the model at ${UPSTREAM}. ` +
          `Start it with: npx @qvac/cli serve openai  (${err instanceof Error ? err.message : err})`
      }
    });
    return;
  }

  res.status(upstream.status);
  const contentType = upstream.headers.get('content-type');
  if (contentType) res.setHeader('content-type', contentType);

  if (!upstream.body) {
    res.end();
    return;
  }

  // Headers are already out, so a mid-stream failure cannot become a status
  // code — but it must still end the response rather than park the client on a
  // connection nobody will ever close. And a client that walks away stops the
  // upstream read instead of draining it to nowhere.
  const reader = upstream.body.getReader();
  res.on('close', () => {
    void reader.cancel().catch(() => {});
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    res.end();
  }
}

export function proxyMode(): 'warden' | 'baseline' {
  return MODE;
}
