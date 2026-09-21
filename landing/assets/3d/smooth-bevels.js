/** Smooth shared bevel vertices while retaining the mark's deliberate hard corners.
 * ExtrudeGeometry emits independent triangles, so computeVertexNormals alone
 * leaves visible bands on metal. Only normals within the crease angle blend.
 * Positions, UVs and material groups remain untouched.
 */
export function smoothBevels(geometry, creaseAngle = Math.PI / 3) {
  const positions = geometry.getAttribute('position');
  const normals = geometry.getAttribute('normal');
  const original = normals.array.slice();
  const vertices = new Map();
  const keys = [];
  // ExtrudeGeometry's cap is material 0. Keep that face optically planar;
  // blending its large triangles with tiny bevels makes polished metal dented.
  const sides = new Set();
  for (const group of geometry.groups) {
    if (group.materialIndex !== 1) continue;
    for (let i = group.start; i < group.start + group.count; i++) sides.add(i);
  }
  for (let i = 0; i < positions.count; i++) {
    if (!sides.has(i)) continue;
    const key = [positions.getX(i), positions.getY(i), positions.getZ(i)]
      .map(value => Math.round(value * 10000)).join(',');
    keys[i] = key;
    if (!vertices.has(key)) vertices.set(key, []);
    vertices.get(key).push(i);
  }
  const threshold = Math.cos(creaseAngle);
  for (let i = 0; i < normals.count; i++) {
    if (!sides.has(i)) continue;
    const offset = i * 3;
    let x = 0, y = 0, z = 0;
    for (const adjacent of vertices.get(keys[i])) {
      const other = adjacent * 3;
      const dot = original[offset] * original[other]
        + original[offset + 1] * original[other + 1]
        + original[offset + 2] * original[other + 2];
      if (dot < threshold) continue;
      x += original[other]; y += original[other + 1]; z += original[other + 2];
    }
    const length = Math.hypot(x, y, z);
    if (length > 0) normals.setXYZ(i, x / length, y / length, z / length);
  }
  normals.needsUpdate = true;
  return geometry;
}
