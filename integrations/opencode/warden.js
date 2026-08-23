/**
 * OpenCode plugin — route each chat message through Warden first.
 *
 * Install to ~/.config/opencode/plugin/warden.js and set WARDEN_URL and
 * WARDEN_API_KEY in your shell profile, the same two variables every other
 * integration reads.
 *
 * ⚠ UNVERIFIED. Nobody on this team has yet watched OpenCode refuse a prompt
 * through this plugin. The `chat.message` hook is documented as running before
 * the request reaches the model, and throwing from it should abort the message,
 * but that has not been observed here — and there are open issues upstream
 * about hooks not firing. Treat it as a starting point. Warden's README stays
 * silent about OpenCode until someone sees it block.
 *
 * The console generates a copy of this with your id already filled in:
 * People → pick a person → Onboarding → OpenCode.
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOOK = process.env.WARDEN_HOOK_PATH ?? join(homedir(), '.warden-hook.mjs');

export const WardenPlugin = async () => ({
  'chat.message': async (input) => {
    const text = (input?.parts ?? [])
      .map((part) => part.text)
      .filter(Boolean)
      .join('\n');
    if (!text.trim()) return;

    try {
      execFileSync('node', [HOOK], {
        input: JSON.stringify({ prompt: text, source: 'opencode' }),
        env: process.env
      });
    } catch (err) {
      // The hook exits non-zero to refuse, and writes the reason to stderr.
      // Throwing is what stops the message — returning normally lets it
      // through, which is the failure mode to watch for if this ever looks
      // like it is doing nothing.
      throw new Error(err.stderr?.toString().trim() || 'Blocked by Warden');
    }
  }
});
