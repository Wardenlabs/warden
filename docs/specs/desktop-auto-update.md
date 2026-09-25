# Desktop auto-update: technical specification

Status: proposed, 2026-09-25. Nothing is implemented. Companion:
[PRD](../prd/desktop-auto-update.md), whose decisions 1–7 this spec implements
and does not reopen.

Repository inspection: 2026-09-25, branch `feat/desktop-auto-update` off
`fbe3e19`, package version `0.2.23`, Electron `^43`. Names marked **new**
describe proposed files, messages or contracts.

## 1. Findings in the current code

| Area | What the repository does today | Consequence for this work |
| --- | --- | --- |
| `desktop/main.ts` `before-quit` | Prevents the first quit, stops gateway and tunnel, then calls `app.quit()` again. | `autoUpdater.quitAndInstall()` goes through the same handler. It must run *after* our own drain and stop, never instead of them. |
| `desktop/main.ts` `launchGateway` | `pickPort(settings.port ?? 8080)`, then one retry on an ephemeral port if the log shows `EADDRINUSE`. | The post-update relaunch needs a port-reclaim path (§6.5). The ordinary launch keeps its behaviour. |
| `desktop/main.ts` `openConsole` | The console `BrowserWindow` has no preload. `will-navigate` keeps it on the gateway origin. | The banner needs a preload on this one window (§7.3). The origin guard already exists and the preload relies on it. |
| `desktop/server-manager.ts` `stop` | Posts `shutdown`; the gateway exits within 4 s; `kill()` at 5 s. | Too short to drain a 90 s decision. Drain is a separate, earlier message (§6.4). |
| `src/server/desktop-bridge.ts` | `tellShell` sends one of five string literals; `onShellMessage` receives anything. | Needs structured request/reply messages for readiness and drain (§5.2). |
| `src/server/lifecycle.ts` `installExitHandlers` | `shutdown` closes the HTTP server and exits in 4 s. | Drain reuses `server.close()` and adds the in-flight wait. |
| `src/qvac/coordination.ts` | `RoleCoordinator` tracks readers and a queued or active writer per role, privately. | Readiness needs a read-only "is a role change pending" (§5.3). |
| `src/models/builtin-downloads.ts` | Gateway-owned jobs with states; `active(job)` is private. | Readiness needs "any job active" (§5.3). |
| `desktop/first-run.ts` | `modelsPresent`/`ensureModels` import `dist/setup/catalog.js` and use `setupModelDownloads(settingsPath)`. | Model prefetch reuses this selector over the *next* release's catalogue (§6.3), so it needs a catalogue parameter. |
| `src/setup/catalog.ts` | `setupModelDownloads` filters the module constant `MODEL_CATALOG`. URLs pin a Hugging Face revision; no digest is pinned. | Add an optional `catalog` argument. Trust is "same filename at the same revision-pinned URL" (§6.3). |
| `src/audit/log.ts` | `recordAdminAction(actor, action, status)` appends to the decision chain. | The post-update entry uses it, with `{ id: 'desktop', role: 'operator' }` (§6.7). |
| `.github/workflows/desktop.yml` `release` | Uploads `*.dmg`, `*.zip`, `*.exe`. | Add the release manifest (§8). Windows `RELEASES`/`nupkg` stay out (PRD decision 6). |
| `integrations/warden-hook.mjs` | A transport failure or non-JSON error body fails open with "Warden unreachable". A JSON error body is passed back as a value on the decision path. | Drain must look like "down" to a hook (refused or reset connection), never like a JSON 503 whose handling is unverified (§6.4). |

## 2. Architecture

