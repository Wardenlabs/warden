---
name: Warden
description: Continuous graphite, charcoal product surfaces, the official silver shield, and a concise client confidentiality story.
colors:
  white: "#ffffff"
  white-hover: "#e4e4df"
  white-ink: "#17181b"
  night-950: "#101113"
  night-900: "#151619"
  night-850: "#1b1d20"
  night-800: "#222428"
  night-750: "#2a2c30"
  steel-500: "#777b83"
  steel-400: "#969ba3"
  steel-300: "#b5b8be"
  steel-200: "#d5d7db"
  paper: "#f2f2ef"
  line-soft: "#2b2d31"
  line: "#393c41"
  line-strong: "#62666d"
  product-bg: "#17191c"
  product-raised: "#1d1f23"
  product-sunken: "#272a30"
  product-line: "#3b3e44"
  product-soft-line: "#303339"
  product-ink: "#f2f2f0"
  product-secondary: "#c2c5cc"
  product-faint: "#a6aab3"
  product-block: "#efeff1"
  product-block-soft: "#35383f"
  product-review: "#dddfe4"
  product-review-soft: "#35383f"
typography:
  display:
    fontFamily: '"Manrope", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "clamp(3.4rem, 14vw, 6rem)"
    fontWeight: 600
    lineHeight: 1.02
    letterSpacing: "-0.04em"
  title:
    fontFamily: '"Manrope", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "clamp(2.4rem, 8vw, 4.1rem)"
    fontWeight: 550
    lineHeight: 1.05
    letterSpacing: "-0.04em"
  body:
    fontFamily: '"Manrope", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "-0.012em"
  label:
    fontFamily: 'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, monospace'
    fontSize: "0.75rem"
    fontWeight: 520
    letterSpacing: "0.08em"
rounded:
  sm: "0.375rem"
  md: "0.375rem"
  lg: "1rem"
  xl: "1.5rem"
  product: "0.25rem"
  product-control: "0.2rem"
  badge: "0.15rem"
spacing:
  "1": "0.25rem"
  "2": "0.5rem"
  "3": "0.75rem"
  "4": "1rem"
  "5": "1.25rem"
  "6": "1.5rem"
  "8": "2rem"
  "10": "2.5rem"
  "12": "3rem"
  "16": "4rem"
  "20": "5rem"
  "24": "6rem"
components:
  button-primary:
    backgroundColor: "{colors.white}"
    textColor: "{colors.white-ink}"
    rounded: "{rounded.md}"
    padding: "0.75rem 1.125rem"
    height: "48px"
  button-primary-hero:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.white-ink}"
    rounded: "0.35rem"
    padding: "0.9rem 1.2rem"
    height: "56px"
  button-primary-hover:
    backgroundColor: "{colors.white-hover}"
    textColor: "{colors.white-ink}"
    rounded: "{rounded.md}"
  button-secondary:
    backgroundColor: "{colors.night-900}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    padding: "0.75rem 1.125rem"
    height: "48px"
  button-product:
    backgroundColor: "{colors.product-ink}"
    textColor: "{colors.product-bg}"
    rounded: "{rounded.product-control}"
    padding: "0.7rem 0.85rem"
    height: "44px"
  policy-field:
    backgroundColor: "{colors.product-raised}"
    textColor: "{colors.product-ink}"
    padding: "1.25rem 1rem 1rem"
  product-panel:
    backgroundColor: "{colors.product-bg}"
    textColor: "{colors.product-ink}"
    rounded: "{rounded.product}"
  badge-block:
    backgroundColor: "{colors.product-block-soft}"
    textColor: "{colors.product-block}"
    rounded: "{rounded.badge}"
    padding: "0.22rem 0.45rem"
  badge-review:
    backgroundColor: "{colors.product-review-soft}"
    textColor: "{colors.product-review}"
    rounded: "{rounded.badge}"
    padding: "0.22rem 0.45rem"
---

# Warden design

A continuous graphite background carries the page from hero to closing. White and gray text, restrained charcoal product surfaces and the official silver shield establish the identity. Use short statements, aligned rows and clear labels to follow one client confidentiality example from instruction through review, activation, refusal and decision log. Usage limits are a compact secondary example.

This document records the implemented landing. Its visual sources are [`foundation-v2.css`](landing/foundation-v2.css), [`experience-v2.css`](landing/experience-v2.css) and [`product-scenes-v2.css`](landing/product-scenes-v2.css). [`PRODUCT.md`](PRODUCT.md) governs product claims, and [`brand/`](brand/README.md) governs the mark geometry.

## Palette and typography

Use the neutral tokens above throughout the page, including Block, Held, Active and Allowed states. Words and status icons carry each verdict; color is never its sole meaning. Keep the shield’s lighting neutral, product surfaces charcoal and primary actions white with dark labels. Section boundaries use spacing and quiet rules within the same graphite field.

