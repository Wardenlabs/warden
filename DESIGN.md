---
name: Warden
description: Quiet black and white, the official silver shield, and concise evidence of user control.
colors:
  warden-black: "#080808"
  warden-white: "#f4f4f2"
  warden-ink: "#181818"
  warden-muted-dark: "#a3a3a3"
  warden-muted-light: "#61615f"
  warden-line-dark: "#303030"
  warden-line-light: "#d7d7d3"
typography:
  display:
    fontFamily: '"Manrope", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "clamp(2.6rem, 6vw, 5.25rem)"
    fontWeight: 580
    lineHeight: 1.1
    letterSpacing: "-0.04em"
  title:
    fontFamily: '"Manrope", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "clamp(2rem, 4vw, 3.5rem)"
    fontWeight: 550
    lineHeight: 1.12
    letterSpacing: "-0.04em"
  body:
    fontFamily: '"Manrope", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "-0.012em"
  action:
    fontFamily: '"Manrope", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "0.875rem"
    fontWeight: 650
    lineHeight: 1
  label:
    fontFamily: '"Manrope", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontSize: "0.75rem"
    fontWeight: 400
rounded:
  warden-radius: "12px"
  warden-control-radius: "999px"
  dialog: "1rem"
spacing:
  "2": "0.5rem"
  "3": "0.75rem"
  "4": "1rem"
  "5": "1.25rem"
  "6": "1.5rem"
  "8": "2rem"
  "10": "2.5rem"
components:
  button-primary:
    backgroundColor: "{colors.warden-white}"
    textColor: "{colors.warden-ink}"
    typography: "{typography.action}"
    rounded: "{rounded.warden-control-radius}"
    padding: "0.85rem 1.25rem"
  button-primary-hover:
    backgroundColor: "{colors.warden-line-light}"
    textColor: "{colors.warden-black}"
  film-link:
    textColor: "{colors.warden-muted-dark}"
    typography: "{typography.label}"
  example-panel:
    backgroundColor: "{colors.warden-black}"
    textColor: "{colors.warden-white}"
    rounded: "{rounded.warden-radius}"
  example-selector:
    textColor: "{colors.warden-muted-dark}"
  navigation:
    textColor: "#b5b5b5"
---

# Design System: Warden

## Overview

**Creative North Star: "Quiet contrast"**

**Status: implementation authorized for main on 2026-09-20.** The user requested shipping, followed by a correction to the 3D logo quality. The named direction is a working description. The user requested less text and fewer components, black and white, preservation of the official logo, and taste informed by Plaude.

Warden combines a restrained interface with one substantial object: its official shield in neutral silver. Short statements and generous space give the mark room; a restrained charcoal surface distinguishes concrete evidence within the continuous black canvas. Carry this identity into later video without treating this homepage's section order as a universal template.

**Key Characteristics:**
- Continuous black fields, charcoal surfaces and off-white content with neutral gray support.
- Official geometry, realistic metallic depth, flat interface surfaces.
- Short copy, visible actions, native controls, explicit illustrative examples.

The effective homepage cascade is [foundation-v2.css](landing/foundation-v2.css), then [design-system.css](landing/design-system.css), then [landing.css](landing/landing.css). These tokens describe that implementation. [Design notes](docs/design/README.md), [reference research](docs/design/RESEARCH.md), [landing brief](docs/design/LANDING.md) and [video direction](docs/design/VIDEO-DIRECTION.md) carry the supporting rationale and surface-specific decisions. The detailed journey at [how-it-works.html](landing/how-it-works.html) now shares the homepage tokens, navigation scale and download controls. Its black canvas and charcoal product panels are defined by guide.css over the existing functional scene styles. Both pages load motion.css and the isolated surface-motion.js controller. Product truth comes from [PRODUCT.md](PRODUCT.md); official mark authority comes from [brand/README.md](brand/README.md).

## Colors

### Primary

**Quiet white** (`warden-white`) is the primary action and major statement color on black; it is reserved for content and primary actions, never a full-page section. **Studio black** (`warden-black`) carries the hero, closing section and example panel. Neither is a chromatic accent.

### Neutral

**Dark ink** (`warden-ink`) provides text inside light primary actions. **Muted dark** and **muted light** support text on their respective surfaces. **Dark line** separates evidence rows and the footer; **light line** is also the primary button hover fill. Selected example labels and focus rings use literal white from the foundation.