```text
main process (desktop/)
  updater.ts          new — owns the state machine and every Electron call
    ├─ release manifest   GET github.com/…/releases/latest/download/warden-release.json
    ├─ autoUpdater        update.electronjs.org/Wardenlabs/warden/darwin-<arch>/<version>
    ├─ prefetch           dist/setup/download.js downloadModel(), into models/
    ├─ gateway bridge     readiness?, drain → utilityProcess messages
    └─ surfaces           menu items, Notification, console preload
  update-policy.ts    new — pure functions, no Electron import, unit-tested
  update-marker.ts    new — pending marker, data backup, prefetch ledger
  console-preload.cts new — read-only state + one restart call, console window only

gateway (src/)
  server/desktop-bridge.ts  structured messages alongside the string ones
  server/lifecycle.ts       drain handler
  server/update-readiness.ts new — busy reasons from models and coordination
  server/boot-audit.ts      new — writes the post-update audit entry from env

web/
  js/update-banner.js  new — renders only when window.wardenUpdate exists
```

The main process owns every decision about updating. The gateway answers two
questions ("are you busy?", "drain now") and records one audit entry. It never
initiates an update and has no route for one, so decision 5 holds because no
code path exists for it, not because a check forbids it.

**No new dependency.** `autoUpdater`, `Notification`, `net` and
`systemPreferences` ship with Electron. Manifest validation is a hand-written
guard in `update-policy.ts`, because `desktop/` does not import Zod today and
the manifest has six fields.

## 3. Platform matrix

| Platform | Manifest check | autoUpdater | Prefetch | Surfaces |
| --- | --- | --- | --- | --- |
| macOS arm64 / x64, packaged | yes | yes | yes | menu, notification, banner |
| macOS, unpackaged or `WARDEN_SMOKE=1` | no | no | no | none |
| Windows | no | no | no | none (PRD decision 6) |
| Linux zip | yes | no | no | menu item + notification linking to the release |

`updater.ts` computes this once from `process.platform`, `app.isPackaged` and
`SMOKE`, and `start()` returns immediately where the row says none.

## 4. Settings and precedence

`desktop/settings.ts` gains `autoUpdate: boolean`, parsed like the others:
only an explicit `false` is false, and absence is `true`.

Resolution, in `update-policy.ts` `resolveAutoUpdate(inputs)`:

1. `systemPreferences.getUserDefault('AutoUpdate', 'boolean')` in
   `com.warden.gateway`, **only if the key exists**. Electron returns `false`
   for a missing boolean, so presence is checked first with
   `getUserDefault('AutoUpdate', 'string')` returning non-empty, or with
   `defaults read` behaviour verified in the spike (§10, open item S2).
   Source `managed`.
2. `WARDEN_AUTO_UPDATE` = `0`/`1`. Source `environment`.
3. `settings.autoUpdate`. Source `settings`.

Returns `{ enabled, source }`. The menu checkbox is disabled when `source` is
not `settings`, and its label names the source ("Set by your organisation" or
"Set by WARDEN_AUTO_UPDATE"). "Check for Updates…" runs even when `enabled` is
false. Being off stops only the schedule.

## 5. Contracts

### 5.1 Release manifest (**new**) — `warden-release.json`

Published as a release asset by CI (§8). Fetched at
`https://github.com/Wardenlabs/warden/releases/latest/download/warden-release.json`
with Electron `net.fetch`, which follows the redirect and honours the system
proxy.

```jsonc
{
  "schema": 1,
  "version": "0.2.24",                 // equals the tag without the "v"
  "minimumSystemVersion": { "darwin": "12.0" },   // from the built Info.plist
  "catalog": [                          // MODEL_CATALOG entries with a url
    { "role": "adjudicator", "filename": "DynaGuard-4B.Q6_K.gguf",
      "url": "https://huggingface.co/<repo>/resolve/<40-hex>/<filename>",
      "approxMB": 3630, "required": true }
  ]
}
```

`parseManifest(raw): Manifest | null` in `update-policy.ts` rejects the
manifest if any of the following holds:

- `schema !== 1`, or `version` is not `\d+\.\d+\.\d+`.
- A `filename` does not match `^[A-Za-z0-9._-]+\.gguf$`.
- A `url` does not match
  `^https://huggingface\.co/[^/]+/[^/]+/resolve/[0-9a-f]{40}/` + the escaped
  filename.
