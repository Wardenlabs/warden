# landing

The public site. Static files, no build step, no dependencies — the same shape
as `web/`, for the same reason: there is nothing here that a bundler would earn
its place doing.

| File | What it is |
|---|---|
| `index.html` | Structure and copy. The mark and wordmark are inlined from `brand/`, path for path. |
| `styles.css` | The whole design system. `:root` first, then everything that reads from it. |
| `app.js` | The prompt that types itself in the hero, reveal-on-scroll, the count-up on the two headline numbers, and naming the visitor's platform on the download button. |
| `light.js` | The light: the gate line under the hero, on a canvas. Nothing else imports from it and it touches nothing outside `.hero-zone`. |

## Why four files and not one

It was one file until the page grew a design system, four product mockups and
a light layer, at which point "one file" stopped being a property worth having
and became a 2000-line scroll. Splitting it costs nothing that the original
argument was protecting: still no bundler, still no install, still `pnpm dlx serve
landing`, still same-origin — three `<link>`/`<script>` tags to files sitting
next to the HTML is not a build step.

The one thing that does not get split is the brand. It stays inlined, because
`brand/README.md` is explicit that it is the one place the logo changes, and
because a page whose claim is "nothing leaves the machine" should not fetch an
icon over the network.

## Why it lives in this repo

Two things on this page are read from somewhere else in the tree, and both
would drift the moment they were copied into a repo of their own:

- **The brand.** Inlined from `brand/`, as above.
- **The download links.** The installers come from this repo's own CI —
  `.github/workflows/desktop.yml` publishes them to GitHub Releases on `v*`
  tags. Same repo means the button and the artifact cannot disagree.

Every number on the page is from `REPORT.md` and `BENCHMARKS.md`. When those
are regenerated, the page is stale until someone updates it; there is no
mechanism keeping them in sync, which is the honest tradeoff for having no
build step.

## Design

The `:root` block is the console's dark palette from `web/index.html`, on a
ground one step deeper (`#050507`) so the light has somewhere to go. The
landing is dark by design, not by system preference: there is no light theme
and no `prefers-color-scheme` block. The console's rule holds here too and is
checked before every change: **no literal colour and no literal font-size
appears outside `:root`.** Everything the landing adds is an addition to that
block —

- a display tier above `--fs-6` and a micro tier below `--fs-1`, because a
  marketing page renders the product at a quarter size and shouts at full size,
  and a dense console does the neither;
- the light tokens: `--gate`, the line's warm white, and `--beam`, the edge
  light on a product surface. `light.js` reads `--gate`, `--block` and `--bg`
  off `:root` and draws with them, which is how the canvas stays inside the
  rule too.

The verdict colours stay the only saturated thing on the page, exactly as in
the product.

### The light

Warden is a gate, so the hero has one: a hairline below the call to action,
drawn on a `<canvas>` so it can be a light rather than a border. It is warm
white while the prompt types. When it is blocked, the coral runs from the
centre of the line to its edges — a signal along a wire — and holds; the
prompt and its verdict stay on screen, there is no loop. The light is a
consequence of the product doing something, not decoration around it. The
one thing it answers to after that is the cursor: passing over the line
brightens it a little where the pointer is.

It is WebGL, one fragment shader, no framebuffers. The earlier version of this
page lit the hero with CSS — masks, gradients, blur, a grid of cells — and it
read as decoration: light with no source and no reason. A line that reacts to
the verdict has both. The canvas floor is `--bg` exactly, so the hero and the
sections below it are the same black; the line's colours are `--gate` and
`--block`, read from `:root` at mount.

Three parts, and they are the seam:

1. `.hero-zone canvas.scene` — the drawing surface, under everything.
2. `.gate` — an empty 1px element after the CTA. It marks *where* the line
   is; the canvas draws it there. Without WebGL the canvas is dropped and the
   gate draws itself in CSS, colour change included.
3. `light.js` — the shader and the easing. It exposes one method, `set(blocked)`,
   and `app.js` calls it from the typing cycle. The light never decides
   anything; it only follows.

### Motion

The prompt that types itself, reveal on scroll, one count-up, one pulsing dot,
one travelling edge light. Every one of them is off under
`prefers-reduced-motion` — the hero then shows the finished state, prompt
typed and verdict on — and the page is complete without JavaScript: the typed
prompt and its verdict are in the markup as text, `[data-reveal]` only hides
things once the script has run its observer, and the two numbers are text too.

## Checking it locally

```bash
pnpm dlx serve landing
```

## Deploying

Configured by `vercel.json` **at the repo root**, not here — so importing this
repo with Vercel's default settings just works, with nothing to remember in the
dashboard. It skips the install (532 Electron packages a static page has no use
for), skips the build, and serves this directory:

```json
"installCommand": "",
"buildCommand": "",
"outputDirectory": "landing"
```

There is deliberately no second `vercel.json` in this folder. Which one applies
depends on the project's root-directory setting, and two configs that disagree
is a problem discovered at deploy time.
