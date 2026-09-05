/**
 * Compile rules with the coding agent already signed in on this machine.
 *
 * The person setting Warden up almost certainly has Claude Code or Codex
 * installed and logged in — it is why they are looking at a tool that guards
 * coding agents. That session is a far better model than the 1.7B in `models/`,
 * it costs them nothing extra, and it needs no API key, no base URL and no
 * second bill. This file spends it on the one job where model quality is
 * visible and local weights are the bottleneck.
 *
 * ## Why this is safe to offer, stated plainly
 *
 * The same split `remote.ts` rests on, and the same role gate enforcing it:
 *
 * - **Judging** is the guard. It sees every employee prompt and stays on the
 *   local adapter under every configuration in this file. There is no flag and
 *   no code path here that hands a prompt under judgement to a subprocess.
 * - **Compiling** turns one sentence *the administrator typed* into a draft
 *   that the administrator then reads and ratifies. A model that cannot enact
 *   policy cannot be talked into enacting policy.
 *
 * What leaves the machine is what leaves it under `remote.ts`: the
 * administrator's own sentence, the role names, and the employee roster —
 * because `compileRule` injects the roster so "Ana cannot ask for payroll"
 * compiles into a rule about Ana. `WARDEN_COMPILER_REDACT_NAMES=1` reduces the
 * roster to tokens, at the accuracy cost of doing so. No employee prompt, no
 * audit entry, no policy hash and no API key is sent.
 *
 * The difference from `remote.ts` is who it goes to: not an endpoint the
 * administrator configured, but whichever provider that CLI is already signed
 * in to. That is a real distinction and the console says it out loud rather
 * than burying it — somebody choosing this is choosing to send those three
 * things to their own coding-agent subscription.
 *
 * ## Why it is worth it
 *
 * Measured on 2026-09-01, on the sentence "quiero que dejen de filtrar datos
 * de clientes":
 *
 * - `Qwen3-1.7B-Q4_0`, 32s: a `warn` rule against **filtering** customer data
 *   — the false friend — whose compliant example was "send customer data to a
 *   third-party for analysis". A draft that permits the leak it was asked to
 *   stop.
 * - `claude -p --model sonnet`, 12s: `block`, "Stop leaking customer data",
 *   with compliant examples about aggregates and redaction.
 *
 * Rule quality is upstream of everything the guard does, and that gap is the
 * difference between a policy somebody can ship and one they cannot.
 *
 * ## What it does to be a text transform and not an agent
 *
 * These CLIs are agents. Run carelessly they will read files and run commands,
 * which is not what a compile is. So every invocation: runs with its working
 * directory in the system temp folder, so there is no repository underneath it;
 * denies every tool it knows how to deny; takes its prompt on stdin rather than
 * argv, so nothing is length-capped or shell-quoted; and is killed on a
 * deadline. What comes back is treated as text from a stranger — parsed, and
 * schema-checked twice before anything is built from it.
 */
import { execFile } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
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
const CLI_ROLE: ModelRole = 'compiler';

/** Claude Code's "no customisations" flag. Dropped on a CLI that predates it. */
const SAFE_MODE = '--safe-mode';

export type CliTool = 'claude' | 'codex' | 'gemini' | 'opencode' | 'cursor-agent' | 'copilot';

export type CliCompilerConfig = {
  tool: CliTool;
  /** Model alias passed through to the CLI, when it takes one. */
  model: string;
  timeoutMs: number;
};

/**
 * Tools we know how to drive, and exactly how.
 *
 * The list is generous on purpose and honest about it, which only works
 * together. `detectCliTools()` runs `which` over these names, so a tool that is
 * not installed shows in the console as "not found" rather than as a promise —
 * nobody is offered something their machine cannot do. And `verified` says
 * whether the invocation below was actually run here and its output parsed:
 * only `claude` was. The other five are written from each CLI's documented
 * non-interactive flag and **have not been watched work here**, which the
 * console says beside them. This repo does not get to call something verified
 * because it looks right.
 *
 * The shape each one needs is the same and it is narrow: take a prompt on
 * stdin, print one answer to stdout, do not open a session, do not touch the
 * repository. Where a CLI has a way to say "and no tools", it is said. Where it
 * does not, `cwd: tmpdir()` is still underneath it — an agent with tools and no
 * repository can do considerably less than one with both.
 *
 * Adding another is this table plus a `COMPILER_PROVIDERS` entry, and nothing
 * else: the role gate lives in the adapter, not per tool, so a new row here
 * cannot widen what leaves the machine.
 */
