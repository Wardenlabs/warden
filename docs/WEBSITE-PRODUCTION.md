# Website production checks

Reviewed on 2026-09-21. This record covers the public website, its download
endpoint and the repository checks run alongside this change. It is not a
penetration test or a new model-accuracy evaluation.

## Search and sharing

`site.mjs` declares one canonical URL per page. The generated HTML contains
unique titles and descriptions, matching Open Graph URLs, Twitter cards and
WebPage/SoftwareApplication data. Version metadata comes from `package.json`.
The sitemap lists only public content pages; it has no invented update dates.

The home keeps its short copy. `/docs` gives people and automated readers a
linked reference for setup, coverage and data handling. `llms.txt` summarizes
that reference and points to source documentation. It is supplementary:
[Google’s AI search guidance](https://developers.google.com/search/docs/appearance/ai-features)
says ordinary search requirements apply and no special AI file or schema is
required. These changes do not guarantee indexing or citations.

The two share images use the official mark and local Manrope font. Both are
1200 × 630 PNGs generated from code, with no external font or image service.
The page head supplies absolute image URLs, MIME type, dimensions and alt text
as described by the [Open Graph protocol](https://ogp.me/).

## Browser and deployment boundaries

Executable scripts are external. The enforced CSP permits the site and the
existing PostHog script host, blocks framing and plugins, and constrains fetches
and form destinations. Style attributes remain permitted because motion changes
styles at runtime. Native installer forms can redirect to GitHub’s release CDN.
Vercel supplies HTTPS/HSTS. Camera, microphone, location, payment and USB access
are disabled by Permissions-Policy.

`build-landing.mjs` stages only public site formats and the asset trees into
`.landing-dist/`. It excludes Markdown and the local social-card preview.
`.vercelignore` additionally excludes local credentials, gateway state, models,
agent files and source video output from CLI uploads. Preview builds use
`noindex`; canonical URLs always target production.

The download handler validates same-origin form submissions, limits body size,
rejects extra fields, uses a fixed installer allowlist and checks each release
redirect. Timeouts bound installer checks and event delivery. Failure still
redirects to the fixed installer. Its tests exercise malformed input, cross-site
requests, URL containment and upstream failure; they do not simulate a completed
installation.

## Verification commands

```sh
pnpm run typecheck
pnpm test
pnpm run build
pnpm run landing:check
pnpm run landing:build
pnpm audit --prod
npm audit --prefix integrations/kool --omit=dev
```

The initial local pass completed all 28 product regression suites, typechecking
and compilation. The website suite passed 53 tests, including current metadata,
built local links/anchors, preview indexing, PNG dimensions, native download
fallback, analytics input limits and rendering lifecycle. Browser inspection
checks visual alignment and interaction separately; passing source tests alone
does not establish those.

### Dependency audit qualifications

The production audit reports two high-severity advisories against
`extract-zip@2.0.1` through QVAC’s packaging dependencies. The full development
audit also reports two `image-size@0.7.5` advisories through the macOS DMG tool.
The repo already pins local patches in `pnpm-workspace.yaml`:

- `extract-zip` checks link destinations and ancestors before extraction and
  refuses writes through an existing final symlink. Regression ZIPs verify
  escaping links, a pre-existing target and safe internal links.
- The legacy `image-size` patch rejects non-advancing ICNS chunks. The older
  package has no JXL or HEIF parser; the related advisory does not describe a
  parser present in that version. The DMG callback API is covered by a test.

The audit registry recommends extract-zip 2.0.2, but npm returned 404 for that
version during this review. Keep the tested patch until a published upstream
replacement passes the archive tests. Version-based audit output still reports
these alerts; do not describe this tree as having zero dependency advisories.
See [the earlier security review](SECURITY-REVIEW-2026-09-17.md) for product trust
boundaries and remaining operational limitations.

## After deployment

Fetch `/`, `/how-it-works` and `/docs` without JavaScript. Check canonical and
social URLs, structured data, and `Content-Security-Policy`. Confirm both PNGs
return `image/png`, `/robots.txt` and `/sitemap.xml` describe production, and an
unknown route returns HTTP 404. Open home and guide on desktop and mobile,
exercise the controls and inspect console errors.

Use Search Console’s URL inspection and performance reports to assess actual
indexing and search traffic when the property is available. Social networks may
retain older previews until they fetch the new image URLs.
