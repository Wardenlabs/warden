/**
 * The official closing object enters once in 1.9 seconds. Pointer movement
 * subtly turns its real geometry and reflected light, then rendering stops.
 * Offscreen/hidden tabs do no render work; a PNG remains if enhancement fails.
 */
export function mountShield(container) {
  const canvas = container?.querySelector('canvas');
  const fallback = container?.querySelector('img');
  if (!canvas || !fallback) throw new TypeError('The Warden shield needs a canvas and fallback image.');

  const surface = container.closest('.hero-art') || container.closest('.closing-body') || container;
  const originalCanvasVisibility = canvas.style.visibility;
  const originalImageVisibility = fallback.style.visibility;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  const duration = 1.9;
  const pointer = { x: 0, y: 0 };
  const target = { x: 0, y: 0 };
  let scene, frame = 0, previousTime = 0, elapsed = 0;
  let visible = false, loading = false, destroyed = false, failed = false, manual = false;
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });

  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.visibility = 'hidden';
  container.dataset.shield = 'idle';

  function stop() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    previousTime = 0;
  }

  function showFallback() {
    stop();
    failed = true;
    canvas.style.visibility = 'hidden';
    fallback.style.visibility = originalImageVisibility || 'visible';
    container.dataset.shield = 'fallback';
    resolveReady(false);
  }

  function draw() {
    if (!scene || destroyed || failed) return;
    try {
      scene.renderAt(elapsed / duration * 2.6, pointer);
      canvas.style.visibility = 'visible';
      fallback.style.visibility = 'hidden';
      container.dataset.shield = elapsed < duration ? 'entering' : 'ready';
    } catch {
      showFallback();
    }
  }

  function isMoving() {
    return elapsed < duration || Math.abs(target.x - pointer.x) > .001 || Math.abs(target.y - pointer.y) > .001;
  }

  function tick(timestamp) {
    frame = 0;
    if (!visible || document.hidden || destroyed || failed || manual) return;
    const delta = previousTime ? Math.min(.05, (timestamp - previousTime) / 1000) : 1 / 60;
    previousTime = timestamp;
    elapsed = Math.min(duration, elapsed + delta);
    const damping = 1 - Math.exp(-15 * delta);
    pointer.x += (target.x - pointer.x) * damping;
    pointer.y += (target.y - pointer.y) * damping;
    if (reducedMotion.matches) {
      elapsed = duration;
      pointer.x = pointer.y = target.x = target.y = 0;
    }
    const moving = isMoving();
    if (!moving) { pointer.x = target.x; pointer.y = target.y; }
    draw();
    if (moving && !failed) frame = requestAnimationFrame(tick);
    else previousTime = 0;
  }

  function resume() {
    if (!scene || !visible || document.hidden || destroyed || failed || manual) return;
    if (reducedMotion.matches) {
      elapsed = duration;
      pointer.x = pointer.y = target.x = target.y = 0;
    }
    draw();
    if (isMoving() && !frame) frame = requestAnimationFrame(tick);
  }

  function resize() {
    if (!scene || destroyed || failed) return;
    const bounds = canvas.getBoundingClientRect();
    const width = bounds.width || container.clientWidth || 480;
    scene.resize(width, bounds.height || width, window.devicePixelRatio || 1);
    if (visible && !document.hidden) draw();
  }

  async function load() {
    if (loading || scene || destroyed || failed) return;
    loading = true;
    container.dataset.shield = 'loading';
    try {
      const [THREE, { createShield }] = await Promise.all([
        import('./assets/3d/three.module.js'),
        import('./assets/3d/official-shield.js?v=white-studio-1'),
      ]);
      if (destroyed) return;
      scene = createShield({ THREE, canvas });
      if (reducedMotion.matches) elapsed = duration;
      resize();
      resume();
      resolveReady(!failed);
    } catch {
      if (!destroyed) showFallback();
    }
  }

  function pointerMoved(event) {
    if (!finePointer.matches || reducedMotion.matches || event.pointerType === 'touch' || !visible || document.hidden || manual) return;
    const bounds = surface.getBoundingClientRect();
    target.x = Math.max(-1, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width) * 2 - 1));
    target.y = Math.max(-1, Math.min(1, (event.clientY - bounds.top) / Math.max(1, bounds.height) * 2 - 1));
    if (scene && !failed && !frame) frame = requestAnimationFrame(tick);
  }

  function pointerLeft() {
    target.x = target.y = 0;
    resume();
  }

  function visibilityChanged() {
    if (document.hidden) { stop(); target.x = target.y = 0; }
    else resume();
  }

  function preferenceChanged() {
    stop();
    pointer.x = pointer.y = target.x = target.y = 0;
    if (reducedMotion.matches) elapsed = duration;
    resume();
  }

  function contextLost(event) {
    event.preventDefault();
    showFallback();
  }

  const observer = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    if (visible) { load(); resume(); }
    else { stop(); pointer.x = pointer.y = target.x = target.y = 0; }
  }, { threshold: .05 }) : null;
  if (observer) observer.observe(container);
  else { visible = true; load(); }

  const resizeObserver = 'ResizeObserver' in window ? new ResizeObserver(resize) : null;
  if (resizeObserver) resizeObserver.observe(container);
  else window.addEventListener('resize', resize, { passive: true });
  surface.addEventListener('pointermove', pointerMoved, { passive: true });
  surface.addEventListener('pointerleave', pointerLeft, { passive: true });
  document.addEventListener('visibilitychange', visibilityChanged);
  reducedMotion.addEventListener('change', preferenceChanged);
  finePointer.addEventListener('change', preferenceChanged);
  canvas.addEventListener('webglcontextlost', contextLost);

  return {
    ready,
    // Uses the original renderer's 0–2.6-second clock for existing proof tools.
    renderAt(seconds) {
      manual = true;
      stop();
      pointer.x = pointer.y = target.x = target.y = 0;
      elapsed = Math.max(0, Math.min(2.6, Number.isFinite(seconds) ? seconds : 2.6)) / 2.6 * duration;
      draw();
      return scene?.projectedBounds();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
      observer?.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener('resize', resize);
      surface.removeEventListener('pointermove', pointerMoved);
      surface.removeEventListener('pointerleave', pointerLeft);
      document.removeEventListener('visibilitychange', visibilityChanged);
      reducedMotion.removeEventListener('change', preferenceChanged);
      finePointer.removeEventListener('change', preferenceChanged);
      canvas.removeEventListener('webglcontextlost', contextLost);
      scene?.dispose();
      canvas.style.visibility = originalCanvasVisibility;
      fallback.style.visibility = originalImageVisibility;
      delete container.dataset.shield;
      resolveReady(false);
    },
  };
}
