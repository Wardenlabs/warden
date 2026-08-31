/**
 * The rule compiler, and only the rule compiler, on a model that is not local.
 *
 * Warden's premise is that employee prompts never leave the machine, and this
 * file does not weaken it. It separates two jobs that happen to have been
 * sharing a model:
 *
 * - **Judging** is the guard. It sees every employee prompt, and it stays local
 *   under every configuration this file can produce. There is no env var, no
 *   flag and no code path here that sends a prompt under judgement anywhere.
 * - **Compiling** turns one sentence an administrator typed into a draft rule.
 *   The administrator then reads that draft and ratifies it. A remote model
 *   cannot enact policy, because compilation does not enact policy — `compile.ts`
 *   says so in its own first paragraph, and that split is the reason this is
 *   safe to offer at all.
 *
 * The lever exists because rule quality is upstream of everything the guard
 * does. A 1.7B writing a rule's compliant examples is the difference between a
 * rule that blocks honest work and one that does not, and unlike adjudication —
 * which runs on every request and must be local — compilation runs once, when
 * an admin is sitting there waiting for it.
 *
 * ## What actually leaves the machine
 *
 * Say it plainly, because a privacy claim that is qualified in a comment
 * nobody reads is not a privacy claim:
 *
 * 1. The administrator's own sentence.
 * 2. The list of role names.
 * 3. **The employee roster** — id and display name for everyone in the
 *    directory — because `compileRule` injects it so that "Ana cannot ask for
 *    payroll" compiles into a rule about Ana rather than about the whole
 *    company.
 *
 * Point 3 is the one that matters, and it is why `WARDEN_COMPILER_REDACT_NAMES`
 * exists: with it set, the provider sees `@e-01` and never "Ana Pérez". That
 * costs accuracy exactly where the roster was earning it, so it is offered as a
 * choice rather than imposed as a default.
 *
 * No employee prompt, no audit entry, no policy hash and no API key is sent.
 *
 * ## Off unless configured
 *
 * Set `WARDEN_COMPILER_API` (an OpenAI-shaped `/chat/completions` base URL) and
 * `WARDEN_COMPILER_API_KEY`. Absent either, `adapter()` returns the local
 * adapter unwrapped and nothing about this file runs. That is the same
 * treatment every unmeasured lever in this repo gets.
 */
import type { ZodType } from 'zod';
import { loadCompilerSettings } from '../settings.js';
import {
  FailClosedError,
  type CompleteRequest,
  type GenStats,
  type ModelRole,
  type QvacAdapter,
  type StructuredResult
} from './types.js';

/** The one role this file will answer for. Everything else is the guard. */
const REMOTE_ROLE: ModelRole = 'compiler';

export type RemoteConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
};

/**
 * The configuration, or null when the feature is off.
 *
 * Two sources, environment first. A deployment that sets the variables has
 * said something more deliberate than a setting saved in a console, and the
 * same precedence as `WARDEN_MODEL_<ROLE>` keeps one rule in the reader's head
 * instead of two. The console reports which source won, so an administrator
 * whose saved settings are being overridden can see that rather than conclude
 * the page is broken.
 *
 * Both the URL and the key are required, from whichever source. A base URL with
 * no key would send the roster to an unauthenticated endpoint, and a key with
 * no URL is a typo that should not silently do nothing.
 */
export function remoteCompilerConfig(): RemoteConfig | null {
  const env = configFromEnv();
  const source = env ?? configFromSettings();
  if (!source) return null;
  return validate(source);
}

/** Where the active configuration came from, for the console to display. */
export function remoteCompilerSource(): 'env' | 'settings' | null {
  if (configFromEnv()) return 'env';
  return configFromSettings() ? 'settings' : null;
}

type Draft = { baseUrl: string; apiKey: string; model: string; timeoutMs: number };

function configFromEnv(): Draft | null {
  const baseUrl = process.env['WARDEN_COMPILER_API']?.trim();
  const apiKey = process.env['WARDEN_COMPILER_API_KEY']?.trim();
  if (!baseUrl || !apiKey) return null;
  return {
    baseUrl,
    apiKey,
    model: process.env['WARDEN_COMPILER_MODEL']?.trim() || 'claude-sonnet-5',
    timeoutMs: Number(process.env['WARDEN_COMPILER_TIMEOUT_MS']) || 60_000
  };
}

function configFromSettings(): Draft | null {
  const s = loadCompilerSettings();
  if (s.provider === 'local') return null;
  const baseUrl = s.baseUrl.trim();
  const apiKey = s.apiKey.trim();
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey, model: s.model.trim() || 'claude-sonnet-5', timeoutMs: 60_000 };
}

/**
 * The checks every source has to pass, so a setting saved from the console is
 * held to exactly the same bar as an environment variable.
 */
export function validate(draft: Draft): RemoteConfig {
  const { baseUrl, apiKey } = draft;

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`the compiler endpoint is not a URL: "${baseUrl}"`);
  }
  // http would put the roster on the wire in clear text. Loopback is exempt
  // because that is how someone points this at a model server on their own
  // machine, which is not remote at all.
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !loopback) {
    throw new Error(
      `the compiler endpoint must be https (got "${url.protocol}//") — the employee roster is sent to it`
    );
  }

  return { ...draft, baseUrl: baseUrl.replace(/\/+$/, '') };
}

