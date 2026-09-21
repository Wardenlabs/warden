/* Official Warden geometry, adapted directly from the approved film.
 * Original contours and bevel dimensions in a centered neutral metal studio.
 * White faces, chrome reflections and graphite edges carry the white brand. */
import { WARDEN_SYMBOL_PATHS } from './brand-paths.js';
import { smoothBevels } from './smooth-bevels.js';

export function createShield({ THREE: T, canvas }) {
    const renderer = new T.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = .92;
    const scene = new T.Scene();
    // Centered orthographic projection keeps the official face undistorted.
    // The former off-axis film crop showed a side even at zero rotation.
    const camera = new T.OrthographicCamera(-300, 300, 300, -300, 1, 5000);
    camera.position.set(0, 0, 1600);
    camera.lookAt(0, 0, 0);
    const hero = new T.Group();
    scene.add(hero);
    const clamp = n => Math.max(0, Math.min(1, n));
    const smooth = n => { const p = clamp(n); return p * p * (3 - 2 * p); };
    const mix = (a, b, p) => a + (b - a) * p;
    let width = 960, height = 960;

    // Absolute M/L/C/Z contours only: preserve the official curves, never replace
    // the mark with a generic shield, a texture plane, or an approximate W.
    const unit = 638 / (869.477 - 473.076);
    function officialContours(svg) {
      const tokens = svg.match(/[MLCZmlcz]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g);
      const paths = [];
      let i = 0, path;
      const point = () => [
        (Number(tokens[i++]) - 535.75) * unit,
        (671.2765 - Number(tokens[i++])) * unit
      ];
      while (i < tokens.length) {
        const command = tokens[i++];
        if (command === 'M') {
          path = new T.Shape(); paths.push(path); path.moveTo(...point());
        } else if (command === 'L') path.lineTo(...point());
        else if (command === 'C') path.bezierCurveTo(...point(), ...point(), ...point());
        else if (command === 'Z' || command === 'z') path.closePath();
        else throw new Error(`Unsupported official symbol command: ${command}`);
      }
      return paths;
    }
    const ringContours = officialContours(WARDEN_SYMBOL_PATHS[0]);
    const letterContours = officialContours(WARDEN_SYMBOL_PATHS[1]);
    if (ringContours.length !== 2 || letterContours.length !== 1) throw new Error('Unexpected Warden symbol contours.');
    const ringShape = ringContours[0];
    ringShape.holes.push(ringContours[1]);

    const silverFace = new T.MeshPhysicalMaterial({
      color: 0xc9c9c9, metalness: 1, roughness: .27,
      clearcoat: .26, clearcoatRoughness: .24, envMapIntensity: 1.15
    });
    const graphiteEdge = new T.MeshPhysicalMaterial({
      color: 0x808080, metalness: 1, roughness: .24,
      clearcoat: .26, clearcoatRoughness: .2, envMapIntensity: 1.1
    });
    const letterFace = new T.MeshPhysicalMaterial({
      color: 0xdadada, metalness: 1, roughness: .25,
      clearcoat: .26, clearcoatRoughness: .22, envMapIntensity: 1.15
    });
    function extrude(shape, depth, bevelSize, bevelThickness, faceMaterial, z) {
      const geometry = new T.ExtrudeGeometry(shape, {
        depth, curveSegments: 64, steps: 1,
        bevelEnabled: true, bevelSegments: 16, bevelSize, bevelThickness,
        material: 0, extrudeMaterial: 1
      });
      geometry.translate(0, 0, z);
      smoothBevels(geometry);
      geometry.computeBoundingBox();
      const mesh = new T.Mesh(geometry, [faceMaterial, graphiteEdge]);
      hero.add(mesh);
      return mesh;
    }
    const ring = extrude(ringShape, 62, 7, 10, silverFace, -31);
    const letter = extrude(letterContours[0], 43, 5.3, 8, letterFace, -12);

    // A local HDR studio gives the bevels actual reflected light. The environment
    // is generated once; neither network assets nor new PMREMs are needed per frame.
    const studio = new T.Scene();
    studio.background = new T.Color(0x141414);
    function softbox(position, boxWidth, boxHeight, color, intensity) {
      const material = new T.MeshBasicMaterial({ color, side: T.DoubleSide });
      material.color.multiplyScalar(intensity);
      const light = new T.Mesh(new T.PlaneGeometry(boxWidth, boxHeight), material);
      light.position.set(...position); light.lookAt(0, 0, 0); studio.add(light);
    }
    softbox([-5, 4, 7], 4.5, 10, 0xffffff, 3.0);
    // The frontal pose needs a broad camera-facing reflection. Side softboxes
    // alone turn a flat metal face black when viewed straight on.
    softbox([-1, 2, 8], 9, 7, 0xffffff, 2.4);
    softbox([5, 1, 4], 1.2, 9, 0xffffff, 3.6);
    softbox([0, 7, 2], 10, 2.8, 0xffffff, 3.2);
    softbox([-2, -5, 3], 6, 1.0, 0xffffff, .6);
    softbox([3, 3, -5], 2.0, 9, 0xffffff, 2.5);
    const pmrem = new T.PMREMGenerator(renderer);
    const environment = pmrem.fromScene(studio, .02, .1, 60);
    scene.environment = environment.texture;
    pmrem.dispose();
    studio.traverse(node => { if (node.isMesh) { node.geometry.dispose(); node.material.dispose(); } });

    scene.add(new T.HemisphereLight(0xf5f5f5, 0x151515, .28));
    const key = new T.DirectionalLight(0xffffff, 1.1);
    key.position.set(-600, 850, 1200); scene.add(key);
    const rim = new T.DirectionalLight(0xffffff, 2.0);
    rim.position.set(1100, 250, -700); scene.add(rim);
    const sweepLight = new T.PointLight(0xffffff, 0, 0, 2);
    scene.add(sweepLight);

    function resize(nextWidth = 960, nextHeight = nextWidth, pixelRatio = 1) {
      width = Math.max(1, Math.round(nextWidth));
      height = Math.max(1, Math.round(nextHeight));
      // Supersample this small hero object, including on Retina screens. The
      // three-times cap bounds GPU cost; visible idle motion is capped at 30fps.
      renderer.setPixelRatio(Math.min(3, Math.max(2, pixelRatio * 1.5)));
      renderer.setSize(width, height, false);
      const aspect = width / height;
      const cropHeight = Math.max(600, 480 / aspect);
      const cropWidth = cropHeight * aspect;
      camera.left = -cropWidth / 2; camera.right = cropWidth / 2;
      camera.top = cropHeight / 2; camera.bottom = -cropHeight / 2;
      camera.updateProjectionMatrix();
    }

    // Keep the entrance frontal, then reveal depth through a slow, bounded turn.
    // An explicit idle clock keeps still proofs and reduced motion deterministic.
    function renderAt(seconds = 2.6, interaction = {}) {
      const t = Number.isFinite(seconds) ? Math.max(0, seconds) : 2.6;
      const pointer = value => Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
      const pointerX = pointer(interaction?.x), pointerY = pointer(interaction?.y);
      const intro = smooth(t / 2.6);
      const idle = Number.isFinite(interaction.idleSeconds) ? Math.max(0, interaction.idleSeconds) : 0;
      const breathe = smooth(idle / 2);
      const phase = idle * Math.PI * 2 / 14;
      const yaw = Math.sin(phase) * .18 * breathe;
      const pitch = Math.sin(phase * .7) * .045 * breathe;
      hero.position.set(0, Math.sin(phase) * 4 * breathe, 0);
      hero.scale.setScalar(.69496079);
      hero.rotation.set(pitch + pointerY * .045 * intro, yaw + pointerX * .1 * intro, 0);
      const sweep = smooth((t - 1.15) / 1.30);
      scene.environmentRotation.set(0, mix(-.14, .12, intro) + yaw * .5 + pointerX * .16, -.12);
      sweepLight.position.set(mix(-750, 720, sweep), mix(480, -120, sweep), 700);
      sweepLight.intensity = t >= 1.15 && t <= 2.45 ? Math.sin(Math.PI * sweep) ** 2 * 350000 : 0;
      renderer.render(scene, camera);
    }

    function projectedBounds() {
      hero.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      const box = new T.Box3().setFromObject(hero), pixels = [];
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        const point = new T.Vector3(x, y, z).project(camera);
        pixels.push([(point.x * .5 + .5) * width, (.5 - point.y * .5) * height]);
      }
      return { left: Math.min(...pixels.map(p => p[0])), right: Math.max(...pixels.map(p => p[0])), top: Math.min(...pixels.map(p => p[1])), bottom: Math.max(...pixels.map(p => p[1])) };
    }

    function dispose() {
      ring.geometry.dispose(); letter.geometry.dispose();
      silverFace.dispose(); letterFace.dispose(); graphiteEdge.dispose();
      environment.dispose(); renderer.dispose();
    }
    resize();
    return { renderAt, resize, projectedBounds, dispose, renderer,
      geometryInfo: { source: 'WARDEN_SYMBOL_PATHS', ringHoles: 1, extrudedContours: 3 } };
}
