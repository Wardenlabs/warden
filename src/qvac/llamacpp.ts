/**
 * A second runtime, so "is QVAC the problem" stops being an opinion.
 *
 * Warden's premise is that inference runs on-device through QVAC, and nothing
 * here argues with that. What this file does is make the premise falsifiable:
 * the same GGUF weights, the same prompts, the same bench cells, a different
 * engine underneath — and a paired comparison to say whether the answers change.
 *
 * The question is worth asking because a day of measurement produced three
 * findings that were about the runtime rather than the guard: the SDK loads no
 * model at all under pnpm on Linux without a platform package it does not pull
 * (`bare-runtime-linux-x64`); `parallel: 4` makes adjudication
 * non-deterministic at temperature 0, which is the noise that made eight
 * recorded attempts at the false-positive rate unmeasurable; and the OCR model
 * resolves only over the P2P registry, so `document-borne` has never actually
 * measured document understanding.
 *
 * It is also worth being clear about what QVAC does well, because that is what
 * a replacement has to match. Grammar-constrained decoding returned 380 valid
 * verdicts in a row — 0 repaired, 0 failed — which is why no guard pass has to
 * parse prose. `node-llama-cpp` supports GBNF grammars from a JSON schema, so
 * that property is preserved here rather than traded away; an adapter that gave
 * it up would be measuring a different pipeline and the comparison would mean
 * nothing.
 *
 * ## What this is not
 *
 * Not a recommendation, and not wired into anything by default. It exists to be
 * run against the same cells as the real adapter, exactly as every variant in
 * this repo is. If it wins, that is a measurement someone can act on; if it
 * does not, that is the more useful answer and it cost one file.
 *
 * ## Running it
 *
 *   pnpm add node-llama-cpp
 *   pnpm run bench -- --a base --rule r-instruction-override
 *   cp data/bench-last.json data/bench-qvac.json
 *   WARDEN_ADAPTER=llamacpp pnpm run bench -- \
 *     --a base --rule r-instruction-override --against data/bench-qvac.json
 *
 * The dependency is imported dynamically and is not in `package.json`, which is
 * the same treatment the pipeline gives its own optional modules. A repo whose
 * runtime is "express, zod and the QVAC SDK" does not acquire a second
 * inference engine because someone wanted to run an experiment.
 */
import type { ZodType } from 'zod';
import {
  FailClosedError,
  type CompleteRequest,
  type GenStats,
  type ModelRole,
  type QvacAdapter,
  type StructuredResult
} from './types.js';
import { resolvedModel } from './client.js';
import { modelsDir } from './models.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The slice of `node-llama-cpp` this file uses, declared here rather than
 * imported.
 *
 * `typeof import('node-llama-cpp')` would make `pnpm run typecheck` fail on
 * every machine that has not installed an optional dependency — including CI,
 * which runs it on every push. A structural type costs a few lines and keeps
 * the repo compiling for people who will never select this adapter, which is
 * almost everyone. It is checked against reality at runtime by failing loudly
 * if a method is missing, not by the compiler.
 */
type Grammar = unknown;
type Sequence = { dispose(): void };
type Llama = {
  loadModel(o: { modelPath: string }): Promise<LlamaModel>;
  createGrammarForJsonSchema(schema: unknown): Promise<Grammar>;
};
type LlamaModel = {
  createContext(o: { sequences: number }): Promise<LlamaContext>;
  createEmbeddingContext(): Promise<EmbeddingContext>;
  dispose(): Promise<void>;
};
type LlamaContext = {
  getSequence(): Sequence;
  readonly sequencesLeft: number;
  dispose(): Promise<void>;
};
type EmbeddingContext = {
  getEmbeddingFor(text: string): Promise<{ vector: number[] }>;
  dispose(): Promise<void>;
};
type ChatSession = {
  prompt(text: string, options: Record<string, unknown>): Promise<string>;
};
type LlamaModule = {
  getLlama(): Promise<Llama>;
  LlamaChatSession: new (o: { contextSequence: Sequence; systemPrompt: string }) => ChatSession;
};

let llamaModule: LlamaModule | null = null;

