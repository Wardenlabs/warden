const checkpoint = document.querySelector('.checkpoint');
if (checkpoint) {
  const geometry = checkpoint.querySelector('.checkpoint-geometry');
  const shield = checkpoint.querySelector('.checkpoint-shield');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const lowCapability = (navigator.hardwareConcurrency || 8) <= 2 || (navigator.deviceMemory || 8) <= 2;
  let visible = false, assetsReady = false, started = false, finished = reducedMotion.matches;
  let shieldLoad;

  const resize = () => {
    if (checkpoint.clientWidth > 0) geometry?.style.setProperty('--checkpoint-scale', String(checkpoint.clientWidth / 560));
  };
  resize();
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(checkpoint);
  else window.addEventListener('resize', resize, { passive: true });

  function settle() {
    finished = true;
    checkpoint.dataset.checkpointMotion = 'complete';
  }

  function updateMotion() {
    if (finished || reducedMotion.matches) { settle(); return; }
    if (!assetsReady) return;
    if (visible && !document.hidden) {
      started = true;
      checkpoint.dataset.checkpointMotion = 'playing';
    } else if (started) checkpoint.dataset.checkpointMotion = 'paused';
  }

  function loadShield() {
    if (shieldLoad) return shieldLoad;
    if (reducedMotion.matches || lowCapability) {
      shieldLoad = Promise.resolve(false).then(() => {
        assetsReady = true;
        settle();
        return false;
      });
      return shieldLoad;
    }
    shieldLoad = (shield
      ? import('./shield.js?v=white-studio-1').then(({ mountShield }) => mountShield(shield).ready)
      : Promise.resolve(false))
      .catch(() => false)
      .then(() => {
        // A WebGL failure keeps the official PNG and the same readable sequence.
        assetsReady = true;
        updateMotion();
      });
    return shieldLoad;
  }

  checkpoint.addEventListener('animationend', event => {
    if (event.target.matches('.decision-object') && event.animationName === 'decision-lands') settle();
  });
  document.addEventListener('visibilitychange', updateMotion);
  reducedMotion.addEventListener('change', updateMotion);

  if ('IntersectionObserver' in window) {
    const preload = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      preload.disconnect();
      loadShield();
    }, { rootMargin: '150px 0px' });
    preload.observe(checkpoint);
    const visibility = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting && entry.intersectionRatio >= .12);
      if (visible) loadShield();
      updateMotion();
    }, { threshold: [0, .12] });
    visibility.observe(checkpoint);
  } else {
    visible = true;
    settle();
    loadShield();
  }
  if (finished) settle();
}