Manrope is self-hosted in `landing/assets/brand/Manrope-Variable.ttf`, with its local SIL Open Font License and `font-display: swap`. Use it for statements, interface content and controls. Reserve system mono for rule IDs, times, counts, platform details and terminal evidence. The hero uses weight 600; chapter titles use 550 with tight leading. Supporting prose uses 1rem with comfortable line spacing and short measures. Responsive rules in the active stylesheets define the final sizes.

## Composition

The hero reads **“Your AI. Your rules.”** above one short explanation and an immediate, flat 56px download link with a platform icon, label and trailing arrow. Beside it, the native `.hero-art` replay button combines an unboxed request trace with the official 3D shield. The opening fills the viewport below the header, with the title and shield centered in the available space. A compact compatibility strip names Claude Code, Codex and OpenCode at the bottom edge and leads into the story. The alternate platform, film and free/open-source line reserve their space and begin appearing at 1.9 seconds. The sticky header keeps a download available while scrolling.

The main story has three chapters. Write presents the instruction and proposed rules, with review and activation visibly separate. Hit blocks a request to include one client’s private pricing in another client’s email. Log carries that request and the same contract-terms rule into the decision record, followed by an allowed email using public pricing. Keep usage limits as a compact follow-up below this sequence. The footer closes with **“Download Warden”** and the free/open-source line directly beneath it. One flat download button sits beside the heading, with the other platform and Linux release link below it. The existing Windows detection moves that installer into the primary position. Keep this close unboxed and smaller than the hero.

The frame supports a 20rem minimum viewport and a 90rem content width. Gutters grow from 1.125rem to 2rem at 48rem. Content stacks on small screens; at 64rem the hero gives its request trace and shield a wider column beside the copy. The hero uses a minimum viewport height rather than a fixed height, so short screens and enlarged text can scroll naturally. Stacked artwork is capped at 21rem on phones and 28rem on tablets to keep the first scene together. Write pairs a narrower text column with a wider panel; Hit reverses those columns, and Log places its heading above a full-width panel. Larger gaps and top padding separate the chapters. Wrap request text and technical strings. Full rule definitions stay inside native disclosures to keep the resting page concise.

Product surfaces use one outer hairline, quiet charcoal chrome and restrained elevation. Separate rows with spacing and fine rules. Product panels use 0.25rem corners, actions 0.2rem and badges 0.15rem. Preserve the official shield silhouette and internal mark.

## Motion and controls

Write and Hit use a short native scroll sequence, adding half a viewport of scroll with a sticky stage only at desktop widths of at least 64rem, viewport heights of at least 40rem, and when the whole stage fits beneath the header. The other chapters stay in ordinary flow. Mobile and shorter layouts use a finite sequence on entry, then hold the result. Wheel, touch and keyboard scrolling remain native.

Write retains native Describe, Review and Activate buttons, Replay, and explicit Draft/Activate actions. Manual choices cancel playback; keyboard focus in these controls pauses the sequence. Full rules use native `details`/`summary`; connected tools use radio inputs and labels. Keep the read-only composer out of the tab sequence and make clear that these actions only change an illustrative example. Interactive targets are at least 44px high, with a visible 2px focus outline appropriate to the surface.

`hero-trace.js` plays a finite 4.4-second sequence: two blocked requests, then an allowed request, before resting on the first blocked result. The native `.hero-art` button replays it with pointer or keyboard activation. The trace stops when offscreen or hidden and stays on the static blocked result for reduced motion or without JavaScript. The download remains available throughout.

The hero’s shield has a finite 1.9-second entrance and a subtle fine-pointer rotation/reflection response that settles. The hero also has a slight drift with native scroll. Rendering sleeps when settled, offscreen or in a hidden document. Keep the local `shield-fallback.png` for reduced-motion, low-capability, no-JavaScript and WebGL failure paths.

Reduced motion presents completed story content without typing, animated transitions or sticky stages. No-JavaScript visitors retain readable content, native disclosures, tool selection and direct downloads; unavailable scripted controls are hidden. The head watchdog restores readable content if the main module cannot load. The film is a direct media link enhanced into a native dialog with native video controls and a lazy source; closing pauses playback and restores focus.

## Social preview and measurement

[`landing/social-card.html`](landing/social-card.html) composes the official shield and lockup on graphite with “AI rules that actually apply.” and “Free. Open source.” [`scripts/render-social-card.mjs`](scripts/render-social-card.mjs) produces the 1200 × 630 [`warden-share-v2.png`](landing/assets/share/warden-share-v2.png) referenced by Open Graph and Twitter metadata. Keep this card consistent with the page’s neutral identity.

Preserve the existing analytics IDs and data hooks for download/release links, section views, manual story steps, replay, native tool changes and film events. Autoplay is not a manual step selection. PostHog retains production-host gating, explicit local test mode, Do Not Track handling and allowlisted payloads without prompt text or automatic DOM capture. Production also retains Vercel page views. [`landing/ANALYTICS.md`](landing/ANALYTICS.md) defines test filters and the separate meanings of clicks, file downloads and installations.
