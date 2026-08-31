# landing

The public site. Static files, no build step, no dependencies — the same shape
as `web/`, for the same reason: there is nothing here that a bundler would earn
its place doing.

| File | What it is |
|---|---|
| `index.html` | Structure and copy. The mark and wordmark are inlined from `brand/`, path for path. |
| `styles.css` | The whole design system. `:root` first, then everything that reads from it. |
| `app.js` | The prompt that types itself in the hero, reveal-on-scroll, and naming the visitor's platform on the download button (the other platform is the quiet link beside it). |
| `light.js` | The light: the gate line under the hero, on a canvas. Nothing else imports from it and it touches nothing outside `.hero-zone`. |

## What is on the page

Six screens, in this order. The hero is centred and nothing else is; the five
sections hang off the same left rail, and the footer is centred again to close
the bracket the hero opened.

| | | Earns its scroll with |
|---|---|---|
| Hero | Asking a model to follow your rules is not the same as enforcing them. | the gate line, and the prompt being judged on it |
| `#block` | A refusal they can act on. | the rule as its author wrote it, and the hook's literal output |
| `#how` | It runs before the prompt leaves the machine. | `UserPromptSubmit`, and why OAuth leaves nowhere else to stand |
| `#local` | The record of a decision does not contain the prompt. | the models by name and quantization, and `pnpm run verify-audit` |
| `#numbers` | 136 of 160 attacks stopped. The baseline stopped none. | all eleven attack classes, uncut, and the 58% false-positive rate |
| `#get` | Install it on one machine, or on everyone's. | two installers, and the four commands that run it from source |

Two people open this URL: whoever is deciding, and whoever they forward it to.
The page is not written twice for them. The prose is in business language and
in sans; the evidence sits beside it in mono, in a `.receipt` line at the foot
of a section. The first reader goes past it and the second one stops there.
That split is the whole layout.

Nothing is on the page that the page cannot show: no logo strip, no
testimonials, no pricing, no versus panel, no drawn console, and no
interactive demo — the model runs on-device, so anything a browser could
demonstrate would be a fake, which is the opposite of the argument.

## Why four files and not one

It was one file until the page grew a design system, a set of product surfaces
and a light layer, at which point "one file" stopped being a property worth
having and became a 2000-line scroll. Splitting it costs nothing that the
original argument was protecting: still no bundler, still no install, still
`pnpm dlx serve landing`, still same-origin — three `<link>`/`<script>` tags to
files sitting next to the HTML is not a build step.

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
  light that runs a surface's top. `light.js` reads `--gate`, `--block` and
  `--bg` off `:root` and draws with them, which is how the canvas stays inside
  the rule too.

The verdict colours stay the only saturated thing on the page, exactly as in
the product. Below the hero they appear twice: the refusal in `#block`, and
the three verdict names in the last step of `#how`, which is the only place
the page says out loud that a verdict has three values and not two.

Six rules hold the rest of it together, and each one is a thing the page is
*not* allowed to do:

1. **The light is an event, not decoration.** The hero is its home. It appears
   exactly once below the hero, and that appearance is spent in `#block`.
2. **Saturation means a verdict.** Never a heading, never a hover, never an
   icon.
3. **Mono is the machine and sans is us.** Prompts, verdicts, rule ids, hashes,
   commands and table cells are mono. Prose is sans. There is no decorative
   mono.
4. **No shape the hero does not have.** Hairlines, text, flat faces, and cards
   that are sunken rather than floating. No shadows, no gradients, no
   illustrated icons, no drawn browser chrome.
5. **Every section earns its scroll** with something checkable: a number with
   its source, a real output, or a command that can be run.
6. **One thing per screen gets looked at first**, and which one is decided
   rather than discovered.

`:root` keeps its ramps and scales whole even where the current page uses only
part of them — a surface ramp or a type scale with a hole punched in it is
worse to work with than one with a spare rung. What does not survive is a token
invented for a single component that no longer exists.

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

Three things move: the prompt that types itself, reveal on scroll, and the
beam. Every one of them is off under `prefers-reduced-motion` — the hero then
shows the finished state, prompt typed and verdict on.

The beam is the light's one appearance below the hero. It runs the top edge of
the terminal in `#block` once, when the section arrives, and then it is over.
It is a CSS animation keyed on `.is-in`, the class the reveal observer already
sets, so it costs no JavaScript of its own. It does not loop, because the
reader learned in the hero that light here means the gate just decided, and a
light that repeated would go back to being decoration.

The page is complete without JavaScript. The typed prompt and its verdict are
in the markup as text, and `[data-reveal]` only hides anything once `.js` is on
the root element. That class is set by an inline, parser-blocking statement in
`<head>` so it wins the race against first paint — which leaves one gap it also
has to close. With scripting on but `app.js` broken, nothing would ever call
off the hiding and everything below the hero would stay invisible. So the same
inline block arms a 2.5-second watchdog: `app.js` sets `window.__wardenReady`
as its first statement, and if that flag is missing when the timer fires, `.js`
comes off and the page renders in full. Turning scripting off entirely is the
easy case — the inline statement never runs and the page is simply visible.

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
