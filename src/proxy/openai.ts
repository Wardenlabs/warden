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
import type { Actor, Decision } from '../guard/types.js';
import { findByApiKey, findEmployee } from '../policy/people.js';
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
 * Resolve the caller.
 *
 * The bearer token is the primary signal because real clients send it. Headers
 * are a development convenience for the web console, which has a person
 * switcher and no keys to juggle.
 *
 * When the header names someone in the directory, the directory's role wins
 * over whatever role the header claims. The role is an admin decision, and a
 * client that could assert its own would be able to pick the rule set it is
 * judged against — which is the whole thing this gateway exists to prevent.
 */
function resolveActor(req: Request): Actor | null {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.header('authorization') ?? '')?.[1]?.trim();
  if (bearer) {
    const match = findByApiKey(bearer);
    return match ? { id: match.id, role: match.role } : null;
  }

  const headerUser = req.header('x-warden-user');
  if (headerUser) {
    const known = findEmployee(headerUser);
    if (known) return { id: known.id, role: known.role };
    return { id: headerUser, role: req.header('x-warden-role') ?? 'employee' };
  }

  return null;
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
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const prompt = lastUser?.content ?? '';

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

    // Forward the masked text, never the original. A credential the employee
    // pasted must not reach the model just because the request was allowed.
    if (lastUser && decision.maskedSpans.length > 0) {
      outbound = messages.map((m) => (m === lastUser ? { ...m, content: decision.maskedPrompt } : m));
    }
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

  const reader = upstream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

export function proxyMode(): 'warden' | 'baseline' {
  return MODE;
}