- Any `approxMB` is outside 1–20000, or the catalogue has more than 32 entries.
- Top-level or entry keys are unknown, which is ignored rather than rejected so
  schema 1 can grow. Size is capped at 64 KB before parsing.

A missing or rejected manifest means "no update offered this cycle" and one
log line, never a fallback to calling `autoUpdater` without it. The manifest
gates the download (minimum OS, models), and skipping it would skip the gates.

### 5.2 Shell ↔ gateway messages

Strings stay as they are. **New** structured messages, all `{ type, id }` with
`id` a random correlation string:

| Direction | Message | Reply |
| --- | --- | --- |
| shell → gateway | `{ type: 'readiness?', id }` | `{ type: 'readiness', id, busy: BusyReason[] }` |
| shell → gateway | `{ type: 'drain', id, boundMs }` | `{ type: 'drained', id, cutOff: number, waitedMs: number }` |

`BusyReason = 'model-download' | 'model-change'`. The shell adds its own
reasons (`first-run`, `prefetch`, `tunnel-starting`) before deciding.

`desktop-bridge.ts` gains `replyShell(message: object)` and exports a
type-narrowing `isShellRequest(data)`. `server-manager.ts` exposes
`request(message, timeoutMs): Promise<unknown>` on `RunningServer`, which
resolves on the matching `id` or rejects on timeout. A readiness timeout
(2 s) is treated as busy (`'no-answer'`), the direction that withholds a
restart.

### 5.3 Gateway additions

- `RoleCoordinator.changing(): boolean` returns true when a writer is active
  or queued. It is exported through `coordination.ts` `roleChangePending()`,
  which reads all roles.
- `BuiltinDownloads.hasActive(): boolean`.
- `src/server/update-readiness.ts` (**new**) combines them into `BusyReason[]`.
  It does not import the SDK.

### 5.4 Pending-update marker (**new**) — `userData/update/pending.json`, mode `0600`

```jsonc
{
  "schema": 1,
  "from": "0.2.23", "to": "0.2.24",
  "requestedAt": "…", "stoppedAt": "…",   // stoppedAt = gateway confirmed stopped
  "port": 8080,                            // the port hooks were using
  "tunnelWasOn": true,
  "cutOff": 0,                             // from the drain reply
  "backup": "update/backup-0.2.23"
}
```

It is written before `quitAndInstall`, read by the next launch's `main()`
before `launchGateway`, and deleted after the new gateway's `/health` answers
and the audit entry is written.

### 5.5 Prefetch ledger (**new**) — `userData/update/prefetch.json`, mode `0600`

`[{ filename, url, forVersion }]` for files the updater downloaded ahead of a
release. See §6.3 for how it is consumed.

## 6. Flows

### 6.1 Schedule

`updater.start()` is called at the end of `launchGateway`, only on the first
healthy launch of the process. `launchGateway` also runs on every restart,
and a second call would start a second schedule. The first cycle runs 30 s
later, then every 6 h, using `setTimeout` re-armed after each cycle, never
`setInterval`, so cycles cannot overlap. "Check for Updates…" runs a cycle now
and resets the timer. A cycle while `state` is `downloading` or `ready` only
refreshes the manifest (§6.8).

### 6.2 One cycle

```text
checking
  manifest = fetch + parseManifest           → none: back to idle (logged)
  if !isNewer(manifest.version, app.getVersion())         → idle, "Up to date"
  if darwin && !systemAtLeast(manifest.minimumSystemVersion.darwin)
                                              → blocked-os (menu says why)
  if linux                                    → available-linux (menu + notification)
  if !canSelfUpdate()                         → blocked-location (§6.9)
  needed = requiredMissing(manifest.catalog)  (§6.3)
  if needed non-empty                         → needs-models(version, needed)
                                                (no app download yet; §6.3)
  autoUpdater.checkForUpdates()               → downloading
    'update-downloaded'                       → ready(version)
    'error'                                   → error (logged; menu "Last check failed")
```

`isNewer` and `systemAtLeast` are numeric three-part comparisons in
`update-policy.ts`. Pre-release suffixes are not accepted, because the manifest
parser rejects them first.

