const mounts = new WeakMap();

/** A finite illustration of three policy decisions; a native button replays it. */
export function mountHeroTrace(art) {
  const request = art?.querySelector('.trace-request');
  const verdict = art?.querySelector('.trace-verdict');
  const incoming = art?.querySelector('.trace-in');
  const outgoing = art?.querySelector('.trace-out');
  if (!request || !verdict || !incoming || !outgoing) {
    throw new TypeError('The hero trace needs request and verdict labels and two SVG paths.');
  }

  mounts.get(art)?.destroy();
  const wasDisabled = art.disabled;
  const originalTabIndex = art.getAttribute('tabindex');
  art.disabled = false;
  art.removeAttribute('tabindex');

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const beats = [
    { request: 'Share a client’s private pricing', verdict: 'Blocked by Warden', state: 'blocked', start: 0 },
    { request: 'Send the client contact list', verdict: 'Blocked by Warden', state: 'blocked', start: 1450 },
    { request: 'Summarize public documentation', verdict: 'Allowed by Warden', state: 'allowed', start: 2900 },
  ];
  const duration = 4400;
  const travelDuration = 620;
  const original = {
    request: request.textContent,
    verdict: verdict.textContent,
    state: art.getAttribute('data-trace'),
    styles: [
      [art, '--trace-in'], [art, '--trace-out'], [art, '--trace-impact'],
      [incoming, 'stroke-dasharray'], [incoming, 'stroke-dashoffset'],
      [outgoing, 'stroke-dasharray'], [outgoing, 'stroke-dashoffset'], [outgoing, 'opacity'],
    ].map(([node, name]) => [node, name, node.style.getPropertyValue(name), node.style.getPropertyPriority(name)]),
  };
  let frame = 0;
  let startedAt = null;
  let visible = false;
  let played = reducedMotion.matches;
  let running = false;
  let destroyed = false;
  let shownBeat = -1;
  let shownState = '';
  let lastIncoming = '';
  let lastOutgoing = '';
  let lastImpact = '';

  // With pathLength=100, this is one short packet with no repeating dash.
  incoming.style.strokeDasharray = '9 100';
  outgoing.style.strokeDasharray = '9 100';

  function progress(value) {
    return Math.max(0, Math.min(1, value));
  }

  function paths(input, output, impact) {
    const nextIncoming = input.toFixed(4);
    const nextOutgoing = output.toFixed(4);
    const nextImpact = impact.toFixed(4);
    if (nextIncoming !== lastIncoming) {
      lastIncoming = nextIncoming;
      art.style.setProperty('--trace-in', nextIncoming);
      incoming.style.strokeDashoffset = String(9 - 100 * input);
    }
    if (nextOutgoing !== lastOutgoing) {
      lastOutgoing = nextOutgoing;
      art.style.setProperty('--trace-out', nextOutgoing);
      outgoing.style.strokeDashoffset = String(9 - 100 * output);
      outgoing.style.opacity = output > 0 ? '1' : '0';
    }
    if (nextImpact !== lastImpact) {
      lastImpact = nextImpact;
      art.style.setProperty('--trace-impact', nextImpact);
    }
  }

  function labels(index, state) {
    const beat = beats[index];
    if (shownBeat !== index) {
      request.textContent = beat.request;
      shownBeat = index;
    }
    if (shownState !== state) {
      verdict.textContent = state === 'checking' ? 'Checking request' : beat.verdict;
      art.dataset.trace = state;
      shownState = state;
    }
  }

  function stop() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    startedAt = null;
    running = false;
  }

  function rest() {
    stop();
    labels(0, 'blocked');
    paths(1, 0, 0);
  }

  function draw(elapsed) {
    const index = elapsed < beats[1].start ? 0 : elapsed < beats[2].start ? 1 : 2;
    const beat = beats[index];
    const local = elapsed - beat.start;
    const checked = local >= travelDuration;
    const input = progress(local / travelDuration);
    const output = checked && beat.state === 'allowed' ? progress((local - travelDuration) / 420) : 0;
    const impact = checked ? Math.sin(Math.PI * progress((local - travelDuration) / 280)) : 0;
    labels(index, checked ? beat.state : 'checking');
    paths(input, output, impact);
  }

  function tick(timestamp) {
    frame = 0;
    if (destroyed || !running) return;
    if (!visible || document.hidden || reducedMotion.matches) { rest(); return; }
    if (startedAt === null) startedAt = timestamp;
    const elapsed = timestamp - startedAt;
    if (elapsed >= duration) { rest(); return; }
    draw(elapsed);
    frame = requestAnimationFrame(tick);
  }

  function replay() {
    if (destroyed) return;
    played = true;
    stop();
    if (reducedMotion.matches || !visible || document.hidden) { rest(); return; }
    running = true;
    draw(0);
    frame = requestAnimationFrame(tick);
  }

  function visibilityChanged() {
    if (document.hidden || !visible) rest();
    else if (!played) replay();
  }

  function preferenceChanged() {
    if (reducedMotion.matches) { played = true; rest(); }
  }

  function viewportChanged() {
    const bounds = art.getBoundingClientRect();
    visible = bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.right > 0
      && bounds.top < window.innerHeight && bounds.left < window.innerWidth;
    visibilityChanged();
  }

  const observer = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    if (destroyed) return;
    visible = entries[0].isIntersecting;
    visibilityChanged();
  }, { threshold: 0 }) : null;

  rest();
  if (observer) observer.observe(art);
  else {
    window.addEventListener('scroll', viewportChanged, { passive: true });
    window.addEventListener('resize', viewportChanged, { passive: true });
    viewportChanged();
  }
  // Native button clicks include Enter and Space without duplicate key handlers.
  art.addEventListener('click', replay);
  document.addEventListener('visibilitychange', visibilityChanged);
  window.addEventListener('pagehide', rest);
  reducedMotion.addEventListener('change', preferenceChanged);

  const controller = {
    replay,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
      observer?.disconnect();
      window.removeEventListener('scroll', viewportChanged);
      window.removeEventListener('resize', viewportChanged);
      art.removeEventListener('click', replay);
      document.removeEventListener('visibilitychange', visibilityChanged);
      window.removeEventListener('pagehide', rest);
      reducedMotion.removeEventListener('change', preferenceChanged);
      request.textContent = original.request;
      verdict.textContent = original.verdict;
      if (original.state === null) delete art.dataset.trace;
      else art.setAttribute('data-trace', original.state);
      for (const [node, name, value, priority] of original.styles) {
        if (value) node.style.setProperty(name, value, priority);
        else node.style.removeProperty(name);
      }
      art.disabled = wasDisabled;
      if (originalTabIndex === null) art.removeAttribute('tabindex');
      else art.setAttribute('tabindex', originalTabIndex);
      mounts.delete(art);
    },
  };
  mounts.set(art, controller);
  return controller;
}
