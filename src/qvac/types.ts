/**
 * The single boundary between Warden and @qvac/sdk.
 *
 * Everything downstream — policy compiler, guard passes, red-team runner —
 * talks to a `QvacAdapter` and never imports the SDK directly. That keeps the
 * whole codebase runnable against `MockQvacAdapter` on machines where local
 * inference is unavailable, and it makes the "where does inference happen"
 * question (the first thing the track's judges look at) answerable with one
 * directory: src/qvac/.
 */
import type { ZodType } from 'zod';

/**
 * Which loaded model a request should be routed to.
 *
 * `compiler` is the odd one out and is separate on purpose. Every other role is
 * guard-side work that sees employee traffic and must run on the machine;
 * `compiler` only ever sees a sentence an administrator typed, and produces a
 * draft that same administrator has to ratify before it binds anyone. That is
 * what makes it the one role a deployment may point at a model it does not own
 * — see `remote.ts`. Splitting it out of `adjudicator` is what turns "only the
 * compiler goes remote" into something the type system and one `if` can
 * enforce, rather than a convention.
 */
export type ModelRole =
  | 'detector'
  | 'adjudicator'
  | 'compiler'
  | 'assistant'
  | 'embedder'
  | 'ocr';

/** Per-call telemetry, sourced from the SDK's `final.stats`. Feeds BENCHMARKS.md. */
export type GenStats = {
  /** Wall-clock for the whole call, measured by us — always present. */
  ms: number;
  /** Time to first token, reported by the SDK. */
  ttftMs?: number;
  tps?: number;
  promptTokens?: number;
  genTokens?: number;
  backend?: 'gpu' | 'cpu';
};

export type CompleteRequest = {
  role: ModelRole;
  system: string;
  /** Untrusted content. Callers must pass this through `isolate()` first. */
  user: string;
  maxTokens?: number;
  temp?: number;
  seed?: number;
  /**
   * Stable KV-cache key. Passes that reuse a long constant prefix (one per
   * policy rule, say) set this so only the new message gets prefilled.
   */
  kvKey?: string;
  /** Abort the call after this many ms and fail closed. */
  timeoutMs?: number;
};

export type StructuredResult<T> = {
  value: T;
  /** 1 = grammar-constrained output validated first try; 2 = needed a repair pass. */
  attempts: 1 | 2;
  repaired: boolean;
  stats: GenStats;
};

/**
 * Raised when structured generation cannot produce a schema-valid result.
 *
 * Callers must treat this as ESCALATE, never as ALLOW — a guard that cannot
 * parse its own verdict has not cleared the request.
 */
export class FailClosedError extends Error {
  constructor(
    message: string,
    readonly detail: { role: ModelRole; attempts: number; lastRaw?: string }
  ) {
    super(message);
    this.name = 'FailClosedError';
  }
}

export interface QvacAdapter {
  complete(req: CompleteRequest): Promise<{ text: string; stats: GenStats }>;

  /**
   * Generate against a schema, two layers deep:
   * grammar-constrained decoding for syntax, then Zod for semantics.
   * Throws {@link FailClosedError} rather than returning a guess.
   *
   * @param jsonSchema Passed to the model as a decoding grammar.
   * @param zodSchema  Validates what comes back — catches the cases a grammar
   *                   cannot express (ranges, cross-field coherence).
   */
  completeJSON<T>(
    req: CompleteRequest,
    zodSchema: ZodType<T>,
    jsonSchema: Record<string, unknown>
  ): Promise<StructuredResult<T>>;

  embed(texts: string[]): Promise<number[][]>;

  ocr(imagePath: string): Promise<string>;

  /** Cumulative structured-output reliability counters, reported in REPORT.md. */
  stats(): { firstTry: number; repaired: number; failed: number };

  dispose(): Promise<void>;
}
