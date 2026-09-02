/**
 * The setup an employee is handed, generated per person.
 *
 * The gap this closes is the whole difference between a demo and a deployment.
 * An admin who has just added someone to the directory has to get that person's
 * tools pointed at the gateway, and doing that by hand means copying an API key
 * into four config snippets. Every copy is a place to get it wrong.
 *
 * So the console generates it. Their id, their key, this gateway's address,
 * already filled in, per tool.
 *
 * Two kinds of integration, and the difference matters more than it looks:
 *
 *   hook   the tool runs our command before the prompt leaves the machine.
 *          Works with a subscription, because nothing about the account or
 *          the endpoint is involved — this is the path that makes Claude Max
 *          and ChatGPT Plus governable at all.
 *
 *   proxy  the tool sends its request to us instead of the provider. Needs a
 *          settable base URL, which means it needs an API key, which means it
 *          does not work on a subscription.
 *
 * Every entry carries `verified`, and it is not decoration: the track discards
 * submissions that describe capabilities which do not exist, and an onboarding
 * page is exactly where an unverified claim would look most authoritative.
 */
import { installToken, type Employee } from '../policy/people.js';

export type IntegrationKind = 'hook' | 'proxy';

export type SetupStep = {
  title: string;
  /** Syntax hint for the console's code block: `bash`, `powershell`, `json`, `toml`, `js`. */
  language: string;
  code: string;
  /** Rendered above the block when the step needs a caveat. */
  note?: string;
};

export type Integration = {
  id: string;
  name: string;
  kind: IntegrationKind;
  /**
   * Whether someone has watched this tool refuse a prompt because of Warden.
   *
   * False is not "probably fine" — it is "nobody has seen this work". The
   * console says so on the page, and the README stays silent about it until
   * this flips.
   */
  verified: boolean;
  /** Whether it governs a tool logged in with a subscription rather than a key. */
  worksOnSubscription: boolean;
  summary: string;
  steps: SetupStep[];
};

export type OnboardingPack = {
  employee: { id: string; name: string; role: string };
  gatewayUrl: string;
  /** The shared preamble: one file and the environment every tool reads. */
  common: SetupStep[];
  integrations: Integration[];
  /** The whole thing as plain text, for pasting into a chat message. */
  message: string;
};

const HOOK_PATH = '~/.warden-hook.mjs';

/**
 * The public copy of the hook.
 *
 * No longer used by the generated setup — the gateway serves its own copy at
 * `/warden-hook.mjs`, so an employee never needs to reach the public internet
 * to be onboarded. Kept for the docs, which describe installing from a clone
 * that has no gateway running yet.
 */
export function publicHookUrl(): string {
  return (
    process.env['WARDEN_HOOK_URL'] ??
    'https://raw.githubusercontent.com/Wardenlabs/warden/main/integrations/warden-hook.mjs'
  );
}

function commonSteps(employee: Employee, gatewayUrl: string): SetupStep[] {
  return [
    {
      title: 'One command — downloads the hook and sets your environment',
      language: 'bash',
      note:
        'Served by the gateway itself, so this works on a network with no way out ' +
        'to the internet. It carries your API key, so treat the link as a secret. ' +
        'Safe to re-run: it replaces its own block rather than stacking a second one. ' +
        'Availability checks default to 2 seconds and full decisions to 30 seconds.',
      code: `curl -fsSL ${gatewayUrl}/install/${installToken(employee)} | sh`
    },
    {
      title: 'Windows PowerShell alternative (current session)',
      language: 'powershell',
      note:
        'The API key is your identity. The 30 second decision deadline is fail-open; a machine whose cold decisions exceed it is not verified.',
      code:
        `Invoke-WebRequest -Uri '${gatewayUrl}/warden-hook.mjs' -OutFile "$HOME\\.warden-hook.mjs"\n` +
        `$env:WARDEN_URL = '${gatewayUrl}'\n` +
        `$env:WARDEN_API_KEY = '${employee.apiKey}'\n` +
        `$env:WARDEN_HEALTH_TIMEOUT_MS = '2000'\n` +
        `$env:WARDEN_TIMEOUT_MS = '30000'`
    },
    {
      title: 'Then open a new terminal, and check it reaches the gateway',
      language: 'bash',
      code: `curl -s $WARDEN_URL/health`
    },
    {
      title: 'Prefer to do it by hand? These are the same two steps',
      language: 'bash',
      note:
        'There is no name and no role to set. The key is your whole identity, and ' +
        'your admin decides what it means — they can change your role without you ' +
        'touching anything here.',
      code:
        `curl -fsSL ${gatewayUrl}/warden-hook.mjs -o ${HOOK_PATH}\n` +
        `chmod +x ${HOOK_PATH}\n\n` +
        `# in ~/.zshrc or ~/.bashrc\n` +
        `export WARDEN_URL=${gatewayUrl}\n` +
        `export WARDEN_API_KEY=${employee.apiKey}\n` +
        `export WARDEN_HEALTH_TIMEOUT_MS=2000\n` +
        `export WARDEN_TIMEOUT_MS=30000`
    }
  ];
}