const TOOLS: Record<CliTool, {
  label: string;
  verified: boolean;
  args: (model: string) => string[];
}> = {
  claude: {
    label: 'Claude Code',
    verified: true,
    args: (model) => [
      '-p',
      // Customisations off, authentication on. The administrator's own machine
      // runs Warden's UserPromptSubmit hook inside Claude Code, so without this
      // the compile prompt — a paragraph about prohibitions and overriding
      // instructions — went through the guard, the guard blocked it, and the
      // CLI's stdout was "Operation stopped by hook: Blocked by Warden" where
      // the JSON should have been. Two refusals of the administrator's own
      // sentence, by their own product, reported as "not valid JSON".
      //
      // 0.1.33 answered that with `--bare`, and it broke the feature outright:
      // `--bare` reads only ANTHROPIC_API_KEY and never the OAuth login or the
      // keychain, so on the machine this file exists for — Claude Code signed
      // in on a subscription, no API key anywhere — every compile came back
      // "Authentication error". `--safe-mode` is the flag that means what was
      // wanted: hooks, plugins, CLAUDE.md and MCP servers disabled, auth and
      // model selection untouched. Measured 2026-09-05 on 2.1.261: a project
      // hook that refuses everything stops `claude -p` with "operation blocked
      // by hook", and the same prompt under `--safe-mode` answers. A CLI too
      // old to know the flag says "unknown option"; `#run` drops it and tries
      // once more, with `WARDEN_INTERNAL` still telling the hook to stand
      // aside.
      SAFE_MODE,
      '--output-format', 'text',
      ...(model ? ['--model', model] : []),
      // A compile is a text transform. Nothing here needs to touch the disk,
      // the network, or a subagent, and the cheapest way to be sure is to say
      // so rather than to trust that it will not.
      '--disallowed-tools', 'Bash Edit Write Read Glob Grep WebFetch WebSearch Task NotebookEdit'
    ]
  },
  codex: {
    label: 'Codex',
    verified: false,
    args: (model) => ['exec', ...(model ? ['--model', model] : [])]
  },
  gemini: {
    label: 'Gemini CLI',
    verified: false,
    // `-p` is its non-interactive prompt flag; the prompt still arrives on
    // stdin, which is what keeps it off argv.
    args: (model) => ['-p', ...(model ? ['--model', model] : [])]
  },
  opencode: {
    label: 'opencode',
    verified: false,
    // The one already integrated on the hook side, so somebody governing
    // opencode with Warden very likely has it. `run` is its one-shot form.
    args: (model) => ['run', ...(model ? ['--model', model] : [])]
  },
  'cursor-agent': {
    label: 'Cursor',
    verified: false,
    // Cursor the editor has no headless mode; `cursor-agent` is the CLI that
    // does, and it is what this looks for. Somebody who only has the editor
    // sees "not found", which is the truthful answer rather than a broken one.
    args: (model) => ['-p', ...(model ? ['--model', model] : [])]
  },
  copilot: {
    label: 'GitHub Copilot CLI',
    verified: false,
    args: (model) => ['-p', ...(model ? ['--model', model] : [])]
  }
};

export function cliToolLabel(tool: CliTool): string {
  return TOOLS[tool].label;
}

export function cliToolVerified(tool: CliTool): boolean {
  return TOOLS[tool].verified;
}

/**
 * The configuration, or null when this is off.
 *
 * Environment first, then the console's saved settings — the same precedence
 * `remote.ts` uses, so there is one rule in the reader's head and not two.
 */
/**
 * The provider id the console saves, and the binary it means.
 *
 * One table rather than a chain of `if`s, because the chain was the thing that
 * had to be edited in three places to add a tool and was therefore the thing
 * that would be edited in two.
 */
const PROVIDER_TOOL: Record<string, CliTool> = {
  'claude-cli': 'claude',
  'codex-cli': 'codex',
  'gemini-cli': 'gemini',
  'opencode-cli': 'opencode',
  'cursor-cli': 'cursor-agent',
  'copilot-cli': 'copilot'
};

