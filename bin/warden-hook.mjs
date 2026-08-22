#!/usr/bin/env node
// Entry point for the installed `warden-hook` binary. Runs the TypeScript
// source through tsx so the hook stays a single source of truth with the rest
// of the codebase rather than a separately-built artifact.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(
  process.execPath,
  [resolve(root, 'node_modules/tsx/dist/cli.mjs'), resolve(root, 'src/hook/cli.ts')],
  { stdio: 'inherit', cwd: root }
);
process.exit(result.status ?? 0);
