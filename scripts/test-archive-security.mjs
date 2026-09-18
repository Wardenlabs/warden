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

// appdmg is platform-optional. When installed, verify its legacy callback API
// and bound the malformed-image probe so a parser regression cannot hang CI.
const { createRequire } = await import('node:module');
const { spawnSync } = await import('node:child_process');
const require = createRequire(import.meta.url);
let legacy;
try { legacy = createRequire(require.resolve('appdmg')).resolve('image-size'); }
catch (err) { if (err.code !== 'MODULE_NOT_FOUND') throw err; }
if (legacy) {
  const probe = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict'), size = require(process.argv[1]);
    const bad = Buffer.alloc(24); bad.write('icns'); bad.writeUInt32BE(24, 4);
    bad.write('ic07', 8); bad.writeUInt32BE(8, 12); bad.write('ic07', 16);
    assert.throws(() => size(bad), /ICNS/);
    size(process.argv[2], (err, value) => { assert.ifError(err); assert.equal(value.width, 16); });
  `, legacy, resolve('brand/warden-icon-16.png')], { timeout: 5000, encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr || probe.error?.message);
  console.log('Legacy DMG image parser rejects non-advancing entries and reads the brand PNG.');
}
