/*
 * The light.
 *
 * This is the whole of it. Nothing else on the page imports from here and
 * nothing here reaches outside `.hero-zone`, so this file is the seam: swap
 * it and the rest of the landing does not notice.
 *
 * One hairline below the hero's call to action — the gate — drawn on a
 * canvas so it can be a light rather than a border: a crisp line that
 * emits a little into the dark above it. It is warm white while prompts
 * pass. When one is blocked the colour runs from the centre of the line to
 * its edges, like a signal along a wire, and fades back once the next
 * prompt starts typing. app.js decides *when*; this file only draws.
 *
 * The cursor is the one other thing it answers to: passing over the line
 * brightens it a little where the pointer is, and the glow follows. Nothing
 * else on the page reacts to the mouse.
 *
 * One pass, no framebuffers. The colours are read from :root — `--bg`,
 * `--gate`, `--block` — so the line is the same coral as the verdict chip
 * and the canvas floor is exactly the page's ground. Nothing literal here.
 */

const VS = `#version 300 es
in vec2 p; out vec2 v;
void main(){ v = p * .5 + .5; gl_Position = vec4(p, 0., 1.); }`;

const FS = `#version 300 es
precision highp float; in vec2 v; out vec4 o;
uniform vec2 R; uniform float T, Y0, S, GLOW, FRONT, HOVER, HX; uniform vec3 BASE, WARM, CORAL;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main(){
  vec2 px = vec2(v.x, 1. - v.y) * R;
  float dy = px.y - Y0;
  float xn = abs(px.x - .5 * R.x) / (.5 * R.x);        // 0 at the centre, 1 at the edge
  float xf = 1. - smoothstep(.60, 1., xn);              // the line fades toward the edges
  float br = 1. + .03 * sin(T * .5);                    // it breathes, barely
  // how much of the verdict this pixel of the line has taken: the front runs outward
  float k = GLOW * (1. - smoothstep(FRONT - .12, FRONT + .02, xn));
  // a little more light under the cursor: a soft bump along the line, nothing that moves the line
  float h = HOVER * exp(-pow((px.x - HX) / (.085 * R.x), 2.));
  // the hairline. White it saturates; turned, it drops below white so the colour reads in the line itself
  float line = exp(-abs(dy) / (S * (1. + .6 * h))) * (mix(1.4, .62, k) + .35 * h) * xf * br;
  float glow = (dy < 0. ? exp(dy / (.075 * R.y)) * .026 : exp(-dy / (.02 * R.y)) * .010) * xf * br;
  glow *= (1. + 1.6 * k) * (1. + 1.1 * h);              // it flares where it has turned, and a touch under the cursor
  vec3 col = BASE + mix(WARM, CORAL, k) * (line + glow);
  col = pow(col, vec3(1. / 2.2));
  col += (hash(gl_FragCoord.xy + fract(T) * 91.) - .5) * (1.5 / 255.);                                  // dither: no banding
  col += (hash(gl_FragCoord.xy * 1.37 + fract(T * .7) * 53.) - .5) * .012 * (1. - clamp(line, 0., 1.)); // grain, barely
  o = vec4(col, 1.); }`;

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* a CSS hex colour → linear RGB, which is what the shader adds in */
function linear(hex) {
  const h = hex.trim().replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => Math.pow(parseInt(n.slice(i, i + 2), 16) / 255, 2.2));
}

export function mountLight(host) {
  if (!host) return null;
  const canvas = host.querySelector('canvas.scene');
  const gate = host.querySelector('.gate');
  if (!canvas || !gate) return null;

  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false });
  if (!gl) { host.classList.add('nogl'); return null; }

  const css = getComputedStyle(document.documentElement);
  const tone = (name) => linear(css.getPropertyValue(name));

  const mk = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, mk(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, FS));
  gl.bindAttribLocation(prog, 0, 'p');
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));

  const u = {};
  for (const n of ['R', 'Y0', 'S', 'T', 'GLOW', 'FRONT', 'HOVER', 'HX', 'BASE', 'WARM', 'CORAL']) u[n] = gl.getUniformLocation(prog, n);

  gl.bindVertexArray(gl.createVertexArray());
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  gl.useProgram(prog);
  gl.uniform3fv(u.BASE, tone('--bg'));
  gl.uniform3fv(u.WARM, tone('--gate'));
  gl.uniform3fv(u.CORAL, tone('--block'));

  const state = {
    W: 0, H: 0, S: 1, y0: 0,
    t0: performance.now(),
    visible: true, raf: 0,
    glow: reduced ? 1 : 0, want: reduced ? 1 : 0, front: reduced ? 1.3 : 0,
    // the pointer: where it is along the line (device px), and how near the line it is (0..1, eased)
    hx: 0, hxWant: 0, hover: 0, hoverWant: 0,
  };

  const resize = () => {
    const hr = host.getBoundingClientRect(), gr = gate.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.round(hr.width * dpr), H = Math.round(hr.height * dpr);
    if (!W || !H) return;
    canvas.width = W; canvas.height = H;
    state.W = W; state.H = H; state.S = dpr;
    // the line is drawn where the layout put the gate
    state.y0 = (gr.top - hr.top + gr.height / 2) * dpr;
  };

  // Within this many CSS px of the line, the cursor counts as "on" it.
  const REACH = 72;
  host.addEventListener('pointermove', (e) => {
    const hr = host.getBoundingClientRect();
    state.hxWant = (e.clientX - hr.left) * state.S;
    const dy = Math.abs((e.clientY - hr.top) * state.S - state.y0) / state.S;
    state.hoverWant = dy < REACH ? 1 - dy / REACH * .5 : 0;
  }, { passive: true });
  host.addEventListener('pointerleave', () => { state.hoverWant = 0; }, { passive: true });

  const frame = (now) => {
    const t = reduced ? 0 : (now - state.t0) / 1000;
    // the bump follows the cursor with a little lag, and fades rather than snaps
    if (state.hover < .01) state.hx = state.hxWant; else state.hx += (state.hxWant - state.hx) * .18;
    state.hover += (state.hoverWant - state.hover) * (state.hoverWant > state.hover ? .12 : .06);
    // in quickly, out slowly
    state.glow += (state.want - state.glow) * (state.want > state.glow ? .06 : .02);
    // the front runs out once the verdict lands, and only resets after the colour has faded
    if (state.want) state.front += (1.3 - state.front) * .05;
    else if (state.glow < .02) state.front = 0;
    gl.viewport(0, 0, state.W, state.H);
    gl.uniform2f(u.R, state.W, state.H);
    gl.uniform1f(u.Y0, state.y0); gl.uniform1f(u.S, state.S);
    gl.uniform1f(u.T, t); gl.uniform1f(u.GLOW, state.glow); gl.uniform1f(u.FRONT, state.front);
    gl.uniform1f(u.HOVER, reduced ? 0 : state.hover); gl.uniform1f(u.HX, state.hx);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const loop = () => {
    if (state.raf) return;
    const tick = (now) => {
      state.raf = 0;
      if (!state.visible) return;
      frame(now);
      if (reduced) return;
      state.raf = requestAnimationFrame(tick);
    };
    state.raf = requestAnimationFrame(tick);
  };

  new ResizeObserver(resize).observe(host);
  new IntersectionObserver((entries) => {
    state.visible = entries[0].isIntersecting;
    if (state.visible) loop();
  }, { threshold: .02 }).observe(host);

  resize();
  loop();

  return {
    /* true while the prompt on screen is blocked */
    set(blocked) { state.want = blocked ? 1 : 0; },
  };
}