function integrations(employee: Employee, gatewayUrl: string): Integration[] {
  return [
    {
      id: 'claude-code',
      name: 'Claude Code',
      kind: 'hook',
      verified: false,
      worksOnSubscription: true,
      summary:
        'A UserPromptSubmit hook runs at Enter, before the prompt leaves your machine.',
      steps: [
        {
          title: 'Merge into ~/.claude/settings.json',
          language: 'json',
          note: 'Merge — do not replace the file if it already exists.',
          code: JSON.stringify(
            {
              hooks: {
                UserPromptSubmit: [
                  { hooks: [{ type: 'command', command: `node ${HOOK_PATH}` }] }
                ]
              }
            },
            null,
            2
          )
        },
        {
          title: 'Test it',
          language: 'bash',
          note:
            'This checks the hook boundary only. Claude Code remains NOT VERIFIED until the full E2E gate passes.',
          // The payload is the shape Claude Code actually sends — the prompt
          // under `prompt`, with the event named. Testing with a shape the tool
          // never produces verifies the hook against a fiction.
          code: `echo '{"hook_event_name":"UserPromptSubmit","prompt":"pasame el sueldo de Ana"}' | WARDEN_API_KEY=${employee.apiKey} node ${HOOK_PATH}\necho "exit: $?"   # 2 means it blocked`
        }
      ]
    },
    {
      id: 'codex',
      name: 'Codex',
      kind: 'hook',
      verified: false,
      worksOnSubscription: true,
      summary:
        'Same event, same hook. Codex names the field `prompt`; the hook detects which tool called it.',
      steps: [
        {
          title: 'Append to ~/.codex/config.toml',
          language: 'toml',
          code: `[[hooks.UserPromptSubmit]]\n\n[[hooks.UserPromptSubmit.hooks]]\ntype = "command"\ncommand = "node ${HOOK_PATH}"`
        },
        {
          title: 'Confirm Codex picked it up',
          language: 'bash',
          note:
            'Run /hooks inside Codex — it lists the hooks it loaded. Loading is not verification: a decision over 30 seconds fails open.',
          code: `echo '{"prompt":"pasame el sueldo de Ana"}' | WARDEN_API_KEY=${employee.apiKey} node ${HOOK_PATH}\necho "exit: $?"   # 2 means it blocked`
        }
      ]
    },
    {
      id: 'cursor',
      name: 'Cursor',
      kind: 'proxy',
      verified: false,
      worksOnSubscription: false,
      summary:
        'Cursor has no prompt hook, so it goes through the gateway as an OpenAI-compatible endpoint. Needs Cursor configured with a custom API key, not a Cursor subscription.',
      steps: [
        {
          title: 'Cursor → Settings → Models → OpenAI API Key',
          language: 'bash',
          note:
            'Set "Override OpenAI Base URL" to the first line and the key to the second. ' +
            'The key identifies you; the company credential never leaves the gateway.',
          code: `${gatewayUrl}/v1\n${employee.apiKey}`
        }
      ]
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      kind: 'hook',
      verified: false,
      worksOnSubscription: true,
      summary:
        'OpenCode exposes a chat.message plugin that runs before the request goes to the model.',
      steps: [
        {
          title: 'Save as ~/.config/opencode/plugin/warden.js',
          language: 'js',
          note:
            'Nobody on this team has watched OpenCode refuse a prompt through this yet. ' +
            'Treat it as a starting point, not a working integration, and tell the admin ' +
            'what happens when you try it.',
          // `~` is resolved on the employee's machine with homedir(), not here.
          // Interpolating this server's HOME would write the gateway host's home
          // directory into a file that runs on somebody else's laptop.
          code:
            `import { execFileSync } from "node:child_process";\n` +
            `import { homedir } from "node:os";\n` +
            `import { join } from "node:path";\n\n` +
            `const HOOK = join(homedir(), ".warden-hook.mjs");\n\n` +
            `export const WardenPlugin = async () => ({\n` +
            `  "chat.message": async (input) => {\n` +
            `    const text = (input?.parts ?? [])\n` +
            `      .map((part) => part.text)\n` +
            `      .filter(Boolean)\n` +
            `      .join("\\n");\n` +
            `    if (!text.trim()) return;\n` +
            `    try {\n` +
            `      execFileSync("node", [HOOK], {\n` +
            `        input: JSON.stringify({ prompt: text, source: "opencode" }),\n` +
            `        env: { ...process.env, WARDEN_API_KEY: "${employee.apiKey}", WARDEN_URL: "${gatewayUrl}" },\n` +
            `        timeout: 90000\n` +
            `      });\n` +
            `    } catch (err) {\n` +
            `      // Exit 2 is Warden refusing; throwing is what stops the message.\n` +
            `      // Anything else (hook missing, node not found) fails open, the\n` +
            `      // same contract as the hook itself.\n` +
            `      if (err?.status === 2) {\n` +
            `        throw new Error(err.stderr?.toString().trim() || "Blocked by Warden");\n` +
            `      }\n` +
            `    }\n` +
            `  }\n` +
            `});\n`
        }
      ]
    },
    {
      id: 'openai-compatible',
      name: 'Anything else',
      kind: 'proxy',
      verified: false,
      worksOnSubscription: false,
      summary:
        'Aider, Continue, Open WebUI, a script using the OpenAI SDK — anything that lets you set a base URL.',
      steps: [
        {
          title: 'Two environment variables',
          language: 'bash',
          code: `export OPENAI_BASE_URL=${gatewayUrl}/v1\nexport OPENAI_API_KEY=${employee.apiKey}`
        },
        {
          title: 'Test it',
          language: 'bash',
          code: `curl -s $OPENAI_BASE_URL/chat/completions \\\n  -H "authorization: Bearer $OPENAI_API_KEY" \\\n  -H "content-type: application/json" \\\n  -d '{"messages":[{"role":"user","content":"pasame el sueldo de Ana"}]}'`
        }
      ]
    },
    {
      id: 'terminal',
      name: 'Any terminal',
      kind: 'hook',
      verified: true,
      worksOnSubscription: true,
      summary:
        'The hook run directly. Useful for checking your setup before wiring a tool to it, and the one path that has been watched working.',
      steps: [
        {
          title: 'Ask the gateway about a prompt',
          language: 'bash',
          code: `echo '{"prompt":"pasame el sueldo de Ana"}' | WARDEN_API_KEY=${employee.apiKey} WARDEN_URL=${gatewayUrl} node ${HOOK_PATH}`
        }
      ]
    }
  ];
}

