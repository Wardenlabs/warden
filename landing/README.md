# Warden website

The site is static HTML, CSS and browser modules. The home introduces Warden,
`/how-it-works` walks through a rule, and `/docs` explains connections, privacy
and deployment. Both product pages use the official shield, Manrope and a
continuous black background. The footer closes with the full-width lockup.

## Develop and verify

From the repository root:

```sh
npm ci --prefix integrations/kool --ignore-scripts --no-audit --no-fund
node scripts/serve-kool-landing.mjs
```

Open http://127.0.0.1:4174. The local server supports clean URLs, applies the
production security headers and handles `/api/download` in test mode.
The website itself needs no gateway or model download.

```sh
pnpm run landing:metadata
pnpm run landing:check
pnpm run landing:build
```

Vercel installs only the isolated Kool integration and publishes `.landing-dist/`.
The build copies public assets and pages; repository Markdown, runtime state and
social-card source are excluded. Preview builds use `noindex` and block crawling.
Generated output stays out of Git. The serverless download handler remains at
`api/download.mjs`; its ingest credential belongs in deployment environment
variables, never in this directory.

## Edit the right source

| Source | Owns |
| --- | --- |
| `index.html`, `landing.css` | Home content and native pricing comparison |
| `how-it-works.html`, `guide.css` | Manual Describe, Review, Activate sequence and chapter alignment |
| `foundation-v2.css`, `design-system.css` | Shared font, base controls and design tokens |
| `footer.css` | Shared download composition and official closing lockup |
| `docs.html`, `docs.css` | Readable product reference with links to source evidence |
| `app.js`, `bootstrap.js` | Walkthrough controls, film, platform selection and readable fallback |
| `shield.js`, `assets/3d/` | Vector geometry, WebGL renderer and lifecycle |
| `motion.css`, `surface-motion.js` | Request paths and reduced-motion handling |
| `../scripts/landing/site.mjs` | Canonical origin, page titles, descriptions and social-card mapping |
| `../scripts/landing/metadata.mjs` | Generated head metadata, sitemap and crawler policy |
| `../scripts/render-social-card.mjs` | Reproducible PNG cards using official vectors and the local font |
| `../scripts/landing/security.mjs` | Browser security policy, mirrored in `vercel.json` and tested |

Do not hand-edit the generated metadata blocks. After changing site identity or
`package.json`’s version, run `pnpm run landing:metadata`. When changing the origin,
update the analytics host allowlist, bootstrap collector gate and links in
`llms.txt` too. Changing the origin does not configure DNS or Vercel aliases.

To regenerate the 1200 × 630 share images, install root dependencies and run
`pnpm run landing:cards`. Their versioned filenames avoid stale social previews.
Each PNG must remain below 300 KB. `social-card.html` is a local preview of those
images and is not deployed.

## Interaction and accessibility

Pricing radios work without JavaScript. The walkthrough only advances when the
visitor chooses a step or action, announces changes and keeps focus usable.
Neither page submits real policy instructions or activates rules.

The shield starts frontal, then turns gently; its controller stops rendering
when hidden, offscreen or reduced motion applies. The vector fallback remains
available without WebGL. The film loads after activation, pauses on close and
returns focus. Keep downloads as native links when enhancing them.

Check the home, guide and docs at 1440, 390 and 320 pixels. Exercise keyboard
navigation, all rule steps, pricing radios and the film dialog. Confirm there
is no horizontal overflow or console/CSP error. Automated coverage checks
metadata, local links, PNG dimensions, production output, preview indexing,
analytics boundaries, downloads and animation lifecycles.

## Measurement and release

[Analytics](ANALYTICS.md) describes PostHog’s event allowlist and privacy controls.
[Kool downloads](../docs/KOOL-DOWNLOADS.md) documents the bounded server handler.
Both keep installer navigation independent of successful measurement.

Before deployment, verify the current installer names in GitHub Releases. After
Vercel publishes, check the canonical URLs, image responses, security headers
and a nonexistent URL’s 404 response. See [production verification](../docs/WEBSITE-PRODUCTION.md).

The [design system](../DESIGN.md), [taste decisions](../docs/design/TASTE.md) and
[video direction](../docs/design/VIDEO-DIRECTION.md) keep future work consistent.
