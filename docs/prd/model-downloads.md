# Model downloads from Library

Status: draft for review. The owner chose approach A on 2026-09-20; the scope and operational decisions below are proposals, not implemented behavior.

Technical companion: [model-downloads spec](../specs/model-downloads.md).

## Problem and evidence

An administrator opened the repository-built Warden app in a browser and couldn't find Download models. The console currently hides that action unless `/health` reports an attached desktop shell. Even in Electron, the action stops the gateway, restarts the app and returns to first-run setup; it doesn't download the model from its Library row.

The current flow also makes selection a prerequisite for downloading an alternative judge. A row's Download models action carries no model identity, so it can fetch a different file from the one the administrator clicked. Warden already supports background downloads for custom HTTPS URLs, but that path creates imported models rather than installing its built-in files.

This PRD replaces the download-related constraints in the older [Models redesign PRD](models-redesign.md). Its promise of no server changes doesn't apply here. The implementation already lists built-ins in Library, despite the older technical document describing a custom-only table.

## Product decision

Use approach A: start a download from the model's existing overflow menu, then show its progress in the same row. Don't add an expanded progress panel or a global download tray.

Design references, in Warden / 07 · Models:

- [Entry action](https://www.figma.com/design/RFPKLtSSZjQMHy9XaOOSqp/Warden?node-id=843-1595): the row menu offers Download and the approximate size.
- [Approach A](https://www.figma.com/design/RFPKLtSSZjQMHy9XaOOSqp/Warden?node-id=843-1796): download icon, readable status and byte count.
- [State and motion notes](https://www.figma.com/design/RFPKLtSSZjQMHy9XaOOSqp/Warden?node-id=843-1590): error recovery, cancellation and static motion samples. The samples specify motion; they aren't an implemented animation.

The actual console address is `#/models/library`; `/models` is the product shorthand. Preserve the existing sidebar, tabs and Add model action. Don't copy illustrative Figma rows as new catalogue entries.

## Administrator's job

“I want this particular model on the gateway so I can try or use it later, without interrupting the model that currently checks requests.”

The browser initiates an administrative operation on the connected gateway. Files belong on that gateway's disk, not in the browser's Downloads folder; another administrator connected to the same installation sees the same progress.

## First-release scope

Cover the built-in files already represented by the Library's analyzer choices and local compiler. These are DynaGuard 4B, DynaGuard 1.7B, DynaGuard 8B, Qwen3 1.7B, Qwen3 8B, Shieldstral 1.0 3B and Granite Guardian 4.1 8B. Qwen3 1.7B serves both analyzer and compiler; show one physical-file row with both jobs rather than downloading or listing it twice.

The same row action works through a browser against `pnpm run dev` or `pnpm run build` followed by `pnpm start`, and through the running Electron console. It doesn't depend on `canLeaveDemo`. Keep custom URL imports, uploads and endpoint connections working; their broader redesign isn't part of this release.

This is not a replacement for complete first-run setup. Detector and embedder installation, optional assistant/OCR assets and benchmark-only Qwen3 4B remain outside the Library download selector. Runtime details must continue to explain missing supporting files and the existing setup command. Downloaded judge weights alone don't establish that the gateway is ready to serve requests.

### Explicit exclusions

- Approaches B and C, bulk download, a waiting queue, pause/resume buttons and download scheduling.
- Switching a running process from mock to real, removing built-in weights, replacing files currently in use, or changing model defaults.
- Browsing Hugging Face, downloading gated repositories with credentials, arbitrary filenames and additional model formats.
- Guard accuracy changes, prompt changes, new inference runtimes or claims that file verification measures policy accuracy.

## Experience

### Start from the row

For an absent file, the overflow menu offers `Download · ~5.03 GB`. The estimate comes from the built-in catalogue; don't present it as an exact transfer size. Clicking it starts that file immediately, without a confirmation dialog, preliminary selection or a change to compiler settings.

Keep the overflow trigger visible, not hover-only. After starting, close the menu, keep keyboard focus associated with that row and update its status. Don't leave Library or reload the page.

### Progress without moving the table

Reserve a two-line status area. Show a download arrow beside `Downloading · 42%`, with `2.11 GB of 5.03 GB` below it when the server knows the total. Keep the label and numbers still. The arrow uses a soft opacity cycle from 100% to 55% and back over 1.6 seconds, with ease-in-out timing.

The numbers in the design are examples. Show actual transferred bytes in the product, and distinguish catalogue estimates from server-reported totals. If a total is unknown, show transferred bytes without a percentage. Never invent speed or remaining time.

The row menu offers `Cancel download` while the transfer can still stop. A full-page refresh or navigation away doesn't cancel it. When the administrator returns, read the gateway's status instead of rebuilding progress from browser memory.

### State and action contract

| Situation | Row status | Available action |
| --- | --- | --- |
| No installed file | Not downloaded | Download with approximate size |
| Accepted; awaiting metadata | Connecting… | Cancel download |
| Receiving bytes | Downloading · N%, plus bytes | Cancel download |
| Automatic network retry | Retrying · attempt N of 4 | Cancel download |
| Checking the complete transfer | Verifying… | Cancel until final publication begins |
| Cancellation requested | Cancelling… | No duplicate request; wait for cleanup |
| Finished | Downloaded · built-in | Existing role-specific Use action |
| Usable file from an older installation | On disk · built-in | Existing role-specific Use action; don't claim a verified historical download |
| Existing invalid file | Model file requires repair | Explain the blocked download; no automatic overwrite |
| Failed | Download failed, plus a short cause | Retry download |
| Gateway stopped during transfer | Download interrupted | Retry download |
| Another transfer owns the installation | Existing status remains visible | Download disabled with the reason and active model name |

A cancellation returns the row to Not downloaded after cleanup, with one confirmation announcement. It never deletes an installed file. Errors stay with the affected model instead of appearing only in a disappearing toast.

### Download and Use are separate

Download doesn't write model selections, unload weights, stop the gateway or activate the result. It leaves the current judge and its response format in force. If the installation had no loaded judge, don't describe the downloaded file as active merely because it matches the configured default.

Keep the existing compatibility boundary when the administrator subsequently chooses Use. Custom models still need a successful test per role; built-in analyzer switching checks compatibility before applying the choice. A failure must preserve the previous configuration and keep new requests on the existing fail-closed path. Compatibility isn't policy accuracy.

Within Active, missing models lead to their Library row instead of saving a pending selection to trigger the desktop installer. The local compiler's missing-weights hint also leads to Library without first forcing the administrator to apply local compilation. Files under environment overrides remain governed by those overrides; downloading a catalogue file doesn't override them.

## Operational behavior

Allow one model transfer per models directory at a time, including custom imports. Two clicks on the same active built-in return the same job; another model receives an actionable busy response rather than a hidden queue. Installed files remain usable offline.

For built-ins, retry recoverable network failures with the downloader's existing maximum of four attempts. Reuse partial bytes only when the server's metadata supports safe continuation. After a gateway restart, show Interrupted and wait for Retry; don't resume consuming bandwidth automatically. Explicit Cancel removes that job's partial data.

A stale progress read is not proof that the transfer failed. Keep the last known count, mark the connection as unavailable and retry status reads. Another browser must discover transfers it didn't start.

Retain existing resource limits for server-owned imports: 20 GiB per file, a 30-minute transfer budget and disk-space checks. Apply equivalent protections to the newly exposed built-in download operation. Failures must not publish incomplete weights as installed files.

Mock mode may download real files after an explicit administrator action, but it remains mock. Disable real Use in that mode and explain that separate runtime configuration is required before real inference. The experimental llamacpp adapter remains outside supported model management; show an unavailable reason rather than advertising a working download/activation flow.

## Accessibility and presentation

Use existing typography, semantic colors and the shared SVG icon conventions. Honor reduced-motion preferences with a static arrow and the same text. Give each menu a model-specific accessible name and retain focus when progress changes; mouse and keyboard users must be able to open Cancel without a poll closing the menu.

Expose determinate progress semantics where the total exists. Announce start, completion, cancellation and failure, not every percentage update. Check the dark theme and narrow layout; status and overflow actions must remain reachable without clipping. No new page subtitle is necessary.

## Acceptance criteria

| ID | Observable result |
| --- | --- |
| D01 | A browser connected to a built gateway with no Electron shell can start a missing built-in from Library. |
| D02 | Clicking Download requests only that physical file; settings and unrelated downloads stay unchanged. |
| D03 | The gateway PID and current loaded judge remain unchanged throughout a successful download. |
| D04 | The row displays server-sourced progress within the next successful polling interval, targeted at two seconds. |
| D05 | An open row menu, keyboard focus, edits in Add model and page scroll survive progress updates. |
| D06 | Refresh, tab changes and a second administrator's browser recover the same active transfer. |
| D07 | Double-clicks don't create duplicate jobs; competing model/custom transfers receive a busy response. |
| D08 | Cancel stops the transfer, cleans its partial files and doesn't remove existing weights. |
| D09 | Network interruption retries safely; process interruption produces Interrupted and an explicit Retry action after restart. |
| D10 | Short, oversized or invalid GGUF transfers never produce Downloaded or become selectable as newly installed weights. |
| D11 | Completed files appear in inventory without a page reload. Use remains separate, including a previously selected but unloaded model. |
| D12 | Both uses of Qwen3 1.7B resolve to one file and one transfer identity. |
| D13 | Non-admin requests can't start, inspect or cancel transfers; the current loopback-admin policy remains unchanged. |
| D14 | Progress remains understandable without animation, color perception or a known total size. |
| D15 | Existing custom import/test/activation behavior and desktop/terminal setup remain covered by regression tests. |
| D16 | Mock mode stays mock; missing supporting weights don't disappear from runtime diagnostics after a judge download. |

## Decisions to approve with this draft

The visual approach is approved. The recommended first release stops at the seven selectable built-in files, keeps one transfer at a time and requires explicit Retry after a gateway restart. It doesn't make a fresh browser-only installation a complete replacement for setup. Expanding that promise would add support-file rows and a separate readiness/runtime flow.

Keep custom imports in their existing transfer area for this release; only built-ins use A's in-row presentation. Reuse shared limits and synchronization now, and avoid making the release depend on a custom-import UI redesign. The technical spec spells out the required downloader work rather than treating these behaviors as capabilities we already have.