function toolFromEnv(): CliTool | null {
  const raw = process.env['WARDEN_COMPILER_CLI']?.trim();
  if (!raw) return null;
  return raw in TOOLS ? (raw as CliTool) : null;
}

export function cliCompilerConfig(): CliCompilerConfig | null {
  const fromEnv = toolFromEnv();
  if (fromEnv) {
    return {
      tool: fromEnv,
      model: process.env['WARDEN_COMPILER_MODEL']?.trim() ?? '',
      timeoutMs: Number(process.env['WARDEN_COMPILER_TIMEOUT_MS']) || 120_000
    };
  }

  const saved = loadCompilerSettings();
  const tool = PROVIDER_TOOL[saved.provider];
  return tool ? { tool, model: saved.model.trim(), timeoutMs: 120_000 } : null;
}

export function cliCompilerSource(): 'env' | 'settings' | null {
  if (toolFromEnv()) return 'env';
  return PROVIDER_TOOL[loadCompilerSettings().provider] ? 'settings' : null;
}

/**
 * The PATH to look for these CLIs on, which is not the one this process has.
 *
 * A GUI application on macOS is launched by `launchd`, not by a shell, so it
 * inherits `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else — none of the
 * places a coding agent actually installs to. The whole feature therefore
 * worked under `pnpm run dev`, where the terminal's PATH is inherited, and
 * silently did not exist in the packaged app, which is the only place a user
 * meets it. "Claude Code is not installed" on a machine running Claude Code is
 * the worst answer this could give.
 *
 * So the usual install locations are appended rather than substituted: the
 * inherited PATH still wins, and this only adds places to look. Appending is
 * also what keeps it safe — nothing here can shadow a binary the environment
 * already resolves, so a directory on this list cannot take over a name.
 */
function searchPath(): string {
  const home = homedir();
  const extra =
    process.platform === 'win32'
      ? [join(home, 'AppData', 'Local', 'Programs'), join(home, '.local', 'bin')]
      : [
          join(home, '.local', 'bin'),
          join(home, '.claude', 'local'),
          join(home, '.codex', 'bin'),
          join(home, 'bin'),
          '/opt/homebrew/bin',
          '/usr/local/bin'
        ];
  const sep = process.platform === 'win32' ? ';' : ':';
  const current = process.env['PATH'] ?? '';
  const seen = new Set(current.split(sep).filter(Boolean));
  return [current, ...extra.filter((d) => !seen.has(d))].filter(Boolean).join(sep);
}

/** `process.env` with that PATH, for anything that has to find one of these. */
function cliEnv(): NodeJS.ProcessEnv {
  // `WARDEN_INTERNAL` tells Warden's own hook, wherever a CLI runs it, that
  // this invocation is the gateway compiling a rule and not an employee
  // prompting — the hook exits clean on it. Claude Code also gets
  // `--safe-mode`, because the hook already installed on a machine may
  // predate the marker.
  return { ...process.env, PATH: searchPath(), WARDEN_INTERNAL: '1' };
}

/**
 * Which of these are actually on this machine.
 *
 * The console offers what is installed rather than a menu of things that will
 * fail on save. Resolved by asking the shell rather than guessing at install
 * paths, which differ per platform and per package manager.
 */
export async function detectCliTools(): Promise<{ tool: CliTool; label: string; verified: boolean; found: boolean }[]> {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return Promise.all(
    (Object.keys(TOOLS) as CliTool[]).map(
      (tool) =>
        new Promise<{ tool: CliTool; label: string; verified: boolean; found: boolean }>((resolve) => {
          execFile(probe, [tool], { timeout: 5_000, env: cliEnv() }, (err) =>
            resolve({ tool, label: TOOLS[tool].label, verified: TOOLS[tool].verified, found: !err })
          );
        })
    )
  );
}

/**
 * Local for everything, the signed-in CLI for compilation.
 *
 * A delegating wrapper rather than a branch inside each caller, so "can a guard
 * pass reach a subprocess" is answered by reading one `if` instead of auditing
 * every call site — the same shape as `RemoteCompilerAdapter`, for the same
 * reason.
 */
