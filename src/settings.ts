/**
 * Settings an administrator changes from the console rather than the shell.
 *
 * Today that is one thing: where rule compilation runs. It earns a persisted
 * file because the alternative is asking someone to restart the process with
 * four environment variables to try a better model at the one job where a
 * better model visibly helps — and the people who write policy are not the
 * people who restart processes.
 *
 * Deliberately not part of `PolicySpec`. The policy hash is what the guard
 * judges against and what the audit chain commits to; folding an operational
 * preference into it would change every rule's version because someone swapped
 * a compiler. These are two different kinds of state and they get two files.
 *
 * ## The key
 *
 * Stored in plaintext, like the employee API keys in the directory beside it,
 * and for the same reason: this repo has no secret store and inventing half of
 * one would be worse than being honest about it. `SECURITY.md` lists it. What
 * is done here is the part that costs nothing — the file is written 0600, it
 * lives in `data/` which is gitignored, and the key is never sent back to a
 * browser. Callers get `hasKey` and the last four characters.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const SETTINGS_PATH = process.env['WARDEN_SETTINGS_PATH'] ?? join('data', 'settings.json');

/**
 * The providers offered in the console, so nobody has to remember a base URL.
 *
 * Every one of them speaks the OpenAI `/chat/completions` shape, which is the
 * only thing `RemoteCompilerAdapter` requires — there is no provider-specific
 * code anywhere in this project and this list is a convenience, not a
 * capability. "Something else" exists because the list will be out of date.
 */
export const COMPILER_PROVIDERS = [
  { id: 'local', label: 'This machine', baseUrl: '', models: [], note: 'Nothing leaves the machine. The default.' },
  {
    id: 'claude-cli',
    label: 'Claude Code on this machine',
    baseUrl: '',
    models: ['opus', 'sonnet', 'haiku'],
    note: 'Uses the session you are already signed in to. No API key, no extra bill.'
  },
  {
    id: 'codex-cli',
    label: 'Codex on this machine',
    baseUrl: '',
    models: [],
    note: 'Same idea, through the codex CLI. Wired from its docs and NOT yet watched working.'
  },
  // The rest of the agent CLIs people actually have. Each is wired from its own
  // documented non-interactive flag and none has been watched work here, which
  // the note says. `detectCliTools()` greys out whatever is not installed, so a
  // long list costs nothing: you only ever see the ones on your machine as
  // available.
  {
    id: 'gemini-cli',
    label: 'Gemini CLI on this machine',
    baseUrl: '',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    note: 'Uses the gemini CLI you are signed in to. Wired from its docs and NOT yet watched working.'
  },
  {
    id: 'opencode-cli',
    label: 'opencode on this machine',
    baseUrl: '',
    models: [],
    note: 'The one Warden already hooks into. Wired from its docs and NOT yet watched working.'
  },
  {
    id: 'cursor-cli',
    label: 'Cursor on this machine',
    baseUrl: '',
    models: [],
    note: 'Needs the cursor-agent CLI, not just the editor. Wired from its docs and NOT yet watched working.'
  },
  {
    id: 'copilot-cli',
    label: 'GitHub Copilot on this machine',
    baseUrl: '',
    models: [],
    note: 'Uses the copilot CLI you are signed in to. Wired from its docs and NOT yet watched working.'
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
    note: 'console.anthropic.com → API keys'
  },
  {
    id: 'google',
    label: 'Google (Gemini)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
    note: 'aistudio.google.com → Get API key'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5', 'gpt-5-mini'],
    note: 'platform.openai.com → API keys'
  },
  {
    id: 'custom',
    label: 'Something else',
    baseUrl: '',
    models: [],
    note: 'Any endpoint that speaks OpenAI /chat/completions, including one on localhost.'
  }
] as const;

export const compilerSettingsSchema = z.object({
  provider: z.string().min(1).max(40),
  baseUrl: z.string().max(400),
  apiKey: z.string().max(400),
  model: z.string().max(120),
  redactNames: z.boolean()
});
export type CompilerSettings = z.infer<typeof compilerSettingsSchema>;

const LOCAL: CompilerSettings = {
  provider: 'local',
  baseUrl: '',
  apiKey: '',
  model: '',
  redactNames: false
};

export function loadCompilerSettings(): CompilerSettings {
  if (!existsSync(SETTINGS_PATH)) return { ...LOCAL };
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')) as { compiler?: unknown };
    const parsed = compilerSettingsSchema.safeParse(raw.compiler);
    return parsed.success ? parsed.data : { ...LOCAL };
  } catch {
    // A corrupt settings file must not stop the gateway, and the safe direction
    // is unambiguous: fall back to running compilation on this machine.
    return { ...LOCAL };
  }
}

export function saveCompilerSettings(next: CompilerSettings): CompilerSettings {
  const settings = compilerSettingsSchema.parse(next);
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  let existing: Record<string, unknown> = {};
  if (existsSync(SETTINGS_PATH)) {
    try {
      existing = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')) as Record<string, unknown>;
    } catch {
      existing = {};
    }
  }
  writeFileSync(SETTINGS_PATH, JSON.stringify({ ...existing, compiler: settings }, null, 2));
  // Best effort: on a filesystem without POSIX modes this throws and the file
  // is still written. Failing the save over it would be the wrong trade.
  try {
    chmodSync(SETTINGS_PATH, 0o600);
  } catch {
    /* not a POSIX filesystem */
  }
  return settings;
}

/** What a browser may see: everything except the key itself. */
export function redactedCompilerSettings(s: CompilerSettings): Omit<CompilerSettings, 'apiKey'> & {
  hasKey: boolean;
  keyHint: string;
} {
  const { apiKey, ...rest } = s;
  return {
    ...rest,
    hasKey: apiKey.length > 0,
    keyHint: apiKey.length > 4 ? `…${apiKey.slice(-4)}` : ''
  };
}