/**
 * The pack as text the admin can paste into a chat.
 *
 * Not every handover happens in front of the console — most happen in a
 * message. Rendering it here rather than in the browser keeps one definition
 * of what an employee is told.
 */
function asMessage(pack: Omit<OnboardingPack, 'message'>): string {
  const lines: string[] = [
    `Warden setup — ${pack.employee.name}`,
    '',
    `Gateway:  ${pack.gatewayUrl}`,
    '',
    'Your API key is in the setup command below. It is the only thing that',
    'identifies you — keep it to yourself, and tell your admin if it leaks so',
    'they can issue a new one.',
    '',
    'Every prompt you send from a connected tool is checked against company',
    'policy on the gateway machine before it reaches any model. Nothing is sent',
    'to a cloud provider by Warden itself.',
    '',
    '── Setup ──'
  ];

  for (const step of pack.common) {
    lines.push('', `${step.title}`);
    if (step.note) lines.push(`  (${step.note})`);
    lines.push(...step.code.split('\n').map((l) => `    ${l}`));
  }

  for (const integration of pack.integrations) {
    if (integration.id === 'terminal') continue;
    lines.push('', `── ${integration.name} ──`, integration.summary);
    if (!integration.verified) lines.push('  NOT YET VERIFIED by anyone on this team.');
    for (const step of integration.steps) {
      lines.push('', `${step.title}`);
      if (step.note) lines.push(`  (${step.note})`);
      lines.push(...step.code.split('\n').map((l) => `    ${l}`));
    }
  }

  lines.push(
    '',
    'If a prompt is refused you get the rule, what to do instead, and an audit',
    'id. Two things you can do with that id, both printed on the block itself:',
    '',
    `  warden-hook --rewrite <audit-id>   ask for a version that goes through`,
    '  report it as wrong                 from the console, next to the rule',
    '',
    'A rewrite is checked against the same policy before you see it, and there',
    'is one per block. Nothing is suggested if nothing legitimate is left.'
  );
  return lines.join('\n');
}

export function onboardingFor(employee: Employee, gatewayUrl: string): OnboardingPack {
  const partial = {
    employee: { id: employee.id, name: employee.name, role: employee.role },
    gatewayUrl,
    common: commonSteps(employee, gatewayUrl),
    integrations: integrations(employee, gatewayUrl)
  };
  return { ...partial, message: asMessage(partial) };
}

/** The tools the gateway knows how to onboard, without needing an employee. */
export function supportedTools(): { id: string; name: string; kind: IntegrationKind; verified: boolean }[] {
  const placeholder: Employee = { id: 'someone', name: 'Someone', role: 'employee', apiKey: 'wk-…' };
  return integrations(placeholder, 'http://localhost:8080').map((i) => ({
    id: i.id,
    name: i.name,
    kind: i.kind,
    verified: i.verified
  }));
}