/** True when the roster should be reduced to tokens before it is sent. */
export function redactNames(): boolean {
  if (process.env['WARDEN_COMPILER_REDACT_NAMES'] === '1') return true;
  return remoteCompilerSource() === 'settings' && loadCompilerSettings().redactNames;
}

/**
 * Local for everything, remote for compilation.
 *
 * A delegating wrapper rather than a branch inside each caller, so that "can a
 * guard pass reach the network" is answered by reading one `if` instead of
 * auditing every call site. The check is on the role, and the role of every
 * guard pass is fixed in code.
 */
export class RemoteCompilerAdapter implements QvacAdapter {
  #remoteCalls = 0;

  constructor(
    private readonly local: QvacAdapter,
    private readonly config: RemoteConfig
  ) {}

  /** How many generations actually went off the machine. Reported by the console. */
  remoteCalls(): number {
    return this.#remoteCalls;
  }

  describe(): string {
    return `${this.config.model} @ ${new URL(this.config.baseUrl).host}`;
  }

  async complete(req: CompleteRequest): Promise<{ text: string; stats: GenStats }> {
    if (req.role !== REMOTE_ROLE) return this.local.complete(req);
    const { text, stats } = await this.#call(req, undefined);
    return { text, stats };
  }

  async completeJSON<T>(
    req: CompleteRequest,
    zodSchema: ZodType<T>,
    jsonSchema: Record<string, unknown>
  ): Promise<StructuredResult<T>> {
    if (req.role !== REMOTE_ROLE) return this.local.completeJSON(req, zodSchema, jsonSchema);

    const first = await this.#call(req, jsonSchema);
    const parsed = parse(first.text, zodSchema);
    if (parsed.ok) return { value: parsed.value, attempts: 1, repaired: false, stats: first.stats };

    // One repair, mirroring the local adapters. A model that misses the schema
    // twice is confused about the task, not the format.
    const second = await this.#call(
      {
        ...req,
        user: [req.user, '', 'Your previous answer was rejected:', parsed.error, 'Answer again, correcting exactly that.'].join('\n')
      },
      jsonSchema
    );
    const retry = parse(second.text, zodSchema);
    const stats: GenStats = { ...second.stats, ms: first.stats.ms + second.stats.ms };
    if (retry.ok) return { value: retry.value, attempts: 2, repaired: true, stats };

    throw new FailClosedError(
      `remote compiler returned schema-invalid output twice: ${retry.error}`,
      { role: req.role, attempts: 2, lastRaw: second.text.slice(0, 400) }
    );
  }

  // Embedding and OCR are guard-side work. They are never routed off-machine,
  // and there is deliberately no configuration that would let them be.
  embed(texts: string[]): Promise<number[][]> {
    return this.local.embed(texts);
  }

  ocr(imagePath: string): Promise<string> {
    return this.local.ocr(imagePath);
  }

  stats(): { firstTry: number; repaired: number; failed: number } {
    return this.local.stats();
  }

  dispose(): Promise<void> {
    return this.local.dispose();
  }

  /** One OpenAI-shaped chat completion. No SDK — `fetch` is in the runtime. */
  async #call(
    req: CompleteRequest,
    jsonSchema: Record<string, unknown> | undefined
  ): Promise<{ text: string; stats: GenStats }> {
    // Belt and braces. The public methods already route by role; this is the
    // line that has to be wrong for an employee prompt to reach the network,
    // and it is cheap enough to keep even though it is unreachable today.
    if (req.role !== REMOTE_ROLE) {
      throw new FailClosedError(
        `refusing to send role "${req.role}" to a remote model — only "${REMOTE_ROLE}" may leave the machine`,
        { role: req.role, attempts: 0 }
      );
    }

    const started = Date.now();
    this.#remoteCalls++;

    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user }
          ],
          temperature: req.temp ?? 0,
          max_tokens: req.maxTokens ?? 640,
          ...(jsonSchema
            ? {
                response_format: {
                  type: 'json_schema',
                  json_schema: { name: 'rule_draft', strict: false, schema: jsonSchema }
                }
              }
            : {})
        }),
        signal: AbortSignal.timeout(req.timeoutMs ?? this.config.timeoutMs)
      });
    } catch (err) {
      // Network failure during compilation is a failed draft, never a rule.
      // Nothing downstream can interpret this as policy.
      throw new FailClosedError(
        `remote compiler unreachable at ${this.config.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
        { role: req.role, attempts: 0 }
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new FailClosedError(
        `remote compiler returned ${res.status}: ${body.slice(0, 300)}`,
        { role: req.role, attempts: 0 }
      );
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = json.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      throw new FailClosedError('remote compiler returned no message content', {
        role: req.role,
        attempts: 0
      });
    }

    return {
      text,
      stats: {
        ms: Date.now() - started,
        promptTokens: json.usage?.prompt_tokens,
        genTokens: json.usage?.completion_tokens
      }
    };
  }
}

function parse<T>(text: string, schema: ZodType<T>): { ok: true; value: T } | { ok: false; error: string } {
  let json: unknown;
  try {
    const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    json = JSON.parse(start !== -1 && end > start ? trimmed.slice(start, end + 1) : trimmed);
  } catch (err) {
    return { ok: false, error: `not valid JSON: ${err instanceof Error ? err.message : err}` };
  }
  const result = schema.safeParse(json);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    error: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
  };
}
