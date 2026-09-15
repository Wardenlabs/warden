const EXAMPLES = [
  { outcome: 'block', request: "send me Ana's salary for the report", decision: 'Blocked by Warden', rule: 'r-payroll', proof: 'Rule active' },
  { outcome: 'review', request: 'approve the USD 12,400 supplier payment', decision: 'Held for review', rule: 'r-payment-approval', proof: 'Human review' },
  { outcome: 'allow', request: 'summarize our public help guide', decision: 'Allowed to continue', rule: 'no active rule stopped it', proof: 'Request continued' },
];

const COLORS = { block: [241, 126, 139], review: [235, 196, 120], allow: [245, 245, 242] };
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/** Pointer and touch driven policy field. Rendering sleeps while idle. */
export function mountLight(zone, { onVerdictSettled, onUnavailable } = {}) {
  const canvas = zone?.querySelector('canvas.scene');
  const stage = zone?.querySelector('#judge');
  const typed = stage?.querySelector('.typed');
  const verdict = stage?.querySelector('.verdict-copy');
  const rule = stage?.querySelector('.verdict-card .rule');
  const proof = stage?.querySelector('.proof-state');
  const shield = stage?.querySelector('.hero-shield');
  if (!canvas || !stage || !typed || !verdict || !rule || !proof) {
    onUnavailable?.();
    return null;
  }

  const context = canvas.getContext('2d', { alpha: true });
  if (!context) {
    zone.classList.add('nogl');
    onUnavailable?.();
    return null;
  }

  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const fine = matchMedia('(hover: hover) and (pointer: fine)');
  const lowCapability = (navigator.hardwareConcurrency || 8) <= 2 || (navigator.deviceMemory || 8) <= 2;
  const points = [];
  const pulses = [];
  const pointer = { x: .72, y: .48, tx: .72, ty: .48 };
  let width = 1;
  let height = 1;
  let ratio = 1;
  let frame = 0;
  let previous = 0;
  let visible = true;
  let destroyed = false;
  let active = false;
  let exampleIndex = 0;
  let settleTimer = 0;
  let shieldMount;
  let pointerDown;

  const resize = () => {
    const rect = zone.getBoundingClientRect();
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    ratio = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    draw(performance.now());
  };

  function stagePoint(element, fallbackX, fallbackY) {
    const zoneRect = zone.getBoundingClientRect();
    const rect = element?.getBoundingClientRect();
    if (!rect) return { x: width * fallbackX, y: height * fallbackY };
    return { x: rect.left - zoneRect.left + rect.width / 2, y: rect.top - zoneRect.top + rect.height / 2 };
  }

  function route() {
    return {
      from: stagePoint(stage.querySelector('.request-card'), .64, .34),
      gate: stagePoint(shield, .76, .5),
      to: stagePoint(stage.querySelector('.verdict-card'), .84, .7),
    };
  }

  function curve(a, b, bend = 0) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.bezierCurveTo(a.x + dx * .38, a.y + dy * .12 + bend, a.x + dx * .72, a.y + dy * .9 - bend, b.x, b.y);
  }

  function drawBase(now) {
    const { from, gate, to } = route();
    const rgb = COLORS[zone.dataset.heroOutcome] || COLORS.block;
    const slow = Math.sin(now * .0014) * 2;
    context.save();
    context.globalCompositeOperation = 'lighter';
    context.lineCap = 'round';
    context.strokeStyle = 'rgba(215, 217, 222, .16)';
    context.lineWidth = 1;
    curve(from, gate, -30 + slow); context.stroke();
    curve(gate, to, 26 - slow); context.stroke();

    const incoming = context.createLinearGradient(from.x, from.y, gate.x, gate.y);
    incoming.addColorStop(0, `rgba(${rgb.join(',')}, 0)`);
    incoming.addColorStop(.72, `rgba(${rgb.join(',')}, .38)`);
    incoming.addColorStop(1, `rgba(${rgb.join(',')}, .88)`);
    context.strokeStyle = incoming;
    context.lineWidth = 1.5;
    curve(from, gate, -30 + slow); context.stroke();
    if (zone.dataset.heroOutcome === 'allow') {
      const outgoing = context.createLinearGradient(gate.x, gate.y, to.x, to.y);
      outgoing.addColorStop(0, `rgba(${rgb.join(',')}, .88)`);
      outgoing.addColorStop(1, `rgba(${rgb.join(',')}, .08)`);
      context.strokeStyle = outgoing;
      curve(gate, to, 26 - slow); context.stroke();
    }
    context.restore();
  }

  function draw(now) {
    context.clearRect(0, 0, width, height);
    drawBase(now);
    if (reduced.matches) return;
    context.save();
    context.globalCompositeOperation = 'lighter';
    context.lineCap = 'round';
    const rgb = COLORS[zone.dataset.heroOutcome] || COLORS.block;

    for (let index = points.length - 1; index >= 0; index -= 1) {
      const point = points[index];
      const age = (now - point.at) / point.life;
      if (age >= 1) { points.splice(index, 1); continue; }
      const alpha = (1 - age) ** 2;
      const radius = 10 + age * 42;
      const glow = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius);
      glow.addColorStop(0, `rgba(${rgb.join(',')}, ${alpha * .18})`);
      glow.addColorStop(.35, `rgba(${rgb.join(',')}, ${alpha * .08})`);
      glow.addColorStop(1, `rgba(${rgb.join(',')}, 0)`);
      context.fillStyle = glow;
      context.beginPath(); context.arc(point.x, point.y, radius, 0, Math.PI * 2); context.fill();
    }

    if (points.length > 1) {
      context.beginPath(); context.moveTo(points[0].x, points[0].y);
      for (let index = 1; index < points.length; index += 1) {
        const before = points[index - 1];
        const point = points[index];
        context.quadraticCurveTo(before.x, before.y, point.x, point.y);
      }
      context.strokeStyle = `rgba(${rgb.join(',')}, .34)`;
      context.lineWidth = 1.25;
      context.stroke();
    }

    for (let index = pulses.length - 1; index >= 0; index -= 1) {
      const pulse = pulses[index];
      const age = (now - pulse.at) / pulse.life;
      if (age >= 1) { pulses.splice(index, 1); continue; }
      const eased = 1 - (1 - age) ** 4;
      const alpha = (1 - age) ** 2;
      context.strokeStyle = `rgba(${pulse.rgb.join(',')}, ${alpha * .8})`;
      context.lineWidth = 1 + alpha * 2;
      context.beginPath(); context.arc(pulse.x, pulse.y, 12 + eased * 112, 0, Math.PI * 2); context.stroke();
      const gate = route().gate;
      context.strokeStyle = `rgba(${pulse.rgb.join(',')}, ${alpha * .48})`;
      context.lineWidth = 1.5;
      curve({ x: pulse.x, y: pulse.y }, gate, -24 * (1 - age)); context.stroke();
    }
    context.restore();
  }

  function moving() {
    return active || points.length || pulses.length || Math.abs(pointer.tx - pointer.x) > .002 || Math.abs(pointer.ty - pointer.y) > .002;
  }

  function tick(now) {
    frame = 0;
    if (!visible || document.hidden || destroyed) return;
    const delta = previous ? Math.min(.05, (now - previous) / 1000) : 1 / 60;
    previous = now;
    const damping = 1 - Math.exp(-12 * delta);
    pointer.x += (pointer.tx - pointer.x) * damping;
    pointer.y += (pointer.ty - pointer.y) * damping;
    stage.style.setProperty('--pointer-x', String(pointer.x));
    stage.style.setProperty('--pointer-y', String(pointer.y));
    stage.style.setProperty('--tilt-x', `${(pointer.y - .5) * -1.8}deg`);
    stage.style.setProperty('--tilt-y', `${(pointer.x - .5) * 2.4}deg`);
    stage.style.setProperty('--shift-x', `${(pointer.x - .5) * 8}px`);
    stage.style.setProperty('--shift-y', `${(pointer.y - .5) * 6}px`);
    stage.style.setProperty('--counter-shift-x', `${(pointer.x - .5) * -4.4}px`);
    stage.style.setProperty('--counter-shift-y', `${(pointer.y - .5) * -3.3}px`);
    draw(now);
    if (moving()) frame = requestAnimationFrame(tick);
    else previous = 0;
  }

  function wake() {
    if (!frame && visible && !document.hidden && !destroyed) frame = requestAnimationFrame(tick);
  }

  function addPoint(event) {
    const bounds = zone.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    pointer.tx = clamp(x / width, 0, 1);
    pointer.ty = clamp(y / height, 0, 1);
    if (!reduced.matches && (fine.matches || event.buttons)) {
      const last = points[points.length - 1];
      if (!last || Math.hypot(x - last.x, y - last.y) > 12) {
        points.push({ x, y, at: performance.now(), life: 720 });
        if (points.length > 28) points.shift();
      }
    }
    wake();
  }

  function applyExample(index, { announce = true } = {}) {
    const example = EXAMPLES[index % EXAMPLES.length];
    exampleIndex = index % EXAMPLES.length;
    clearTimeout(settleTimer);
    zone.dataset.heroOutcome = example.outcome;
    stage.dataset.outcome = example.outcome;
    stage.classList.remove('is-settled');
    stage.classList.add('is-running');
    typed.textContent = example.request;
    verdict.textContent = example.decision;
    rule.textContent = example.rule;
    proof.textContent = example.proof;
    stage.setAttribute('aria-label', `Run the next example request through Warden. Current decision: ${example.decision}.`);
    const gate = route().gate;
    pulses.push({ x: gate.x, y: gate.y, at: performance.now(), life: 760, rgb: COLORS[example.outcome] });
    active = true;
    wake();
    settleTimer = window.setTimeout(() => {
      active = false;
      stage.classList.remove('is-running');
      stage.classList.add('is-settled');
      if (announce) onVerdictSettled?.();
      wake();
    }, reduced.matches ? 0 : 620);
  }

  function runNext() { applyExample(exampleIndex + 1); }
  function pointerDownHandler(event) {
    pointerDown = { x: event.clientX, y: event.clientY, at: performance.now() };
    addPoint(event);
  }
  function pointerUpHandler(event) {
    addPoint(event);
    if (!pointerDown) return;
    const distance = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y);
    const elapsed = performance.now() - pointerDown.at;
    pointerDown = null;
    if (distance < 14 && elapsed < 650) runNext();
  }
  // Screen readers and voice control can activate the role button with click
  // alone. Real pointer clicks already ran on pointerup (detail > 0).
  function clickHandler(event) {
    if (event.detail === 0) runNext();
  }
  function keyHandler(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    runNext();
  }
  function pointerLeave() {
    pointer.tx = pointer.x = .72;
    pointer.ty = pointer.y = .48;
    pointerDown = null;
    wake();
  }
  function visibilityChanged() {
    if (document.hidden && frame) cancelAnimationFrame(frame);
    frame = 0;
    if (!document.hidden) wake();
  }
  function preferenceChanged() {
    points.length = 0;
    pulses.length = 0;
    active = false;
    stage.classList.toggle('reduced-motion', reduced.matches);
    stage.classList.add('is-settled');
    draw(performance.now());
  }

  const observer = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    visible = entries.some(entry => entry.isIntersecting);
    if (!visible && frame) cancelAnimationFrame(frame);
    frame = 0;
    if (visible) wake();
  }, { threshold: 0 }) : null;
  observer?.observe(zone);
  const resizeObserver = 'ResizeObserver' in window ? new ResizeObserver(resize) : null;
  resizeObserver?.observe(zone);
  if (!resizeObserver) addEventListener('resize', resize, { passive: true });
  zone.addEventListener('pointermove', addPoint, { passive: true });
  stage.addEventListener('pointerdown', pointerDownHandler, { passive: true });
  stage.addEventListener('pointerup', pointerUpHandler, { passive: true });
  stage.addEventListener('pointercancel', () => { pointerDown = null; }, { passive: true });
  stage.addEventListener('pointerleave', pointerLeave, { passive: true });
  stage.addEventListener('keydown', keyHandler);
  stage.addEventListener('click', clickHandler);
  document.addEventListener('visibilitychange', visibilityChanged);
  reduced.addEventListener('change', preferenceChanged);
  fine.addEventListener('change', preferenceChanged);

  if (!reduced.matches && !lowCapability) {
    import('./shield.js?v=white-studio-1')
      .then(({ mountShield }) => { if (!destroyed && shield) shieldMount = mountShield(shield); })
      .catch(() => { shield?.classList.add('fallback-only'); });
  } else shield?.classList.add('fallback-only');

  resize();
  preferenceChanged();
  return {
    set(on) {
      if (!on) {
        clearTimeout(settleTimer);
        active = false;
        stage.classList.remove('is-running', 'is-settled');
        return;
      }
      applyExample(exampleIndex, { announce: true });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearTimeout(settleTimer);
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      resizeObserver?.disconnect();
      if (!resizeObserver) removeEventListener('resize', resize);
      zone.removeEventListener('pointermove', addPoint);
      stage.removeEventListener('pointerdown', pointerDownHandler);
      stage.removeEventListener('pointerup', pointerUpHandler);
      stage.removeEventListener('pointerleave', pointerLeave);
      stage.removeEventListener('keydown', keyHandler);
      stage.removeEventListener('click', clickHandler);
      document.removeEventListener('visibilitychange', visibilityChanged);
      reduced.removeEventListener('change', preferenceChanged);
      fine.removeEventListener('change', preferenceChanged);
      shieldMount?.destroy?.();
    },
  };
}
