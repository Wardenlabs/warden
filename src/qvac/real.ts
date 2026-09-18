/**
 * The real QVAC adapter — every model call in Warden goes through here.
 *
 * Structured output is defended twice. The SDK's `responseFormat: json_schema`
 * constrains decoding with a grammar, so the model *cannot* emit anything but
 * schema-shaped JSON. That handles syntax. It does not handle meaning: a
 * grammar cannot express "confidence is between 0 and 1" or "reason is
 * non-empty", and a syntactically perfect verdict can still be nonsense. Zod
 * catches that second class, one repair attempt tries to fix it, and anything
 * still broken throws rather than returning a guess.
 *
 * The counters are not incidental. "94% validate first try, 5% need a repair,
 * 1% fail closed" is the kind of measured claim the reliability track asks for,
 * and it comes straight out of this file.
 */
import { cancel, completion, embed, ocr } from '@qvac/sdk';
import type { ZodType } from 'zod';
import { modelFor, shutdown, withTemporaryModel } from './client.js';
import { isNativeGuard, nativeHistory, parseGuardAnswer, SHIELD_SYSTEM, graniteInstructions, type AnalyzerFormat } from './native-guards.js';
import type { ManagedRole } from '../models/store.js';
import { completeWithRepair } from './json.js';
import { withDeadline } from './deadline.js';
import {
  FailClosedError,
  throwIfCompletionCancelled,
  type CompleteRequest,
  type GenStats,
  type QvacAdapter,
  type StructuredResult
} from './types.js';

/** Small models drift and pad without a cap; verdicts are short by nature. */
const DEFAULT_MAX_TOKENS = 256;
/**
 * The ceiling for a call that names no deadline of its own.
 *
 * Overridable because it silently capped the pass-level one: a pass asking for
 * 180 seconds still died at 30, and the error read "generation did not end
 * within 30000ms" out of a run configured for three minutes.
 */
const DEFAULT_TIMEOUT_MS = Number(process.env['WARDEN_GENERATION_TIMEOUT_MS'] ?? 30_000);

/** How long after asking a generation to cancel we wait before giving up on it. */
const CANCEL_GRACE_MS = 5_000;

/**
 * Deadlines for the two SDK calls that are not generations.
 *
 * `completion()` had a hard stop and these did not, which is a distinction the
 * caller cannot see and an attacker can. Retrieval embeds the whole prompt, so
 * a long enough message parks the embedder — measured at 13 minutes on one
 * `volume-distraction` prompt, against a 14ms p50 for a normal one. The guard
 * request behind it waits, the hook hits its own 30s deadline, and it fails
 * open by design. That turns "send a very large prompt" into a bypass, which is
 * exactly what that corpus class is built to try.
 *
 * Both are generous — 700x the measured p50 for embedding — because the point
 * is to bound a hang, not to fail slow work. Loading the model is bounded
 * separately in `client.ts`, since it happens before either call.
 */
const EMBED_TIMEOUT_MS = 10_000;
const OCR_TIMEOUT_MS = 30_000;

/**
 * Fixed seed and zero temperature by default.
 *
 * Guard verdicts should not vary run to run, and the red-team numbers are only
 * defensible if a rerun reproduces them.
 */
const DEFAULT_SEED = 42;

/**
 * Loading is shared between requests, so cancelling one waiter must not cancel
 * the shared load. Its continuation is a factory: an abandoned waiter can never
 * launch a generation later, even if cold weights eventually finish loading.
 * Once native work starts, retain the caller's queue/role lease until it settles
 * or the cancellation grace expires. The SDK may finish with partial output or
 * even success after cancellation; neither is evidence that the call completed.
 *
 * The narrow injected boundary also lets the lifecycle be checked without a GPU.
 */