export class CliCompilerAdapter implements QvacAdapter {
  #calls = 0;
  /** Whether this CLI accepts `--safe-mode`. Assumed until it says otherwise. */
  #safeMode = true;

  constructor(
    private readonly local: QvacAdapter,
    private readonly config: CliCompilerConfig
  ) {}

  /** How many compiles actually went to the CLI. Reported by the console. */
  cliCalls(): number {
    return this.#calls;
  }

  describe(): string {
    const { tool, model } = this.config;
    return `${TOOLS[tool].label}${model ? ` (${model})` : ''} on this machine`;
  }

  async complete(req: CompleteRequest): Promise<{ text: string; stats: GenStats }> {
    if (req.role !== CLI_ROLE) return this.local.complete(req);
    return this.#run(req, undefined);
  }

  async completeJSON<T>(
    req: CompleteRequest,
    zodSchema: ZodType<T>,
    jsonSchema: Record<string, unknown>
  ): Promise<StructuredResult<T>> {
    if (req.role !== CLI_ROLE) return this.local.completeJSON(req, zodSchema, jsonSchema);

    const first = await this.#run(req, jsonSchema);
    const parsed = parseJson(first.text, zodSchema);
    if (parsed.ok) return { value: parsed.value, attempts: 1, repaired: false, stats: first.stats };

    // One repair, mirroring every other adapter here. A model that misses the
    // schema twice is confused about the task, not the format.
    const second = await this.#run(
      {
        ...req,
        user: [
          req.user,
          '',
          'Your previous answer was rejected:',
          parsed.error,
          'Answer again, correcting exactly that. Output the JSON object and nothing else.'
        ].join('\n')
      },
      jsonSchema
    );
    const retry = parseJson(second.text, zodSchema);
    const stats: GenStats = { ...second.stats, ms: first.stats.ms + second.stats.ms };
    if (retry.ok) return { value: retry.value, attempts: 2, repaired: true, stats };

