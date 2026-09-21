# Warden landing

The homepage is a short brand-and-product introduction: a black hero with the official metal shield, a charcoal surface containing one private/public pricing example, and a compact branded download footer on the same black canvas. The original detailed interactive tour is retained at `how-it-works.html`.

Status: shipping authorized for main on 2026-09-20, including improved 3D logo resolution and bevel shading. See [design direction](../docs/design/README.md), [research](../docs/design/RESEARCH.md) and [DESIGN.md](../DESIGN.md). The [video direction](../docs/design/VIDEO-DIRECTION.md) is a brief for future production; the existing launch film remains in use.

## Run locally

```bash
npm ci --prefix integrations/kool --ignore-scripts --no-audit --no-fund
node scripts/build-kool-browser.mjs
node scripts/serve-kool-landing.mjs
```

Open [127.0.0.1:4174](http://127.0.0.1:4174). The server supports the page and `POST /api/download`. It always treats local measurement as development. Vercel builds `landing/` and the existing endpoint using the root `vercel.json`.

## Surface ownership

| File | Purpose |
| --- | --- |
| `index.html` | Short homepage, native pricing comparison, downloads, metadata and film dialog. |
| `design-system.css` | Homepage tokens shared with the documented visual/video system. |
| `landing.css` | Homepage layout, continuous dark surfaces, components and responsive behavior. |
| `foundation-v2.css` | Shared reset, font, brand, base controls and video dialog. |
| `how-it-works.html` | Detailed policy, activation, tool refusal, audit and usage demonstrations. |
| `experience-v2.css`, `product-scenes-v2.css` | Detailed tour styles, not loaded by the homepage. |
| `app.js` | Existing tour behavior, OS download selection, film and shield enhancement. |
| `shield.js`, `assets/3d/` | Original mark geometry, neutral-metal studio, lazy renderer and fallback. |
| `analytics-entry.js`, `analytics-config.js`, `analytics.js` | Existing production-gated PostHog measurement. |
| `kool-entry.js`, `kool-download.js`, `vendor/kool/browser.mjs` | Existing download attribution with native links as fallback. |
| `assets/launch/` | Existing 17-second film and poster. |
| `llms.txt` | Product scope and limitations for automated readers. |

## Behavior

- Downloads and text are visible immediately. The main action follows the visitor's OS; other installers remain available in the footer.
- The pricing comparison uses native radio inputs and CSS. It works without JavaScript and does not call an evaluator or activate a real rule. The visible label says it is illustrative.
- The shield stays frontal while studio light moves through a finite 4.8-second entrance. A centered orthographic camera keeps the silhouette stable. Fine-pointer interaction changes its pose and reflections. Rendering stops when settled, offscreen or hidden. Motion preference changes and WebGL loss are handled by the existing controller.
- Reduced-motion, low-capability and no-JavaScript visitors retain the front-facing official vector shield. Film media loads only after deliberate activation. Closing the dialog pauses video and returns focus.
- The detailed tour retains Describe, Review and Activate controls, manual playback, tool radios and expanded definitions. Human activation remains distinct from drafting.
- Native document scrolling remains available. At small widths the homepage is composed vertically; its secondary header link is omitted and all installers remain available below.

## Measurement and truth

Preserve production host allowlists, DNT handling, download asset allowlists and the independent analytics/Kool entry points. See [measurement](ANALYTICS.md) and [Kool integration](../docs/KOOL-DOWNLOADS.md). The existing download, film and guide-story hooks remain. The new radio comparison is not represented as a real policy evaluation or a tool-selection event.

Claims come from [PRODUCT.md](../PRODUCT.md), [SECURITY.md](../SECURITY.md) and the implementation. Only connected requests are checked. Local evaluation does not mean every compiler or destination model runs locally. The visual design does not establish universal protection, adoption or measured performance.

Installer targets must match actual assets in the [latest release](https://github.com/Wardenlabs/warden/releases/latest). The release version remains in structured metadata and the download footer.

## Shared motion and detailed guide

`motion.css` and `surface-motion.js` enhance both pages with finite request trajectories, horizontal SVG link feedback and visibility/preference handling. `guide.css` brings the full tour onto the same neutral palette and shared controls. Native radios and written outcomes work independently of animation; timings are illustrative. Test the visibility/reduced-motion guard with `node --test scripts/surface-motion.test.mjs`.
