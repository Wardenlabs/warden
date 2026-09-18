/** Exercise the locally patched archive reader with actual ZIP entries. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import extract from 'extract-zip';
const root = await mkdtemp(join(tmpdir(), 'warden-zip-test-'));
const fixture = (name) => resolve('scripts/fixtures/archive-security', name);
try {
  const outside = join(root, 'outside'); await mkdir(outside);
  await writeFile(join(outside, 'secret'), 'original');
  await assert.rejects(extract(fixture('relative-escape.zip'), { dir: join(root, 'relative') }), /escapes/);
  await assert.rejects(extract(fixture('absolute-escape.zip'), { dir: join(root, 'absolute') }), /escapes/);
  const final = join(root, 'final'); await mkdir(final);
  await symlink(join(outside, 'secret'), join(final, 'file'));
  await assert.rejects(extract(fixture('final-symlink.zip'), { dir: final }), /symlink/);
  assert.equal(await readFile(join(outside, 'secret'), 'utf8'), 'original');
  await extract(fixture('safe-link.zip'), { dir: join(root, 'safe') });
  assert.equal(await readFile(join(root, 'safe/folder/link'), 'utf8'), 'safe');
  console.log('Archive containment passed; internal symlinks still extract.');
} finally { await rm(root, { recursive: true, force: true }); }