On macOS, Squirrel downloads as soon as a check finds an update, and there is
no check-only call. That is why every gate sits before `checkForUpdates()`.

### 6.3 Models the next version needs

`src/setup/catalog.ts`:
`setupModelDownloads(settingsPath?, includeExtras = false, env = process.env, catalog = MODEL_CATALOG)`.
The default keeps every current caller byte-identical.
`scripts/test-desktop-lib.ts` gains the new parameter in `CatalogLib`, so the
shell/server contract check covers it.

`requiredMissing(manifest.catalog)` imports the *running* version's
`dist/setup/catalog.js` and calls it with the manifest catalogue, `true` for
extras and the gateway settings path, then passes the result to
`missingModels(modelsDir, …)`. It uses the running version's selection logic
over the next version's catalogue. If that logic itself changes between
versions, the next boot's `ensureModels` still catches the difference with
today's download screen. The prefetch reduces the outage; it does not promise
to eliminate every case.

When `needed` is non-empty, the state is `needs-models`, and the app update
itself has **not** been downloaded:

- The banner and menu offer **Download models for v{x} (N GB)** instead of a
  restart.
- That action downloads sequentially with the running version's
  `downloadModel(spec, modelsDir, onProgress)`, never overwriting an existing
  file, and appends each completed file to the prefetch ledger. It shows
  progress in the banner and does not run while `readiness` reports
  `model-download`.
- When the prefetch finishes, the cycle continues at `checkForUpdates()` and
  moves to `downloading`, then `ready`. Nothing is staged with Squirrel until
  this point, so a quit in `needs-models` installs nothing.

**On the post-update boot** (marker present), before `ensureModels`:
`adoptPrefetched(ledger, newCatalog)` keeps a file only when the new version's
own `MODEL_CATALOG`, which is inside the signed bundle, has an entry with the
same `filename` **and** the same `url`. Otherwise it deletes the file. Then it
deletes the ledger. Revision-pinned Hugging Face URLs are immutable, so "same
URL" means "same bytes the signed release was built against". That trust is
exactly what `ensureModels` has today.

### 6.4 Restart to update

Available only in state `ready`.

1. `readiness?`. If gateway or shell reasons are busy, the button stays disabled
   with the reason as its tooltip and the banner line. Stop.
2. Confirmation dialog (`dialog.showMessageBox`, modal to the console window):
   - message: `Restart to update Warden to v{to}?`
   - detail: `Warden will be offline for about {N} seconds. Prompts your team
     sends during that time are not checked.` plus, when
     `tunnel.isRunning()`: `The public address will change, and devices
     connected through it stop being checked until they are given the new
     one.`
   - N is `OFFLINE_ESTIMATE_S` in `update-policy.ts`. It is set from the
     measurement in §9 item 4 and is not guessed. Until that is measured, the
     sentence says "for a short time" and the constant is `null`.
   - buttons `Restart now` / `Later`, default `Later`.
3. Snapshot: `backupData(userData, from)` copies `data/` recursively into
   `update/backup-{from}/`, **excluding `prompts.jsonl`**. That file holds
   masked prompt text under a retention promise (`CLAUDE.md`, security
   posture), and a backup copy would outlive its sweep. Files `0600`,
   directories `0700`. Any older `backup-*` is deleted first, so one backup
   exists at a time.
4. `drain` with `boundMs = 30_000`. Gateway side (`lifecycle.ts`):
   - `server.close()`, so new connections are refused.
   - A `draining` flag checked first in the middleware chain destroys the socket
     of any new request on an existing keep-alive connection
     (`req.socket.destroy()`). The tunnel's `cloudflared` holds one such
     connection, and a hook behind it must see a transport failure (Cloudflare
     502, HTML), which fails open the same way as down, never a JSON body.
   - It waits until the in-flight counter reaches 0 or the bound passes. The
     counter is a middleware incremented on entry to `/api/guard/*` and
     `/v1/*` and decremented on `finish`/`close`. It replies `drained`
     with `cutOff` = the counter at the deadline.