**The Neutral Verdict Rule.** Blocked and Allowed use words and distinct icons; neither needs a red or green brand accent.

The shared foundation still declares coral and amber for older fragments. Do not promote these unused homepage tokens into the new brand palette. The film dialog retains its existing cool charcoal surface and slightly blue-black backdrop; it is an inherited component, not a new accent direction.

## Typography

Manrope is self-hosted with `font-display: swap` at `landing/assets/brand/Manrope-Variable.ttf`. The frontmatter owns desktop display, title, body, action and label values. The hero pairs a lighter first phrase (400) with the display weight for the second. Titles and decision labels use tight, restrained tracking rather than heavy bold. The example decision scales from 1.5rem to 2rem at weight 540.

Supporting hero copy uses a 1.5 line height. Navigation and option labels use 0.8125rem; fine example captions use 0.6875rem. The foundation's monospace family is available for genuine technical evidence on the detailed page; the new homepage's labels are sans-serif.

## Layout

The hero covers at least the full viewport including its compatibility strip, without a desktop height cap. All page backgrounds, including overscroll, remain black. The default content width is 68rem plus gutters; the proof wrapper has a total maximum width of 58rem. Gutters grow from 1.125rem to 2rem at 48rem. The page supports a 20rem minimum viewport. The absolute header has a separate 100rem cap and fluid horizontal padding; it does not remain sticky on this homepage.

The current surface centers “Your AI. Your rules.”, a short descriptor, the shield and stacked download/film actions on black. A compact compatibility row leads into a dark evidence section containing one native private/public example. A large centered official lockup closes the page, followed by a prominent text download and one row of alternative installers. Detailed workflow content lives on the linked page. Keep this composition in the surface brief, not as a mandate for every future screen.

Below 48rem, the headline becomes `clamp(2.6rem, 10.5vw, 4rem)` with 1.08 leading and a 10ch maximum; its first phrase forms a separate line. Description width is 26ch, artwork scales from 14rem to 21rem, evidence padding decreases, and footer copy/actions stack. The footer uses the 68rem content width; its centered lockup grows to a 6rem symbol and 22rem wordmark. Navigation forms a quiet lower baseline. Desktop artwork scales from 17rem to 26rem. Short desktop windows at 650px high or less use a 38rem minimum hero and 18rem artwork. All minimum heights allow content to grow; scrolling stays native.

## Elevation & Depth

The interface is flat: background contrast, spacing and hairlines establish structure. The hero includes a restrained neutral studio light field and a grounding reflection beneath the metal, without ambient animation. The exception is the inherited film dialog shadow (`0 2rem 6rem rgb(0 0 0 / 0.62)`). Do not add card shadows to the proof or download controls.

The official shield supplies material depth. [official-shield.js](landing/assets/3d/official-shield.js) extrudes the canonical vector contours, preserving the ring opening and internal mark, with neutral metallic faces and reflected white studio lights. It is real geometry, not a generic shield or an approximate letter. The renderer uses 64 curve segments, 16 bevel segments and crease-aware shared normals to remove faceted reflections while preserving sharp corners. The canvas supersamples at 2–3× CSS size (1.5× device pixel ratio, capped at 3×), including Retina screens.

[shield.js](landing/shield.js) runs a finite 4.8-second light entrance with a centered orthographic camera. The entrance stays frontal. Afterward a 14-second yaw cycle (±.18 rad), smaller pitch and 4-unit float reveal the volume without a full rotation or scale change. Fine pointers anywhere within the hero cause a small rotation and changing reflection. Visible rendering is capped at 30fps and stops offscreen or in hidden tabs. Reduced motion renders the completed stationary pose; an exact front-facing SVG stays available for no JavaScript or rendering failure. The renderer's deterministic 0–2.6-second clock is stretched to the entrance duration by the controller. The homepage currently has no visible scroll-driven shield drift.

## Shapes

The official mark's outline and proportions are binding. Primary download controls are pills; the evidence panel has gently rounded corners. The film dialog retains its larger foundation radius. Fine dividers structure the example without nested cards. Status icons remain open, monochrome line drawings with visible text labels.

## Components