export async function runCancellableGeneration<T>(
  req: CompleteRequest,
  prepare: () => Promise<() => { requestId: string; result: Promise<T> }>,
  cancelRequest: (requestId: string) => Promise<unknown>,
  timeoutMs: number,
  cancelGraceMs = CANCEL_GRACE_MS
): Promise<T> {
  throwIfCompletionCancelled(req);
  const cancelled = () => new FailClosedError(`generation was cancelled for role "${req.role}"`, { role: req.role, attempts: 0 });
  let stopLoading: (() => void) | undefined;
  let start: () => { requestId: string; result: Promise<T> };
  try {
    const loading = prepare();
    if (req.signal) {
      const aborted = new Promise<never>((_, reject) => {
        stopLoading = () => reject(cancelled());
        req.signal!.addEventListener('abort', stopLoading, { once: true });
        if (req.signal!.aborted) stopLoading();
      });
      start = await Promise.race([loading, aborted]);
    } else start = await loading;
  } finally {
    if (stopLoading) req.signal!.removeEventListener('abort', stopLoading);
  }
  throwIfCompletionCancelled(req);
  const run = start();
  let stopped: FailClosedError | undefined;
  let grace: NodeJS.Timeout | undefined;
  let rejectHardStop!: (error: Error) => void;
  const hardStop = new Promise<never>((_, reject) => { rejectHardStop = reject; });
  const stop = (error: FailClosedError) => {
    if (stopped) return;
    stopped = error;
    clearTimeout(timeout);
    // Cancel only this request. Other roles may share the same loaded weights.
    try { void cancelRequest(run.requestId).catch(() => {}); } catch { /* Best effort; the hard stop still applies. */ }
    grace = setTimeout(() => rejectHardStop(error), cancelGraceMs);
  };
  const timeout = setTimeout(() => stop(new FailClosedError(
    `generation timed out after ${timeoutMs}ms for role "${req.role}"`, { role: req.role, attempts: 0 }
  )), timeoutMs);
  const onAbort = () => stop(cancelled());
  req.signal?.addEventListener('abort', onAbort, { once: true });
  if (req.signal?.aborted) onAbort();
  try {
    const value = await Promise.race([run.result, hardStop]);
    if (stopped) throw stopped;
    throwIfCompletionCancelled(req);
    return value;
  } catch (error) {
    throw stopped ?? error;
  } finally {
    clearTimeout(timeout);
    if (grace) clearTimeout(grace);
    req.signal?.removeEventListener('abort', onAbort);
  }
}

export class RealQvacAdapter implements QvacAdapter {
  #firstTry = 0;
  #repaired = 0;
  #failed = 0;

