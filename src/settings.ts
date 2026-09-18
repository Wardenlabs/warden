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
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicJSON } from './models/store.js';
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
  { id: 'local', label: 'This machine', baseUrl: '', models: [], note: 'Compile with local weights. Nothing leaves the machine.' },
  {
    id: 'claude-cli',
    label: 'Claude Code on this machine',
    baseUrl: '',
    models: ['opus', 'sonnet', 'haiku'],
    note: 'Recommended for new installations. Uses Claude Code’s configured account and model; its usage limits and billing apply.'
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
  redactNames: z.boolean(),
  modelId: z.string().uuid().optional()
});
export type CompilerSettings = z.infer<typeof compilerSettingsSchema>;

const LOCAL: CompilerSettings = {
  provider: 'local',
  baseUrl: '',
  apiKey: '',
  model: '',
  redactNames: false
};

const DEFAULT_COMPILER: CompilerSettings = { ...LOCAL, provider: 'claude-cli' };

/** Absence is first-run setup; unreadable prior state is never permission to
 * start sending compilation to a newly chosen external provider. */
function compilerConfigurationState(settingsPath = SETTINGS_PATH): 'missing' | 'configured' | 'invalid' {
  if (!existsSync(settingsPath)) return 'missing';
  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
    if (!Object.hasOwn(raw, 'compiler')) return 'missing';
    return compilerSettingsSchema.safeParse(raw.compiler).success ? 'configured' : 'invalid';
  } catch { return 'invalid'; }
}

export function compilerSettingsConfigured(settingsPath = SETTINGS_PATH): boolean { return compilerConfigurationState(settingsPath) === 'configured'; }

/** An explicit shell configuration is already an administrator's choice. The
 * mock demo is not authorized to execute an implicit external compiler. */
export function compilerSetupRequired(): boolean {
  if (process.env['WARDEN_ADAPTER'] === 'mock') return false;
  if (process.env['WARDEN_COMPILER_CLI']?.trim() || process.env['WARDEN_COMPILER_API']?.trim() || process.env['WARDEN_MODEL_COMPILER']?.trim()) return false;
  return compilerConfigurationState() === 'missing';
}

export function loadCompilerSettings(settingsPath = SETTINGS_PATH): CompilerSettings {
  if (!existsSync(settingsPath)) return { ...DEFAULT_COMPILER };
  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf8')) as { compiler?: unknown };
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && !Object.hasOwn(raw, 'compiler')) return { ...DEFAULT_COMPILER };
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
      throw new Error('The saved settings file is unreadable. Restore it before changing settings.');
    }
  }
  atomicJSON(SETTINGS_PATH, { ...existing, compiler: settings });
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

/**
 * Which weights sit in the adjudicator's seat.
 *
 * A second, smaller kind of the same state as the compiler above: an
 * operational preference an administrator changes, not part of `PolicySpec`
 * and deliberately outside the policy hash — swapping the model must not
 * reversion every rule.
 *
 * It is one field because the choice is between two named seats, not a free
 * path. A free path belongs to `WARDEN_MODEL_ADJUDICATOR`, which is for
 * benchmarks and still wins over this; what the console offers is the two
 * options the corpus has numbers for.
 *
 * The safe direction on a corrupt or absent file is `default`, and that is not
 * arbitrary: the 1.7B is the configuration the shipped measurements were taken
 * against and the one that fits inside the hook's deadline. A settings file
 * nobody can parse must not silently promote a model that misses 18 more
 * points of attacks.
 */
export const adjudicatorSettingsSchema = z.object({
  model: z.enum(['default', 'dynaguard', 'dynaguard-8b', 'base', 'large', 'shieldstral', 'granite-guardian']),
  modelId: z.string().uuid().optional()
});
export type AdjudicatorSettings = z.infer<typeof adjudicatorSettingsSchema>;

const DEFAULT_ADJUDICATOR: AdjudicatorSettings = { model: 'default' };

export function loadAdjudicatorSettings(settingsPath = SETTINGS_PATH): AdjudicatorSettings {
  if (!existsSync(settingsPath)) return { ...DEFAULT_ADJUDICATOR };
  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf8')) as { adjudicator?: unknown };
    const parsed = adjudicatorSettingsSchema.safeParse(raw.adjudicator);
    return parsed.success ? parsed.data : { ...DEFAULT_ADJUDICATOR };
  } catch {
    return { ...DEFAULT_ADJUDICATOR };
  }
}

export function saveAdjudicatorSettings(next: AdjudicatorSettings): AdjudicatorSettings {
  const settings = adjudicatorSettingsSchema.parse(next);
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  let existing: Record<string, unknown> = {};
  if (existsSync(SETTINGS_PATH)) {
    try {
      existing = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')) as Record<string, unknown>;
    } catch {
      throw new Error('The saved settings file is unreadable. Restore it before changing settings.');
    }
  }
  // Merged, not replaced — the compiler settings live in the same file and a
  // whole-file write here would delete somebody's API key for choosing a model.
  atomicJSON(SETTINGS_PATH, { ...existing, adjudicator: settings });
  try {
    chmodSync(SETTINGS_PATH, 0o600);
  } catch {
    /* not a POSIX filesystem */
  }
  return settings;
}