**Download.** Off-white pill with dark text and an operating-system icon; minimum height 48px. Hover changes to light gray on fine pointers. The hero inherits a small pressed translation/scale from the shared button. Footer downloads are grouped text links; the primary uses 20–28px type and a downward icon in a thin circular outline, without repeating the hero pill. Direct links work before enhancement; platform detection updates the primary installer and footer ordering. Preserve existing installer targets and hooks.

**Film link and dialog.** A quiet text link beneath the download, with a play icon and 44px minimum target. It directly links to the existing film and enhances into a native dialog with native video controls, lazy media loading, Escape/close support, pause on close and focus restoration. The current film is an existing asset; this proposal does not claim it was remade.

**Footer.** The official lockup and release line anchor the left; one primary download and secondary installer links anchor the right. On mobile both stack left-aligned. The final row carries license and essential links. No repeated large marketing headline or light background.

**Navigation.** Official inline symbol and wordmark on the left; quiet GitHub and Download links on the right. Links are at least 44px high. The header's GitHub link hides below 48rem, while source remains available in the footer. Preserve accessible names on the lockup.

**Policy example.** One black fieldset with a descriptive legend, a rule, Active status, native radios, request text and outcome. The two radio labels have 48px targets and a thin selected underline. Arrow keys use native radio behavior; the focused radio places a visible outline on its label. CSS switches the matching content even without JavaScript. The panel is explicitly an illustrative example, not a live policy editor. “For connected tools” stays visible nearby.

**Directional links.** Use the shared 24-unit horizontal SVG arrow with 1.5-unit round strokes. It moves 3px on hover/focus. Back navigation reverses the same icon. Do not use diagonal Unicode arrows.

**Request trajectory.** A finite 1,250ms SVG stroke travels toward the rule boundary. Blocked stops at the solid boundary with a 650ms impact ring; Allowed continues through a dashed boundary. Written outcomes stay immediately readable. Intersection observation starts the effect at 25% visibility; leaving the viewport, hiding the tab or enabling reduced motion removes animation. Native radio changes replay the selected case. The duration is illustrative, not measured product latency.

**Control feedback.** Download and rule-action buttons respond to a press with a 1px translation and .985 scale, without a decorative shine sweep. Reduced motion removes the transform. The guide introduction uses a shorter title and tighter spacing so the first interaction appears earlier. See [Taste audit](docs/design/TASTE.md).

**Focus and motion.** Use a 2px focus outline offset by 4px, white on dark, including the guide and proof section. Example selection transitions in 180ms with `cubic-bezier(.16, 1, .3, 1)`; inherited buttons/navigation use 160ms. Reduced motion disables smooth scrolling and effectively removes CSS transitions. The skip link and keyboard access remain functional. Do not conceal meaningful content behind animation.

## Do's and Don'ts

### Do:
- **Do** preserve the official symbol, wordmark and vector contours in web and video.
- **Do** keep a short promise, a clear action and concrete evidence easy to find.
- **Do** preserve native controls, visible keyboard focus and readable fallback content.
- **Do** distinguish illustrative requests from live product behavior and retain connection qualifiers.
- **Do** carry new user feedback into both the homepage and the detailed guide.

### Don't:
- **Don't** add chromatic accents or replace the official mark with a generic shield.
- **Don't** add explanatory cards when typography and space can carry the content.
- **Don't** use color alone for a decision or remove the private/public example's native radio semantics.
- **Don't** turn local policy checks into claims that no data ever leaves the device or that every tool is protected automatically.
- **Don't** infer approval of a future video, change product facts or invent proof from this design document.

## Manual guide

How it works uses explicit Describe / Review / Activate controls. No scrolling or automatic playback changes the chosen step or tool. One composer or rule list is visible at a time; activation exposes a link to the blocked-request example. Reset returns to the instruction. Stage changes announce a concise status and move focus to the selected stable step when an action disappears. Without JavaScript the rule definitions remain readable.

Visible captions and explanatory paragraphs under guide headings were removed at the user’s request. Keep functional labels and decisions; do not reintroduce repeated example disclaimers or microcopy. Demo data remains deterministic, with no claim of live evaluation.

Footer composition lives in `landing/footer.css`, loaded last on both pages. The proof uses one inset for rule, selectors and result (32px desktop, 24px mobile). Rule label and state share a row above the policy; the 64px desktop / 48px mobile trajectory connects the request to the verdict. No explanatory suffix follows Blocked or Allowed.