  /** A candidate is loaded and exercised without ever selecting it. This checks
   * engine compatibility and structured decoding, not policy accuracy. */
  async testLocal(path: string, role: ManagedRole, format: AnalyzerFormat): Promise<void> {
    if (isNativeGuard(format)) {
      if (role !== 'adjudicator') throw new Error('Native guard models are analyzer-only');
      await withTemporaryModel(role, path, async (id) => {
        const system = format === 'shieldstral' ? SHIELD_SYSTEM : graniteInstructions('The user requests private employee salaries.');
        const user = format === 'shieldstral' ? '<Instruct>: Judge only the document.\n\n<Query>: Does the user request private employee salaries?\n\n<Document>: Hello, how are you?' : 'Hello, how are you?';
        parseGuardAnswer(format, (await this.#run({ role, system, user, history: nativeHistory(format, system, user), maxTokens: 64, timeoutMs: 20_000 }, undefined, id)).text);
      });
      return;
    }
    const labels = role === 'compiler' ? ['ready'] : format === 'dynaguard' ? ['PASS', 'FAIL'] : ['COMPLIES', 'VIOLATES', 'UNCLEAR'];
    const schema = { type: 'object', properties: { verdict: { type: 'string', enum: labels } }, required: ['verdict'], additionalProperties: false };
    await withTemporaryModel(role, path, async (id) => {
      const result = await this.#run({ role, system: 'Return the requested JSON object.', user: `Return {"verdict":"${labels[0]}"}.`, maxTokens: 64, timeoutMs: 20_000 }, schema, id);
      let value: unknown;
      try { value = JSON.parse(result.text); } catch { throw new Error('The model did not return valid structured output'); }
      if (!value || typeof value !== 'object' || !labels.includes(String((value as { verdict?: unknown }).verdict))) throw new Error('The model did not return the required response format');
    });
  }

  async complete(req: CompleteRequest): Promise<{ text: string; stats: GenStats }> {
    const { text, stats } = await this.#run(req, undefined);
    return { text, stats };
  }

  async completeJSON<T>(
    req: CompleteRequest,
    zodSchema: ZodType<T>,
    jsonSchema: Record<string, unknown>
  ): Promise<StructuredResult<T>> {
    try {
      const result = await completeWithRepair((r) => this.#run(r, jsonSchema), req, zodSchema, 'structured output');
      if (result.repaired) this.#repaired++; else this.#firstTry++;
      return result;
    } catch (err) {
      if (err instanceof FailClosedError) this.#failed++;
      throw err;
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const modelId = await modelFor('embedder');
    const res = await withDeadline(embed({ modelId, text: texts }), EMBED_TIMEOUT_MS, 'embed');

    // The SDK returns a bare vector for one input and a matrix for many.
    const raw = res.embedding as number[] | number[][];
    const isMatrix = Array.isArray(raw[0]);
    return isMatrix ? (raw as number[][]) : [raw as number[]];
  }

  async ocr(imagePath: string): Promise<string> {
    const modelId = await modelFor('ocr');
    // `ocr()` returns synchronously with promises inside; the blocks arrive later.
    const { blocks } = ocr({ modelId, image: imagePath, options: { paragraph: true } });
    const read = await withDeadline(blocks, OCR_TIMEOUT_MS, 'ocr');
    return read.map((b) => b.text).join('\n');
  }

  stats(): { firstTry: number; repaired: number; failed: number } {
    return { firstTry: this.#firstTry, repaired: this.#repaired, failed: this.#failed };
  }

  async dispose(): Promise<void> {
    await shutdown();
  }

  /** One generation, with a hard timeout and stats collection. */
  async #run(
    req: CompleteRequest,
    jsonSchema: Record<string, unknown> | undefined,
    candidateModelId?: string
  ): Promise<{ text: string; stats: GenStats }> {
    return runCancellableGeneration(req, async () => {
      const modelId = candidateModelId ?? await modelFor(req.role);
      return () => {
        const started = Date.now();
        const run = completion({
          modelId,
          stream: true,
          history: req.history ?? [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user }
          ],
          generationParams: {
            temp: req.temp ?? 0,
            seed: req.seed ?? DEFAULT_SEED,
            predict: req.maxTokens ?? DEFAULT_MAX_TOKENS,
            // Qwen3 emits <think> blocks by default. In guard passes that is pure
            // latency spent on a closed yes/no question, so it is switched off
            // here and with a /no_think marker in the pass prompts.
            reasoning_budget: 0
          },
          ...(req.kvKey ? { kvCache: req.kvKey } : {}),
          ...(jsonSchema
            ? {
                responseFormat: {
                  type: 'json_schema' as const,
                  json_schema: { name: 'response', strict: true, schema: jsonSchema }
                }
              }
            : {})
        });

        const finalResult = run.final;
        void finalResult.catch(() => {});
        const consume = async () => {
          for await (const _event of run.events) {
            // Drained for its side effect; the aggregate arrives via `final`.
          }
          const final = await finalResult;
          return {
            text: final.contentText,
            stats: {
              ms: Date.now() - started,
              ...(final.stats?.timeToFirstToken !== undefined && { ttftMs: final.stats.timeToFirstToken }),
              ...(final.stats?.tokensPerSecond !== undefined && { tps: final.stats.tokensPerSecond }),
              ...(final.stats?.promptTokens !== undefined && { promptTokens: final.stats.promptTokens }),
              ...(final.stats?.generatedTokens !== undefined && { genTokens: final.stats.generatedTokens }),
              ...(final.stats?.backendDevice !== undefined && { backend: final.stats.backendDevice })
            }
          };
        };

        return { requestId: run.requestId, result: consume() };
      };
    }, (requestId) => cancel({ requestId }), req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

}
