/** Each suite owns temporary runtime state; testing never edits an installation. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const suites = [
  'test-browser-boundary.ts', 'test-archive-security.mjs',
  'test-sanitize.ts',
  'test-vote.ts', 'test-hook.ts', 'test-cli-compiler.ts', 'test-claude-setup.ts', 'test-draft-schema.ts',
  'test-native-guards.ts', 'test-screen.ts', 'test-desktop-lib.ts', 'test-builtin-downloads.ts', 'test-auth.ts', 'test-installation.ts', 'test-devices.ts', 'test-verification.ts', 'test-pause.ts', 'test-rules-for-actor.ts',
  'test-remote-boundary.ts', 'test-hook-documents.ts', 'test-proxy-documents.ts',
  'test-documents.ts', 'test-document-budget.ts', 'test-qvac-cancellation.ts', 'test-model-management.ts', 'test-prompt-management.ts', 'test-console.mjs'
];
const temporary = mkdtempSync(join(tmpdir(), 'warden-tests-'));
const failures = [];
try {
  for (const suite of suites) {
    const folder = join(temporary, suite);
    mkdirSync(folder);
    // A developer may have cloud credentials or model overrides in their
    // shell. Deterministic regression tests must not use those accidentally.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('WARDEN_')));
    for (const field of ['AUDIT', 'POLICY', 'COMPANY', 'SETTINGS', 'PROMPT', 'PROMPT_TEMPLATES', 'APPEALS', 'ESCALATIONS', 'RATE_STATE', 'MODEL_CATALOG', 'DEVICES', 'VERIFIED']) {
      env[`WARDEN_${field}_PATH`] = join(folder, `${field.toLowerCase()}.json`);
    }
    env.WARDEN_ADAPTER = 'mock';
    env.WARDEN_MODELS_DIR = join(folder, 'models');
    env.CLAUDE_CODE_ENTRYPOINT = 'test';
    const args = suite.endsWith('.ts') ? ['--import', 'tsx', `scripts/${suite}`] : [`scripts/${suite}`];
    console.log(`\n${suite}`);
    const result = spawnSync(process.execPath, args, { env, stdio: 'inherit', timeout: 300_000 });
    if (result.status !== 0) {
      failures.push(suite);
      console.error(result.error?.message ?? `Exited ${result.status ?? result.signal}`);
    }
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
console.log(`\n${suites.length - failures.length}/${suites.length} regression suites passed.`);
if (failures.length) { console.error(`Failed: ${failures.join(', ')}`); process.exitCode = 1; }
