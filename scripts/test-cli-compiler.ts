/**
 * The CLI compiler against a stand-in `claude`, with no model and no login.
 *
 * What this checks is the command line and what happens to its output, which
 * is where the feature has broken twice: once because the real hook judged
 * the compile prompt and stdout was a refusal, and once because the fix for
 * that, `--bare`, switched the login off and every compile came back
 * "Authentication error". A fake binary on PATH plays each of those CLIs and
 * records the arguments it was given.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { CliCompilerAdapter } from '../src/qvac/cli-compiler.js';
import { FailClosedError, type QvacAdapter } from '../src/qvac/types.js';

const dir = mkdtempSync(join(tmpdir(), 'warden-cli-compiler-'));
const argsFile = join(dir, 'args.json');
const fake = join(dir, 'fake.mjs');

// One script, several personalities, chosen by FAKE_CLAUDE. Each writes the
// argv it saw so the test can say what the adapter actually asked for.
writeFileSync(
  fake,
  `
import { writeFileSync } from 'node:fs';
const mode = process.env.FAKE_CLAUDE;
const args = process.argv.slice(2);
writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(args));
const answer = '\\n\`\`\`json\\n{"severity":"block","statement":"No customer data leaves the company."}\\n\`\`\`\\n';
if (mode === 'old' && args.includes('--safe-mode')) {
  // A CLI that predates the flag refuses the command line before touching stdin.
  process.stderr.write("error: unknown option '--safe-mode'\\n");
  process.exit(1);
}
if (mode === 'hook-old') { process.stdout.write('Operation stopped by hook: Blocked by Warden\\n'); process.exit(0); }
if (mode === 'hook-new') { process.stdout.write('UserPromptSubmit operation blocked by hook:\\n[node hook.mjs]: Blocked by Warden\\n'); process.exit(0); }
let input = '';
process.stdin.setEncoding('utf8').on('data', (c) => { input += c; }).on('end', () => {
  if (!input.includes('JSON Schema')) { process.stderr.write('no schema in prompt'); process.exit(1); }
  process.stdout.write(answer);
});
`
);
const shim = join(dir, 'claude');
writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
chmodSync(shim, 0o755);
process.env['PATH'] = `${dir}:${process.env['PATH'] ?? ''}`;
process.env['FAKE_ARGS_FILE'] = argsFile;

const never = async (): Promise<never> => {
  throw new Error('the local adapter must not be asked to compile');
};
const local: QvacAdapter = {
  complete: never,
  completeJSON: never,
  embed: async () => [],
  ocr: async () => '',
  stats: () => ({ firstTry: 0, repaired: 0, failed: 0 }),
  dispose: async () => {}
};

const schema = z.object({ severity: z.enum(['block', 'escalate', 'warn']), statement: z.string() });
const jsonSchema = { type: 'object', required: ['severity', 'statement'] };
const req = { role: 'compiler' as const, system: 'Compile the sentence.', user: 'Sentence: "no customer data leaves"' };

function adapter(): CliCompilerAdapter {
  return new CliCompilerAdapter(local, { tool: 'claude', model: 'sonnet', timeoutMs: 20_000 });
}
function argsSeen(): string[] {
  return JSON.parse(readFileSync(argsFile, 'utf8')) as string[];
}

async function main(): Promise<void> {
  try {
    process.env['FAKE_CLAUDE'] = 'safe';
    const ok = await adapter().completeJSON(req, schema, jsonSchema);
    assert.equal(ok.value.severity, 'block');
    assert.equal(ok.attempts, 1);
    const args = argsSeen();
    assert.ok(args.includes('--safe-mode'), args.join(' '));
    assert.ok(!args.includes('--bare'), '--bare switches the login off; it must never come back');
    assert.deepEqual(args.slice(0, 2), ['-p', '--safe-mode']);
    console.log('✓ compiles under --safe-mode, and never under --bare');

    process.env['FAKE_CLAUDE'] = 'old';
    const old = adapter();
    const first = await old.completeJSON(req, schema, jsonSchema);
    assert.equal(first.value.severity, 'block');
    assert.ok(!argsSeen().includes('--safe-mode'), 'the retry must drop the flag');
    await old.completeJSON(req, schema, jsonSchema);
    assert.equal(old.cliCalls(), 2, 'the answer is remembered: one process per compile after the first');
    console.log('✓ a CLI that does not know --safe-mode is retried without it, once');

    for (const mode of ['hook-old', 'hook-new']) {
      process.env['FAKE_CLAUDE'] = mode;
      await assert.rejects(
        adapter().completeJSON(req, schema, jsonSchema),
        (err: unknown) => err instanceof FailClosedError && /prompt hook that blocked the compile/.test(err.message)
      );
    }
    console.log('✓ a hook answering for the model is named as a hook, in both of the CLI\'s wordings');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