    throw new FailClosedError(
      `${TOOLS[this.config.tool].label} returned schema-invalid output twice: ${retry.error}`,
      { role: req.role, attempts: 2, lastRaw: second.text.slice(0, 400) }
    );
  }

  // Guard-side work. Never routed to a subprocess, and there is deliberately
  // no configuration that would let it be.
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

  /** One run of the CLI, prompt on stdin, answer on stdout. */
  async #run(
    req: CompleteRequest,
    jsonSchema: Record<string, unknown> | undefined
  ): Promise<{ text: string; stats: GenStats }> {
    // Belt and braces. The public methods already route by role; this is the
    // line that has to be wrong for an employee prompt to reach a subprocess,
    // and it is cheap enough to keep even though it is unreachable today.
    if (req.role !== CLI_ROLE) {
      throw new FailClosedError(
        `refusing to send role "${req.role}" to a CLI — only "${CLI_ROLE}" may leave the guard`,
        { role: req.role, attempts: 0 }
      );
    }

    const spec = TOOLS[this.config.tool];
    const started = Date.now();
    this.#calls++;
    // A CLI old enough not to know `--safe-mode` refuses the whole command
    // line with "unknown option". That is not a failed compile, it is a flag
    // to drop: the run is repeated once without it, and the answer is
    // remembered so every later compile in this process skips the wasted
    // attempt. The hook marker in the environment still covers the case the
    // flag was for.
    let args = spec.args(this.config.model);
    if (!this.#safeMode) args = args.filter((a) => a !== SAFE_MODE);

    // System and user in one stream, because a CLI takes a prompt and not a
    // message list. The schema goes in as an instruction rather than as a
    // grammar — these tools have no structured-output mode to constrain
    // against, which is exactly why `completeJSON` above validates twice.
    const prompt = [
      req.system,
      '',
      jsonSchema
        ? [
            'Reply with ONE JSON object and nothing else. No prose, no explanation,',
            'no markdown fence. It must match this JSON Schema:',
            JSON.stringify(jsonSchema)
          ].join('\n')
        : '',
      '',
      req.user
    ]
      .filter(Boolean)
      .join('\n');

    const run = (argv: string[]): Promise<string> => new Promise<string>((resolve, reject) => {
      const child = execFile(
        this.config.tool,
        argv,
        {
          // No repository underneath it. Combined with the denied tools this
          // is two independent reasons the compile cannot touch a project.
          cwd: tmpdir(),
          timeout: this.config.timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          env: cliEnv()
        },
        (err, stdout, stderr) => {
          if (err) {
            const detail = String(stderr || err.message).trim().slice(0, 300);
            if (this.#safeMode && argv.includes(SAFE_MODE) && UNKNOWN_SAFE_MODE.test(detail)) {
              return reject(new UnknownSafeModeError());
            }
            return reject(
              new FailClosedError(
                `${spec.label} could not compile this rule: ${detail || 'no output'}`,
                { role: req.role, attempts: 1 }
              )
            );
          }
          const out = String(stdout);
          // A hook answered instead of the model. The text is not malformed
          // JSON, it is Warden refusing its own compile prompt through a hook
          // this process could not switch off, and the person needs to know
          // which hook to update rather than to "say it more plainly". The
          // wording is the CLI's and has moved: "Operation stopped by hook"
          // on the version that was first seen, "UserPromptSubmit operation
          // blocked by hook" on 2.1.261, with exit code 0 either way.
          if (HOOK_ANSWERED.test(out)) {
            return reject(
              new FailClosedError(
                `${spec.label} ran a prompt hook that blocked the compile. If it is Warden's own hook, update it: curl -fsSL <gateway>/warden-hook.mjs -o ~/.warden-hook.mjs`,
                { role: req.role, attempts: 1, lastRaw: out.slice(0, 200) }
              )
            );
          }
          resolve(out);
        }
      );
      // A CLI that refuses its command line exits before it reads a byte of
      // stdin, and writing the prompt into that closed pipe raises EPIPE on
      // the stream — as an 'error' event, which with nobody listening is an
      // uncaught exception that takes the gateway down. The exit callback
      // above already carries the real reason, so the pipe error is swallowed
      // here and the rejection comes from the exit, where it belongs.
      child.stdin?.on('error', () => {});
      child.stdin?.end(prompt);
    });

    let text: string;
    try {
      text = await run(args);
    } catch (err) {
      if (!(err instanceof UnknownSafeModeError)) throw err;
      this.#safeMode = false;
      text = await run(args.filter((a) => a !== SAFE_MODE));
    }

    const ms = Date.now() - started;
    return {
      text,
      // A CLI reports no token counts, and inventing them would put made-up
      // numbers into a trace the console renders as measurement. `backend` is
      // the local runtime's vocabulary — gpu or cpu — and neither is true of a
      // subprocess on somebody else's hardware, so it is left unset rather than
      // given a wrong answer.
      stats: { ms, ttftMs: 0, tps: 0, promptTokens: 0, genTokens: 0 }
    };
  }
}

/** The CLI refusing the command line because the flag postdates it. */
const UNKNOWN_SAFE_MODE = /unknown option '--safe-mode'/i;

/** A prompt hook, not the model, wrote stdout. Both wordings the CLI has used. */
const HOOK_ANSWERED = /^\s*(?:\w+\s+)?operation (?:stopped|blocked) by hook/i;

class UnknownSafeModeError extends Error {}

/**
 * Pull one JSON object out of whatever the CLI printed.
 *
 * These are agents talking to a person by default: the verified run came back
 * fenced in ```json, and a stray sentence before or after is well within what
 * they do. So the fence is stripped and, failing that, the outermost balanced
 * braces are taken. Anything still unparseable is a rejection with the reason,
 * which `completeJSON` feeds back for the one repair attempt.
 */
function parseJson<T>(raw: string, schema: ZodType<T>): { ok: true; value: T } | { ok: false; error: string } {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], braced(raw), raw].filter((c): c is string => Boolean(c && c.trim()));

  let lastError = 'no JSON object found in the output';
  for (const candidate of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(candidate.trim());
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }
    const parsed = schema.safeParse(value);
    if (parsed.success) return { ok: true, value: parsed.data };
    lastError = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  }
  return { ok: false, error: lastError };
}

/** The outermost {...} span, for output with a sentence wrapped around it. */
function braced(raw: string): string | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  return start !== -1 && end > start ? raw.slice(start, end + 1) : null;
}
