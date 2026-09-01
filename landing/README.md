# landing

The public site. Static files, no build step, no dependencies — the same shape
as `web/`, for the same reason: there is nothing here that a bundler would earn
its place doing.

| File | What it is |
|---|---|
| `index.html` | Structure and copy. The mark and wordmark are inlined from `brand/`, path for path. |
| `styles.css` | The whole design system. `:root` first, then everything that reads from it. |
| `app.js` | The prompt that types itself in the hero, the three rules that write and compile themselves in `#how`, reveal-on-scroll, and naming the visitor's platform on the download button (the other platform is the quiet link beside it). |
| `light.js` | The light: the gate line under the hero, on a canvas. Nothing else imports from it and it touches nothing outside `.hero-zone`. |

## What is on the page

Five screens, in this order. The hero is centred and nothing else is; the
sections below it hang off the same axis, and the footer closes the bracket the
hero opened.

| | | Earns its scroll with |
|---|---|---|
| Hero | Writing the rules down is not the same as enforcing them. | the gate line, and the prompt being judged on it |
| `#gap` | Nothing checks what goes out. | the empty hook both Claude Code and Codex ship with |
| `#how` | Write a rule, it stops the request, you see that it did. | three rules compiling onto a stack, the hook's literal output in four tools, and the four models by name |
| `#spend` | A prompt that leaks nothing can still cost you. | the console's own quota cards, and the hold an over-budget session gets |
| `#download` | Install it. | two installers, from this repo's own CI |

Two people open this URL: whoever is deciding, and whoever they forward it to.
The page is not written twice for them. The prose is in business language and
in sans; the evidence sits beside it in mono, in a note at the foot of a block.
The first reader goes past it and the second one stops there. That split is the
whole layout.

Nothing is on the page that the page cannot show: no logo strip, no
testimonials, no pricing, no versus panel, and no interactive demo of the
guard — the model runs on-device, so anything a browser could demonstrate
would be a fake, which is the opposite of the argument. The two things that
*do* move on a click are a tool switch and a typing animation over content
that is already in the markup, which is a different claim.

### The rule about drawn product

Every console fragment on this page is `web/`'s own markup under `web/`'s own
rules, lifted class for class, and every terminal is the hook's literal
output. That is the whole constraint, and it is what the honesty of the page
rests on:

- The quota panel in `#spend` was briefly a row of live meters filling toward
  a ceiling. It looked better and it was a lie — the console renders the
  ceilings an administrator ratified and, on an opened decision, that person's
  count for the day. It does not draw a live gauge per role, so neither does
  this.
- Step 01 types three sentences and gets three rules, not one sentence
  producing three. The compiler takes one sentence and returns one rule; the
  loop is allowed to be quick, not to be a different product.
- The `cursor` tab shows the gateway's 403 body and not a picture of Cursor,
  because what that editor does with a 403 is not ours to draw.
- The `opencode` tab prints the same words as the other two, because it is the
  same hook — and says, on the page, that nobody has watched it abort a
  message.

If a panel here cannot be traced to a file in this repo, it does not ship.

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

- **The product's own surfaces.** Every console fragment is `web/`'s markup,
  every terminal is `integrations/warden-hook.mjs`'s output, and the compiled
  rule in `#how` is `data/seed/benchmark-policy.json` field for field. Copies
  in another repo would drift within a week and nobody would notice until a
  prospect did.

The corpus numbers were on the page and are not any more — they are one run of
`pnpm run redteam` and the page had no mechanism keeping them in sync, so the
footer links to `REPORT.md` and `BENCHMARKS.md` instead of quoting them. If
they come back, they come back with that problem unsolved, which is the thing
to decide first.

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
the product. Below the hero they appear in `#how` — coral on the refusal in
step 02, and all three named in the legend under step 03, which is the only
place the page says out loud that a verdict has three values and not two — and
once more in `#spend`, on the amber hold, which is the one screen where the
middle value is the main event rather than an entry in a legend.

Six rules hold the rest of it together, and each one is a thing the page is
*not* allowed to do:

1. **The light is an event, not decoration.** The hero is its home, and it does
   not appear below it at all any more — mounted a second time the gate stopped
   reading as a gate and started reading as a divider.
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

Below the hero, motion is only ever a thing arriving: a panel revealing, a rule
typing itself, the compiled card opening a beat after the button presses. Every
one of them is keyed on `.is-in` or on one short chain of timers in `app.js`,
none of them loops, and all of them are off under `prefers-reduced-motion` —
which shows the finished state, card open and prompt typed.

The tool switch in `#how` has no animation and no JavaScript at all. It is four
radios and `:checked ~`, so it works with scripting off, takes arrow keys for
free, and cannot be the thing that breaks.

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
