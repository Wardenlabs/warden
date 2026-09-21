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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOOK = process.env.WARDEN_HOOK_PATH ?? join(homedir(), '.warden-hook.mjs');
const run = promisify(execFile);

export const WardenPlugin = async () => ({
  'chat.message': async (input, output) => {
    // OpenCode supplies parts in the second argument. Keeping the fallback
    // accepts older wrappers, but inspecting only input.parts made the real
    // documented event a silent no-op. Pass file parts too: the standalone
    // hook reads explicit local files and sends bytes to the gateway.
    const parts = (output?.parts ?? input?.parts ?? []).filter((part) => !(part.type === 'text' && part.ignored));
    if (!parts.length) return;

    try {
      const child = run('node', [HOOK], {
        env: process.env,
        // Covers the health probe plus a 240-second document check. The
        // standalone hook still uses the shorter 90-second text deadline.
        // Async execution keeps the editor responsive while the guard works.
        timeout: 300_000,
        maxBuffer: 1024 * 1024
      });
      child.child.stdin.on('error', () => {}); // The rejected child promise handles early exit.
      child.child.stdin.end(JSON.stringify({ parts, source: 'opencode' }));
      await child;
    } catch (err) {
      if (err?.code === 2 || err?.status === 2) {
        throw new Error(err.stderr?.toString().trim() || 'Blocked by Warden');
      }
      throw new Error('Warden could not inspect this request. Restore the hook connection before retrying.');
    }
  }
});
