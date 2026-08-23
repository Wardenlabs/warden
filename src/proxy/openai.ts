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
  const rules = rulesForActor(loadPolicy(), actor)
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

  await forward(res, { ...body, messages: outbound, model: body.model ?? UPSTREAM_MODEL });
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
