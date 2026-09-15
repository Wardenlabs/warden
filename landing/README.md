# Warden landing

Static, same-origin files plus a server endpoint for Kool download measurement. The build installs the isolated Kool SDK and copies its public browser helper. A continuous graphite background, white text and restrained charcoal product surfaces frame the official silver shield, an immediate download, and one client confidentiality example. The hero reads **“Your AI. Your rules.”**; the page closes with a compact **“Download Warden”** heading and **“Free for everyone. Open source.”**

## Run locally

From the repository root:

```bash
npm ci --prefix integrations/kool --ignore-scripts --no-audit --no-fund
node scripts/build-kool-browser.mjs
node scripts/serve-kool-landing.mjs
```

Open [127.0.0.1:4174](http://127.0.0.1:4174). This serves the page and `POST /api/download` together; a plain static server does not implement the download endpoint. Without a token, valid download requests still redirect to GitHub. The root [`vercel.json`](../vercel.json) deploys `landing/` and the endpoint, installs the isolated SDK and copies the browser helper. See [Kool download events](../docs/KOOL-DOWNLOADS.md) for the private `KOOL_INGEST_TOKEN`, test-mode setup and campaign attribution.

## Story and interaction

| Part | What it shows |
| --- | --- |
| Hero | A full first viewport below the header: larger type and a flat 56px download link beside an unboxed request trace and official 3D shield. The native `.hero-art` button replays the animation; a compatibility strip and scroll link sit at the bottom. Short screens can grow naturally. |
| Write | A client confidentiality instruction becomes proposed rules. Native disclosures expose the full definitions; the visitor can review and activate the example. |
| Hit | A request to use one client’s private pricing in another client’s email is blocked. Native radio controls show the refusal in Claude Code, Codex or OpenCode. Desktop columns reverse the Write layout. |
| Log | A full-width decision panel below the heading carries the same request and contract-terms rule alongside an allowed follow-up using public pricing. |
| Usage | A compact secondary example shows the next request held for review after reported usage reaches its ceiling. |
| Closing | “Download Warden” and the free/open-source line beside one primary platform download, with the other platform and Linux/other builds as text links beneath it. Windows visitors get Windows as the primary action. |

Larger gaps separate the chapters. On desktop, Write and Hit advance over half a viewport of native scroll while their stage stays sticky below the header. This applies only at widths of at least 64rem, heights of at least 40rem, and when the whole stage fits. Other chapters stay in ordinary flow. Mobile and layouts without enough room use a finite sequence on entry, then hold the result. Scrolling remains browser-native.

Write has Describe, Review and Activate steps, Replay, and explicit Draft/Activate buttons. Manual interaction cancels playback; keyboard focus in its controls pauses the sequence. Tool selection is retained. These are prewritten illustrations: the read-only composer and controls change only the page’s presentation. Keep proposed rules and human activation distinct.

## Progressive enhancement

- Header and hero downloads are available from the first frame. The flat hero control keeps a native link, switches its platform icon, label and installer on Windows, and offers visible keyboard focus. Supporting platform/film links and the free/open-source line reserve their space and begin appearing after 1.9 seconds. No-JavaScript and reduced-motion visitors see them immediately.
- `hero-trace.js` runs two blocked requests and one allowed request over 4.4 seconds, then rests on the first blocked result. The native `.hero-art` button supports pointer and keyboard replay. The trace stops offscreen or in hidden tabs; reduced-motion and no-JavaScript visitors see a static blocked result.
- `shield.js` lazily loads the vendored Three.js renderer near the hero shield. A finite 1.9-second entrance and fine-pointer reflection settle to rest; rendering pauses offscreen and in hidden tabs. The hero also drifts slightly with native scroll. A local PNG covers no-JavaScript, reduced-motion, low-capability and WebGL failure paths.
- Reduced motion shows completed chapter content without typing, animated transitions or sticky story stages. Without JavaScript, content, full-rule disclosures and the radio-based tool selector remain readable; unavailable scripted controls are hidden. The head watchdog restores readable content if the main module cannot load, and a late module restores enhancement.
- **Watch the film** is a normal media link enhanced into a native dialog with native video controls. Its 17-second MP4 source loads only after activation, with `preload="none"`. Closing pauses playback and restores focus. The media link remains the fallback.

## Files and sources

| File | Role |
| --- | --- |
| `index.html` | Story, examples, native controls, download links and social metadata. |
| `foundation-v2.css` | Neutral tokens, local Manrope, page frame, navigation, shared controls and film dialog. |
| `experience-v2.css` | Hero, responsive story layout, sticky stages and closing. |
| `product-scenes-v2.css` | Charcoal policy composer, rules, tool selector, terminals and decision log. |
| `app.js` | Scroll and entry playback, manual controls, film dialog and platform links. |
| `hero-trace.js` | Finite request trace, native replay, visibility handling and reduced-motion fallback. |
| `shield.js`, `assets/3d/` | Official-symbol renderer, vendored Three.js, license and static fallback. |
| `analytics-entry.js`, `analytics-config.js`, `analytics.js` | Independent PostHog measurement, production-host gating and explicit local test mode. |
| `kool-entry.js`, `kool-download.js`, `vendor/kool/browser.mjs` | Kool attribution capture and download submissions to the server endpoint; no browser credentials. |
| `assets/brand/` | Official lockup and self-hosted Manrope with its SIL Open Font License. |
| `assets/launch/` | Launch film and poster. |
| `social-card.html`, `assets/share/warden-share-v2.png` | Source and 1200 × 630 PNG used by Open Graph and Twitter cards. |
| [`scripts/render-social-card.mjs`](../scripts/render-social-card.mjs) | Regenerates the social PNG from the local card after fonts and images load. |
| `llms.txt` | Product scope and links for automated readers. |

To regenerate the social card, run `node scripts/render-social-card.mjs` from the repository root with Playwright and Chromium available. `PLAYWRIGHT_MODULE`, `BROWSER_EXECUTABLE` and `SOCIAL_CARD_URL` optionally select an existing runtime, browser or served source. Viewing and deploying the landing require none of these tools.

Brand geometry comes from [`brand/`](../brand/README.md). Keep examples grounded in [`PRODUCT.md`](../PRODUCT.md), [`web/`](../web/), [`src/policy/compile.ts`](../src/policy/compile.ts), [`integrations/warden-hook.mjs`](../integrations/warden-hook.mjs), [`src/guard/budget.ts`](../src/guard/budget.ts) and [`src/audit/`](../src/audit/). Evidence and limitations remain in [`SECURITY.md`](../SECURITY.md), [`docs/HOOK-VERIFICATION.md`](../docs/HOOK-VERIFICATION.md), [`REPORT.md`](../REPORT.md) and [`BENCHMARKS.md`](../BENCHMARKS.md). Installer links must match actual assets in the [latest release](https://github.com/Wardenlabs/warden/releases/latest).

Preserve analytics IDs and data hooks for downloads, sections, manual steps, replay, tool changes and film events. Autoplay is not a manual selection. Normal previews stay quiet; PostHog respects Do Not Track and sends only allowlisted properties, without prompt text or automatic DOM capture. Production also retains Vercel page views. See [launch measurement](ANALYTICS.md) for test filters, campaign links and the distinction between clicks, file downloads and installations.
