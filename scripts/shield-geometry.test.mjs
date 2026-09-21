import test from 'node:test';
import assert from 'node:assert/strict';
import { BufferGeometry, Float32BufferAttribute } from '../landing/assets/3d/three.core.js';
import { smoothBevels } from '../landing/assets/3d/smooth-bevels.js';
import * as THREE from '../landing/assets/3d/three.core.js';
import { createShield } from '../landing/assets/3d/official-shield.js';

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

test('the first, middle and resting frames preserve a centered front-facing mark', () => {
  let rendered;
  class Renderer {
    setClearColor() {}
    setPixelRatio(value) { this.pixelRatio = value; }
    setSize() {}
    render(scene, camera) { rendered = { scene, camera }; }
    dispose() {}
  }
  class Environment {
    fromScene() { return { texture: new THREE.Texture(), dispose() {} }; }
    dispose() {}
  }
  const shield = createShield({ THREE: { ...THREE, WebGLRenderer: Renderer, PMREMGenerator: Environment }, canvas: {} });
  shield.resize(400, 400, 2);
  let firstBounds;
  for (const time of [0, 1.3, 2.6]) {
    shield.renderAt(time);
    const hero = rendered.scene.children.find(child => child.isGroup);
    assert.deepEqual([hero.rotation.x, hero.rotation.y, hero.rotation.z], [0, 0, 0]);
    assert.equal(rendered.camera.isOrthographicCamera, true);
    const bounds = shield.projectedBounds();
    assert.ok(bounds.left > 0 && bounds.right < 400 && bounds.top > 0 && bounds.bottom < 400);
    if (firstBounds) assert.deepEqual(bounds, firstBounds, 'light entrance must not move the silhouette');
    firstBounds = bounds;
  }
  assert.equal(shield.renderer.pixelRatio, 3, 'Retina canvas is supersampled');
  shield.renderAt(2.6, { x: 1, y: 1 });
  const hero = rendered.scene.children.find(child => child.isGroup);
  assert.ok(hero.rotation.y > 0 && hero.rotation.y <= .1, 'pointer tilt remains restrained');
  shield.renderAt(2.6, { x: 0, y: 0 });
  assert.equal(hero.rotation.y, 0, 'leaving restores the frontal pose');
  shield.dispose();
});