5. Write the marker (§5.4) with `cutOff`, then `gateway.stop()` and
   `tunnel.stop()`, and set `stoppedAt`.
6. `quitAndInstall()`. The `before-quit` handler finds `gateway === null` and no
   tunnel, so it returns without re-stopping.

If any step before 6 throws, the gateway is relaunched with the ordinary
`restartGateway()`, the marker and backup are removed, and the error is
logged. The update stays `ready`.

**Install on quit** (PRD decision 2): when the administrator quits normally
while `ready`, `before-quit` runs steps 3–5 without the dialog and with a 10 s
drain bound, since a quit is an outage the administrator chose. Squirrel.Mac
then installs on exit. In `needs-models`, nothing is staged (§6.3), so a quit
installs nothing. The spike (S3) confirms that Squirrel.Mac never stages a
download on its own before we call `checkForUpdates()`.

### 6.5 Post-update boot

At the top of `main()`, after `readSettings`:

```text
marker = readMarker()
if marker && marker.to !== app.getVersion():
    // the install did not happen (Squirrel failed, or the user reinstalled old)
    log, delete marker, keep backup, continue normally
if marker && marker.to === app.getVersion():
    if marker.bootAttempts >= 1:      → failed-update screen (§6.6)
    marker.bootAttempts++ (written before anything else can crash)
    adoptPrefetched(...)
    launchGateway({ reclaimPort: marker.port })
    on healthy: env for audit (§6.7), delete marker, show "Updated to vX" once
```

`launchGateway({ reclaimPort })` calls `pickPort` with a new `waitMs` option
(**new**, `server-manager.ts`) that polls `portFree` every 250 ms up to
15 s before taking an ephemeral port. If it had to fall back, the console
opens with a blocking banner, and the log says: `Warden came back on port
{p}, not {marker.port}. Devices set up for {marker.port} are not being
checked.` The ordinary launch path does not pass `waitMs`.

If `marker.tunnelWasOn`, the existing cold-start restore brings the tunnel back
and the new public URL appears in the Gateway menu, as it does today. The banner
adds `Public address changed — share the new one with remote devices.`

### 6.6 Failed update boot

If `bootAttempts >= 1` on entry, the previous attempt never reached healthy.
The splash shows a new phase `update-failed` with the versions, the path to
the backup, **Open backup folder**, **Download v{from}**
(`https://github.com/Wardenlabs/warden/releases/download/v{from}/Warden-{arch}.dmg`),
and **Try again**, which resets `bootAttempts` to 0 and runs the boot. The
marker is kept until a healthy boot. Restoring the backup stays manual: an
automatic restore of governance data from inside a failing version is not
something to do on a guess.

### 6.7 Audit entry

The shell passes `WARDEN_UPDATED_FROM`, `WARDEN_UPDATED_STOPPED_AT` and
`WARDEN_UPDATE_CUTOFF` in the gateway's environment on the post-update launch
only. `src/server/boot-audit.ts` (**new**), called once after the server
listens, does the following when those variables are set:

```ts
recordAdminAction({ id: 'desktop', role: 'operator' },
  `update ${from} -> ${version}; offline ${stoppedAt} -> ${now}; cutOff ${n}`, 200)
```

The actor is `desktop`/`operator`, not an administrator identity, because the
desktop window has none (PRD). The action is a string, so the chain's shape
does not change, and `pnpm run verify-audit` covers it with no reader
changes.

### 6.8 A newer release while one is ready

Each cycle in `ready` refreshes the manifest. If `manifest.version` is newer
than the ready version, `autoUpdater.checkForUpdates()` runs again. Squirrel.Mac
replaces the staged update, and a new `update-downloaded` moves `ready` to the
new version. Notifications are keyed by version in memory, and in
`desktop-settings.json` as `lastNotifiedVersion`, so a relaunch does not
repeat one.

### 6.9 Where Squirrel cannot write

`canSelfUpdate()` returns false when any of these holds:

- `app.isInApplicationsFolder()` is false. Electron provides this on macOS; it
  covers the DMG mount and `~/Downloads`, including App Translocation.
- The bundle's parent directory is not writable (`fs.accessSync(…, W_OK)`).

In that state the menu shows **Move Warden to Applications to receive
updates…**. It calls `app.moveToApplicationsFolder()` after a confirmation,
which relaunches from `/Applications`. The notification fires once per
installation (`blockedLocationNotified` in settings).

## 7. Surfaces

### 7.1 Menu

On macOS these items go in the app menu, after About. On Linux they go in the
Gateway menu:

- `Check for Updates…`
- A state line, disabled: `Up to date`, `Checking…`, `Downloading v{x}…`,
  `v{x} needs a newer macOS`, `Last check failed — see log`
- `Restart to Update to v{x}…` in `ready`, or
  `Download Models for v{x} ({n} GB)…` in `needs-models`
- `Check for Updates Automatically` checkbox (§4)

`buildMenu()` already rebuilds the whole menu on changes. The updater calls a
`onChange` hook that runs `Menu.setApplicationMenu(buildMenu())`.

### 7.2 Notification

`new Notification({ title, body }).show()`, once per version, and only for
`ready`, `available-linux` and `blocked-location`. Clicking it focuses the
console window.

### 7.3 Console banner

**Preload.** `desktop/console-preload.cts` (**new**) exposes:

```ts
window.wardenUpdate = {
  get(): Promise<UpdateView>,            // ipcRenderer.invoke('update:get')
  onChange(cb: (v: UpdateView) => void), // 'update:state'
  restart(): void,                       // 'update:restart'
  prefetch(): void                       // 'update:prefetch'
}
```

`UpdateView` carries only what the banner renders: `{ state, version, neededMB,
progress, busy, tunnelOn }`. No paths, no URLs other than the release page, and
no settings.

The preload is attached in `openConsole` alongside the existing
`webPreferences` (`contextIsolation: true`, `sandbox: true`). The IPC handlers
in `updater.ts` check `event.senderFrame.url`'s origin against
`http://127.0.0.1:{activePort}` and `event.sender === consoleWindow.webContents`,
and ignore anything else. The `will-navigate` guard already keeps that window
on the gateway origin. This is the first preload on the console window. Its
header comment says why, so the "the console has no preload" comments in
`desktop-bridge.ts` and `main.ts` are updated rather than left contradicted.

**Console.** `web/js/update-banner.js` (**new**) renders nothing when
`window.wardenUpdate` is undefined, which is every browser, the LAN included.
Otherwise it renders a single line above the page content, per the console
copy rules in `CLAUDE.md`: the version, the consequence sentence, one action,
and no subtitle. `app.js` mounts it once. It keeps its own DOM node and does
not call the whole-page `render()` on progress, the same lesson as the Library
download progress.

## 8. CI and release

`scripts/release-manifest.mjs` (**new**) runs in the `release` job after the
artifacts are downloaded. It:

- reads `package.json` version and `dist/setup/catalog.js`, from a checkout
  plus `pnpm run build` in that job, or from an artifact the macOS job uploads.
  Prefer the artifact, so the manifest describes exactly the build being
  shipped.
- reads `LSMinimumSystemVersion` from the arm64 app's `Info.plist`, uploaded
  as a small artifact by `make-macos` with `plutil -extract`.
- writes `warden-release.json` and validates it with the same `parseManifest`,
  imported from the compiled `desktop/dist/update-policy.js`, so CI rejects what
  the app would reject.

The release job gains `artifacts/**/warden-release.json` in `files`, and a
guard that fails the job when `Warden-darwin-x64-*.zip` is missing and says so
(PRD: an Intel-less release splits the fleet). The `release` step publishes
with `prerelease: true`. Promotion to latest is a manual `gh release edit
--prerelease=false` after the check in the PRD's release discipline. Both
`update.electronjs.org` and `releases/latest/download/` ignore prereleases, so
this is what makes the check possible.