async function sdk(): Promise<LlamaModule> {
  if (llamaModule) return llamaModule;
  try {
    // Built from a variable so TypeScript does not try to resolve the module
    // at compile time on machines where it is not installed.
    const specifier = 'node-llama-cpp';
    llamaModule = (await import(specifier)) as LlamaModule;
    return llamaModule;
  } catch (err) {
    // Report what actually failed. This catch used to say "not installed" for
    // every import error, which was true the first time it fired and will not
    // always be: a missing native binary, an incompatible ABI or a broken
    // postinstall all arrive here too, and all three would have been debugged
    // as an installation that had already been done.
    const message = err instanceof Error ? err.message : String(err);
    const missing = /Cannot find package|ERR_MODULE_NOT_FOUND/.test(message);
    throw new FailClosedError(
      missing
        ? 'WARDEN_ADAPTER=llamacpp needs node-llama-cpp, which is not installed. ' +
          'Run `pnpm add node-llama-cpp`. It is deliberately not a dependency of this repo, ' +
          'so any `pnpm install` will prune it again.'
        : `WARDEN_ADAPTER=llamacpp could not load node-llama-cpp: ${message}`,
      { role: 'adjudicator', attempts: 0 }
    );
  }
}

/**
 * The same weights the QVAC path would load, resolved the same way.
 *
 * Deliberately reuses `resolvedModel`, so `WARDEN_MODEL_ADJUDICATOR` points
 * both runtimes at the same file. A comparison in which the two engines quietly
 * ran different weights would be worse than no comparison.
 */
function weightsFor(role: ModelRole): string {
  const name = resolvedModel(role);
  const path = resolve(modelsDir(), name);
  if (!existsSync(path)) {
    throw new FailClosedError(
      `no local weights for role "${role}" at ${path} — this adapter cannot fetch them, ` +
        'run `pnpm run setup` first',
      { role, attempts: 0 }
    );
  }
  return path;
}

type Loaded = { model: LlamaModel; context: LlamaContext };

export class LlamaCppAdapter implements QvacAdapter {
  #firstTry = 0;
  #repaired = 0;
  #failed = 0;
  #llama: Llama | null = null;
  readonly #loaded = new Map<ModelRole, Promise<Loaded>>();

