# Brand assets

The mark is a shield with a W inside it. Everything here is derived from one
source file, so there is one place to change if the logo changes.

| File | What it is | Where it is used |
|---|---|---|
| `warden-lockup-source.png` | The original raster the logo was delivered as. Provenance only — nothing reads it. | — |
| `warden-mark.svg` | Shield + W alone, `fill="currentColor"`, square viewBox, holes as `fill-rule="evenodd"`. 2.3 KB. | Inlined in `web/index.html` header |
| `warden-lockup.svg` | Mark + "warden" wordmark, `fill="currentColor"`. 5.7 KB. | The master for anything that can set its own colour |
| `warden-lockup-light.svg` | Lockup with `#141414` baked in. | `README.md`, light backgrounds |
| `warden-lockup-dark.svg` | Lockup with `#f0f0f2` baked in. | `README.md` dark mode, dark backgrounds |
| `warden-favicon.svg` | The mark knocked out of a dark rounded square. | Inlined as a data URI in `web/index.html` |

## PNGs for anywhere that will not take an SVG

Submission forms, slide decks, and app stores. All of them are rendered from
`warden-mark.svg` / `warden-lockup.svg`, never resampled from the source raster.

| File | Size | Background |
|---|---|---|
| `warden-lockup.png` | 2400 x 879 | transparent |
| `warden-lockup-on-white.png` | 2400 x 879 | white |
| `warden-lockup-on-dark.png` | 2400 x 879 | `#17181c` |
| `warden-mark.png` | 1024 x 1024 | transparent |
| `warden-icon-512/180/32/16.png` | square | the dark badge |

Transparency was recovered by mapping luminance to alpha (`alpha = 255 - L`),
which is exact here and only here: the render is pure greyscale black on pure
white, so every partly-covered edge pixel carries its own coverage. Do not reuse
that step on artwork that has real colour in it.

## Why the favicon is a badge and not the bare mark

The shield is an outline, and its stroke is about 7% of the mark's width — at
16 px that is roughly one pixel, and the W inside it turns to mush. Putting the
mark in white on a dark tile keeps it readable at tab size. The console already
did this with a lettered tile; only the letter changed.

## Why the favicon is inlined rather than linked

From the comment it replaced in `web/index.html`:

> a console for a product whose claim is "nothing leaves the machine" should
> not be fetching an icon over the network.

The same reasoning is why the header mark is inline SVG and not an `<img>`.
`web/` is one HTML file and one ES module with no build step; adding a fetched
asset to it would break both properties at once.

## Colour

The SVGs carry no colour of their own except the two lockups with a fill baked
in for GitHub. In the console the mark inherits `var(--accent)`, which keeps the
rule stated at the top of `web/index.html`: no literal colour appears outside
`:root`.

## Regenerating

`warden-mark.svg` and `warden-lockup.svg` were traced from the source PNG with
`fal-ai/recraft/vectorize`, then split on the x-gap between the shield and the
wordmark, re-fitted to tight viewBoxes, and had their white counter shapes
merged into their parents as even-odd holes. If the logo is redrawn, replace the
source and redo those three steps — the counters are the part that silently goes
wrong, because a counter left as a white shape looks correct on white and turns
into a white blob on the console's dark surfaces.