Changing the release job to prerelease also changes the landing page's
`releases/latest/download/*.dmg` links. They keep pointing at the previous
release until promotion, which is the intended effect.

## 9. Verification

**Automated** (added to `scripts/test-all.mjs`):

- `scripts/test-desktop-update.ts` (**new**) over `update-policy.ts` and
  `update-marker.ts` with a temp dir: `parseManifest` accept/reject table
  (every §5.1 rule), `isNewer`, `systemAtLeast`, `resolveAutoUpdate`
  precedence including "managed key absent", backup excludes `prompts.jsonl`
  and sets modes, marker round-trip and `bootAttempts`, `adoptPrefetched`
  keep/delete by filename+url, and one-backup-at-a-time.
- `scripts/test-desktop-lib.ts`: the `catalog` parameter in the contract, and
  `setupModelDownloads` with an explicit catalogue.
- A gateway test for drain. Start the server in-process, hold a request
  in-flight with the mock adapter delayed, send `drain`, and assert that a new
  connection is refused, a new request on a kept-alive socket is reset, the
  held request completes, and `drained.cutOff === 0`. With a bound shorter
  than the delay, `cutOff === 1`.
- Readiness: a queued `withRoleChange` makes `roleChangePending()` true, and an
  active builtin job makes `hasActive()` true.
- `boot-audit.ts`: with the env set, exactly one admin entry, and
  `verifyChain()` stays valid. Without it, no entry.

**Manual, on packaged signed artifacts** (`CLAUDE.md`: verify the artifact, not
the command). This needs two consecutive releases. Run PRD acceptance 1–14 on
macOS arm64, and additionally:

- Item 4 in the PRD sets `OFFLINE_ESTIMATE_S`. Measure from the button press to
  `/health` on the real adapter, 3 runs, report the median and the maximum,
  and add a row to `docs/MEASUREMENTS.md`.
- A hook through the tunnel during drain shows "Warden unreachable", not a
  malformed decision.

## 10. Spike before building (S1–S4)

These are unknowns only a packaged build can answer, and each one changes a
section above:

- **S1** `update.electronjs.org` matching our asset names
  `Warden-darwin-arm64-X.zip` / `Warden-darwin-x64-X.zip` for `darwin-arm64`
  and `darwin-x64`. If it does not match, either rename the Forge zip or serve
  a static feed (`{ url, name, notes }` JSON) from the release assets. §2 would
  change the feed URL only.
- **S2** How to detect *absence* of a managed `AutoUpdate` key through
  `systemPreferences` (§4).
- **S3** Whether anything stages a download with Squirrel.Mac before
  `checkForUpdates()` is reached in the `needs-models` path, for example
  "Check for Updates…" from the menu while prefetching. §6.2 avoids it by
  ordering, and the spike confirms no other path does.
- **S4** The first updater-bearing version can only be updated *to*. Cutting
  two throwaway releases to test is noisy on a public repo with landing links.
  Test against a fork, or with a `WARDEN_UPDATE_FEED` override that is honoured
  **only when `app.isPackaged` is false**. That keeps a feed override out of
  shipped builds, where it would be a way to point a gateway at someone else's
  update.

## 11. Delivery order

1. `update-policy.ts`, `update-marker.ts` and their tests. The catalogue
   parameter. No behaviour change.
2. Gateway: structured bridge messages, readiness, drain, boot audit, with tests.
3. `updater.ts` for macOS: schedule, manifest, autoUpdater, menu, notification,
   restart flow, post-update boot, failed-update splash, port reclaim.
   Settings and precedence.
4. Console preload and banner. Prefetch.
5. CI: manifest, x64 guard, prerelease. Then the two-release manual pass (§9)
   and the measurement.
6. Linux notice. Docs: `DESKTOP.md`, `SECURITY.md` (outbound connections:
   GitHub for the manifest, `update.electronjs.org`, Hugging Face for
   prefetch), and statuses on this spec and the PRD.

Windows is out, per PRD decision 6. What it will need is listed in the PRD.