  async #instance(): Promise<Llama> {
    this.#llama ??= await (await sdk()).getLlama();
    return this.#llama;
  }

  async #load(role: ModelRole): Promise<Loaded> {
    const cached = this.#loaded.get(role);
    if (cached) return cached;

    const loading = (async (): Promise<Loaded> => {
      // One llama instance for the process, as the SDK intends; one model and
      // one context per role, mirroring how `client.ts` keeps QVAC models.
      const llama = await this.#instance();
      const model = await llama.loadModel({ modelPath: weightsFor(role) });
      /**
       * A single sequence, not four.
       *
       * `client.ts` gives the adjudicator `parallel: 4`, and this project's own
       * log attributes its 44%-vs-31% pair to batch composition moving results
       * at temperature 0. Since half the point of this file is to find out
       * whether that noise is the engine's, running one sequence here would
       * confound the comparison — so it does, and the difference is stated
       * rather than hidden: this adapter is slower and deterministic by
       * construction.
       */
      const context = await model.createContext({ sequences: 1 });
      return { model, context };
    })();

    this.#loaded.set(role, loading);
    return loading;
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
    const first = await this.#run(req, jsonSchema);
    const parsed = this.#parse(first.text, zodSchema);
    if (parsed.ok) {
      this.#firstTry++;
      return { value: parsed.value, attempts: 1, repaired: false, stats: first.stats };
    }

    // One repair attempt, and the same reasoning as the QVAC adapter: a small
    // model that missed twice is confused about the task, not the format.
    const second = await this.#run(
      {
        ...req,
        user: [req.user, '', 'Your previous answer was rejected:', parsed.error, 'Answer again, correcting exactly that.'].join('\n')
      },
      jsonSchema
    );
    const retry = this.#parse(second.text, zodSchema);
    const stats: GenStats = { ...second.stats, ms: first.stats.ms + second.stats.ms };

    if (retry.ok) {
      this.#repaired++;
      return { value: retry.value, attempts: 2, repaired: true, stats };
    }

    this.#failed++;
    throw new FailClosedError(
      `structured output failed validation twice for role "${req.role}": ${retry.error}`,
      { role: req.role, attempts: 2, lastRaw: second.text.slice(0, 400) }
    );
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const llama = await this.#instance();
    const model = await llama.loadModel({ modelPath: weightsFor('embedder') });
    const context = await model.createEmbeddingContext();
    try {
      const out: number[][] = [];
      for (const text of texts) {
        const { vector } = await context.getEmbeddingFor(text);
        out.push([...vector]);
      }
      return out;
    } finally {
      await context.dispose();
    }
  }

  /**
   * Not supported, and it throws rather than returning nothing.
   *
   * `node-llama-cpp` has no OCR path, and an adapter that answered with an
   * empty string would hand the pipeline a document it had not read — which
   * `aggregate` would treat as read and clean. Throwing lands on the
   * unreadable-attachment branch, which escalates. Stricter, never quieter.
   */
  async ocr(_imagePath: string): Promise<string> {
    throw new FailClosedError(
      'the llamacpp adapter has no OCR backend — attachments cannot be read under it',
      { role: 'ocr', attempts: 0 }
    );
  }

  stats(): { firstTry: number; repaired: number; failed: number } {
    return { firstTry: this.#firstTry, repaired: this.#repaired, failed: this.#failed };
  }

  async dispose(): Promise<void> {
    for (const pending of this.#loaded.values()) {
      try {
        const { context, model } = await pending;
        await context.dispose();
        await model.dispose();
      } catch {
        // Already gone, or never finished loading. Nothing useful while exiting.
      }
    }
    this.#loaded.clear();
  }

  /** One generation, with the same deadline discipline as the QVAC adapter. */
  async #run(
    req: CompleteRequest,
    jsonSchema: Record<string, unknown> | undefined
  ): Promise<{ text: string; stats: GenStats }> {
    const started = Date.now();
    const { LlamaChatSession } = await sdk();
    const { context } = await this.#load(req.role);

    /**
     * The sequence is borrowed and given back, and the first version of this
     * file did not give it back.
     *
     * A context is created with a fixed number of sequences — one here, for the
     * determinism this adapter exists to test — and `getSequence()` takes one
     * out of that pool for as long as it lives. Leaking it meant the first
     * generation of the process succeeded and every later one failed for want
     * of a sequence, which the bench reported as `62/63 cells could not be
     * judged`: a whole runtime comparison that looked like llama.cpp answering
     * nothing, when it had answered the first cell in 17.7 s and then been
     * starved by its caller. Anything that acquires a sequence must release it,
     * and a `finally` is the only place that survives a thrown timeout.
     */
    if (context.sequencesLeft < 1) {
      throw new FailClosedError(
        `no free sequence for role "${req.role}" — a previous generation leaked one`,
        { role: req.role, attempts: 0 }
      );
    }
    const sequence = context.getSequence();
    try {
      const session = new LlamaChatSession({
        contextSequence: sequence,
        systemPrompt: req.system
      });

      // The grammar is what keeps this comparison honest. QVAC constrains
      // decoding to the JSON schema, so a verdict cannot be prose; giving that up
      // here would compare a guarded pipeline against an unguarded one.
      const grammar = jsonSchema
        ? await (await this.#instance()).createGrammarForJsonSchema(jsonSchema)
        : undefined;

      const text = await session.prompt(req.user, {
        ...(grammar ? { grammar } : {}),
        temperature: req.temp ?? 0,
        seed: req.seed ?? 42,
        maxTokens: req.maxTokens ?? 256,
        signal: AbortSignal.timeout(req.timeoutMs ?? 30_000)
      });

      return {
        text: typeof text === 'string' ? text : JSON.stringify(text),
        stats: { ms: Date.now() - started, backend: 'cpu' }
      };
    } finally {
      sequence.dispose();
    }
  }

  #parse<T>(text: string, schema: ZodType<T>): { ok: true; value: T } | { ok: false; error: string } {
    let json: unknown;
    try {
      const trimmed = text.trim();
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
}
