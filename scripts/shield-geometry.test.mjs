import test from 'node:test';
import assert from 'node:assert/strict';
import { BufferGeometry, Float32BufferAttribute } from '../landing/assets/3d/three.core.js';
import { smoothBevels } from '../landing/assets/3d/smooth-bevels.js';

test('bevel shading blends adjacent facets without rounding sharp corners or moving the logo', () => {
  const geometry = new BufferGeometry();
  const angle = Math.PI / 12;
  geometry.setAttribute('position', new Float32BufferAttribute([
    0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3
  ], 3));
  geometry.setAttribute('normal', new Float32BufferAttribute([
    0, 0, 1, Math.sin(angle), 0, Math.cos(angle), 0, 1, 0, 1, 0, 0
  ], 3));
  geometry.addGroup(0, 3, 1);
  geometry.addGroup(3, 1, 0);
  const before = geometry.getAttribute('position').array.slice();
  smoothBevels(geometry);
  const normal = geometry.getAttribute('normal');
  assert.ok(Math.abs(normal.getX(0) - Math.sin(angle / 2)) < 1e-6);
  assert.ok(Math.abs(normal.getZ(0) - Math.cos(angle / 2)) < 1e-6);
  assert.equal(normal.getY(2), 1, 'right-angle crease stays sharp');
  assert.equal(normal.getX(3), 1, 'separate vertices retain their normals');
  assert.deepEqual(geometry.getAttribute('position').array, before);
  assert.deepEqual(geometry.groups, [{ start: 0, count: 3, materialIndex: 1 }, { start: 3, count: 1, materialIndex: 0 }]);
  for (let i = 0; i < normal.count; i++) {
    assert.ok(Math.abs(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i)) - 1) < 1e-6);
  }
  geometry.dispose();
});
