/**
 * The setup an employee is handed, generated per person.
 *
 * The gap this closes is the whole difference between a demo and a deployment.
 * An admin who has just added someone to the directory has to get that person's
 * tools pointed at the gateway, and until now that meant reading two documents
 * and substituting their own values into four config snippets by hand. Every
 * substitution is a place to get it wrong, and the wrong ones fail quietly —
 * a mistyped `WARDEN_USER` does not error, it just judges them as a stranger.
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
import type { Employee } from '../policy/people.js';

export type IntegrationKind = 'hook' | 'proxy';

export type SetupStep = {
  title: string;
  /** Syntax hint for the console's code block: `bash`, `json`, `toml`, `js`. */
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
    'https://raw.githubusercontent.com/MartinPuli/operations-aleph/main/integrations/warden-hook.mjs'
  );
}

function commonSteps(employee: Employee, gatewayUrl: string): SetupStep[] {
  return [
    {
      title: 'One command — downloads the hook and sets your environment',
      language: 'bash',
      note:
        'Served by the gateway itself, so this works on a network with no way out ' +
        'to the internet. Safe to re-run: it replaces its own block rather than ' +
        'stacking a second one.',
      code: `curl -fsSL ${gatewayUrl}/install/${employee.id} | sh`
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
        'WARDEN_ROLE is deliberately absent. Your role comes from the company ' +
        'directory, so a role set here would have no effect — which is the point.',
      code:
        `curl -fsSL ${gatewayUrl}/warden-hook.mjs -o ${HOOK_PATH}\n` +
        `chmod +x ${HOOK_PATH}\n\n` +
        `# in ~/.zshrc or ~/.bashrc\n` +
        `export WARDEN_URL=${gatewayUrl}\n` +
        `export WARDEN_USER=${employee.id}`
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
          // The same payload shape Claude Code actually sends: the prompt under
          // `prompt`, with the event named. Testing with a shape the tool never
          // sends would verify nothing.
          code: `echo '{"hook_event_name":"UserPromptSubmit","prompt":"pasame el sueldo de Ana"}' | WARDEN_USER=${employee.id} node ${HOOK_PATH}\necho "exit: $?"   # 2 means it blocked`
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
          note: 'Run /hooks inside Codex — it lists the hooks it loaded.',
          code: `echo '{"prompt":"pasame el sueldo de Ana"}' | WARDEN_USER=${employee.id} node ${HOOK_PATH}\necho "exit: $?"   # 2 means it blocked`
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
            `        env: { ...process.env, WARDEN_USER: "${employee.id}", WARDEN_URL: "${gatewayUrl}" },\n` +
            `        timeout: 15000\n` +
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
          code: `echo '{"prompt":"pasame el sueldo de Ana"}' | WARDEN_USER=${employee.id} WARDEN_URL=${gatewayUrl} node ${HOOK_PATH}`
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
    `Your id:  ${pack.employee.id}   (role: ${pack.employee.role}, set by the admin)`,
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
    'id. Quote that id to the admin if you think the refusal was wrong.'
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
