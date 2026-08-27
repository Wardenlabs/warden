# landing

The public site. One static `index.html`, no build step, no dependencies —
the same shape as `web/`, for the same reason: there is nothing here that a
bundler would earn its place doing.

## Why it lives in this repo

Two things on this page are read from somewhere else in the tree, and both
would drift the moment they were copied into a repo of their own:

- **The brand.** The mark and the wordmark are inlined from `brand/`,
  path for path. `brand/README.md` is explicit that it is the one place the
  logo changes, and inlining is already how `web/index.html` consumes it.
- **The download links.** The installers come from this repo's own CI —
  `.github/workflows/desktop.yml` publishes them to GitHub Releases on `v*`
  tags. Same repo means the button and the artifact cannot disagree.

Every number on the page is from `REPORT.md` and `BENCHMARKS.md`. When those
are regenerated, the page is stale until someone updates it; there is no
mechanism keeping them in sync, which is the honest tradeoff for having no
build step.

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

## Checking it locally

```bash
npx serve landing
```

## Design

The `:root` block is copied verbatim from `web/index.html`. Two additions and
no changes: `--fs-7` / `--fs-8`, a display tier a marketing page needs and a
dense console does not, and the dark palette. The verdict colours stay the
only saturated thing on the page, exactly as in the product.
