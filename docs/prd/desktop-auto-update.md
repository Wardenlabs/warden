# Desktop auto-update

Status: **proposed**, 2026-09-24. Nothing here is implemented yet.

Technical companion: [desktop-auto-update spec](../specs/desktop-auto-update.md).

## Problem

The desktop app never learns that a newer Warden exists. `docs/DESKTOP.md`
lists it as a known limit ("no auto-update: install the new version on top"),
and the cost is concrete: on 2026-09-24 the owner's own machine was running
0.2.18 while 0.2.23 was the latest release, five versions and three days behind,
with nothing in the app to say so. Several of those releases were security
hardening (`docs/SECURITY-REVIEW-2026-09-21.md` ends with "roll out the updated
app"). A gateway that enforces policy and stays silently stale is a gap in the
product, not a matter of convenience.

## What exists today (verified 2026-09-24)

- No update code anywhere in `desktop/`: no `autoUpdater`, no
  `update-electron-app`, no `electron-updater`.
- macOS release builds are **signed and notarized** (Developer ID, team
  `39D23XHM5Z`; `spctl` reports "Notarized Developer ID"). Squirrel.Mac
  requires exactly this, so real in-place updates are possible on macOS.
- The repository `Wardenlabs/warden` is **public**, which is the only
  requirement `update.electronjs.org` places on the repo.
- Each release publishes `Warden-arm64.dmg`, `Warden-x64.dmg`,
  `Warden-Setup.exe`, `Warden-darwin-arm64-X.zip`, `Warden-darwin-x64-X.zip`
  and `Warden-win32-x64-X.zip`. The macOS zips are what Squirrel.Mac consumes.
- Windows ships a Squirrel installer, but the release job uploads only
  `*.dmg`, `*.zip` and `*.exe`. Squirrel.Windows updates need the `RELEASES`
  file and the `*-full.nupkg` that `maker-squirrel` produces, and those are
  not published. Windows builds are **not code-signed**.
- `desktop/main.ts` does not handle the `--squirrel-*` startup events, so
  Windows installs never create or remove Start-menu shortcuts through Squirrel.
- User data (policy, directory, audit, models, settings) lives in the user's
  app-data folder, outside the bundle, so replacing the app does not touch it.
- `gateway.stop()` (`desktop/server-manager.ts`) sends `shutdown` to the
  gateway's `utilityProcess`, which exits within 4 s, with `kill()` as a
  backstop at 5 s.

## Decisions taken

Owner's answers, 2026-09-24:

1. **Full auto-update**, not just a notice: check, download in the background,
   and have the update ready to install. macOS and Windows.
2. **The administrator decides when to install.** A downloaded update shows a
   "Restart to update" action. If nobody presses it, the update is installed the
   next time the app quits.
3. **On by default, can be turned off.** It checks at launch and periodically,
   with a switch in the app and an environment variable for organisations that
   do not allow the machine to reach the internet.
4. This PRD lives in `docs/`.
5. **The console banner shows only in the desktop app's own window.**
   Restarting is an action on the machine Warden runs on, so only the person at
   that machine is offered it. Admins using the console from elsewhere on the
   LAN do not see it and cannot trigger it.
6. **macOS first. Windows stays manual until its builds are code-signed.**
   Without a signature, an update would be trusted only because it came over
   HTTPS from GitHub. That is not enough for the process that enforces policy.
7. **Linux gets a notice, not an update**: "Warden vX.Y.Z is available" with a
   link to the releases page.

## Why installing is not just a restart

Installing restarts the gateway, and while it is down every connected hook
reaches nothing. `integrations/warden-hook.mjs` prints "Warden unreachable…"
and **lets the prompt through unchecked** on a transport failure. That fail-open
behaviour is documented in `SECURITY.md` as a deliberate trade. A refused
connection fails in milliseconds rather than at the 90 s deadline, so every
prompt sent during the restart window goes through unguarded.

So an update is a **security-relevant event**, not a background detail:

- It is never installed without an administrator either pressing the button or
  quitting the app themselves. That is decision 2, and the reason for it.
- The confirmation text says what happens: *"Warden will be offline for about N
  seconds. Prompts sent by your team during that time are not checked."* N is
  measured, not guessed (see Acceptance).
- Decisions already in progress finish before the process stops. Today's
  shutdown gives the gateway 4 s. The update path waits for in-flight decisions
  (the role lease from `src/qvac/coordination.ts` is the natural signal), with
  an upper bound, and records in the log whether it had to cut any off.
- **With a public tunnel on, the address changes.** `desktop/tunnel.ts` runs a
  Cloudflare *quick* tunnel, whose `*.trycloudflare.com` URL is new on every
  start. Hooks configured with the old URL fail open until someone rewires
  them. When the tunnel is on, the confirmation says so explicitly, and the new
  URL is shown after the restart. That turns a short gap into an open-ended one,
  and the administrator has to know before pressing the button.
- The audit gets an entry for the update: from-version, to-version, who
  confirmed it, and when the gateway was down. The gap in coverage then appears
  in the governance record instead of being inferred from missing traffic.

## Design

### Mechanism

Use Electron's built-in `autoUpdater` pointed at `update.electronjs.org`:

```
https://update.electronjs.org/Wardenlabs/warden/${process.platform}-${process.arch}/${app.getVersion()}
```

This needs **no new dependency**: `autoUpdater` ships with Electron, and
`update-electron-app` is only a wrapper around this call plus a dialog we would
replace anyway. The service reads the repo's GitHub releases, so publishing a
release stays exactly the same as today, apart from the Windows files below.

Rejected alternatives:

- `electron-updater` (electron-builder). A second packaging ecosystem beside
  Forge, and a new dependency that does not survive being written down.
- A self-hosted feed. Another server to run and to secure, for no gain while
  the repository is public. Worth revisiting if the repo goes private or if
  sending version and IP to a third party becomes unacceptable (see Privacy).

### Where it is off

- Unpackaged runs (`app.isPackaged === false`, i.e. `pnpm run app:dev`).
- `WARDEN_SMOKE=1` runs in CI.
- Windows, until its builds are signed (decision 6). No feed request is made.
- Linux: there is no Squirrel for Linux and we ship only a zip. Instead, the
  same schedule reads `api.github.com/repos/Wardenlabs/warden/releases/latest`,
  compares `tag_name` to `app.getVersion()`, and shows the menu item and a
  notification linking to the release (decision 7). Nothing is downloaded.
- When `WARDEN_AUTO_UPDATE=0` is set. In that case the in-app switch is shown
  disabled, with a note that the environment turned it off. That matches how
  environment overrides already beat saved settings elsewhere.

### When it checks

- Once, about 30 s after the gateway reports healthy, so it never competes
  with model warm-up.
- Then every 6 hours while the app runs.
- On demand from **Warden → Check for Updates…** in the app menu (the Gateway
  menu on Windows).

Download starts automatically once an update is found (decision 1). Once
downloaded, there is nothing more to fetch until the administrator acts.

### States and surfaces

`idle → checking → downloading → ready | error`, owned by the main process.

| Surface | What it shows |
|---|---|
| App menu | "Check for Updates…"; "Restart to Update to vX.Y.Z…" when ready; checkbox "Check for updates automatically" |
| Native notification | Once per downloaded version: "Warden vX.Y.Z is ready. Restart when your team can spare a minute." |
| Console banner | Desktop window only (decision 5). When ready: version, the offline-time sentence, and a **Restart to update** button |
| Confirmation dialog | The offline-window warning above, plus Restart / Later |

Errors (network, feed, signature) are logged to `logs/warden-gateway.log` and
shown as one line in the menu ("Last check failed — see log"). They never
produce a dialog: a failed check is not the administrator's problem until they
ask.

### Settings

`desktop/settings.ts` gains `autoUpdate: boolean`, default `true`, read the
same defensive way as the other fields. Only an explicit `false` turns it off.
Turning it off stops scheduled checks; "Check for Updates…" still works.

The banner reaches the console through a minimal preload attached to the
desktop console window only. It exposes the read-only update state and one
restart call, and is loaded only when the window's origin is the local gateway.
A browser tab, including one on another LAN machine, gets the page without
the preload and therefore without the banner. That is decision 5 enforced by
construction rather than by a check in the page. It is the first preload the
console window has had, and the header comment in `preload.cts` needs to say
why this one exists.

### Windows specifics (deferred until signing, decision 6)

What enabling it will take, recorded now so it is not rediscovered:

- Handle the `--squirrel-install/-updated/-uninstall/-obsolete` startup events
  at the top of `main.ts` (shortcut creation/removal, then exit) before
  `requestSingleInstanceLock`. Without it, the relaunch after an update can hit
  the single-instance lock of the dying process.
- Add `artifacts/**/RELEASES` and `artifacts/**/*.nupkg` to the release job in
  `.github/workflows/desktop.yml`.
- Sign the Windows build and its `nupkg`s in CI, and publish the certificate's
  identity in `SECURITY.md`.

### Turning it off on managed Macs

`WARDEN_AUTO_UPDATE=0` is not enough on its own. A macOS app opened from the
Dock or Finder does not inherit the shell's environment, so an organisation
that sets the variable in a profile has turned off nothing. The desktop also
reads the managed preference `AutoUpdate` (boolean) in the `com.warden.gateway`
domain via `systemPreferences.getUserDefault`, which an MDM configuration
profile or `defaults write` can set. Precedence: managed preference, then
environment, then `desktop-settings.json`. Either of the first two shows the
switch as disabled, with a note saying why.

### Edge cases

Each of these was found by reading the code the update path goes through, not
by running it. Acceptance covers the ones that can be exercised.

**The gateway must come back where the hooks expect it.** `pickPort` in
`desktop/server-manager.ts` falls back to an ephemeral port when the preferred
one is busy. After an update, "busy" can simply mean the old process has not
released it yet. A gateway that returns on another port is one every hook
fails open against, silently. The update relaunch waits for the previous port
(bounded, about 15 s) instead of taking a new one. If it still cannot bind, it
says so in the window and the log as a coverage failure, not as a routine port
change.

**An update never surprises anyone with a model download.** On every boot,
`modelsPresent` asks the *new* version's catalogue what must be on disk. A
release that changes a default model would send the gateway to the download
screen, a multi-gigabyte outage where the confirmation had promised seconds.
Pinning the previous model is not a real option: the analyzer choice
`default` means whatever file the running version's catalogue says, and prompt
forms follow the model family. The rule instead: each release publishes a
small manifest listing the files it requires. Before offering the restart, the
running version compares that list with what is on disk. If anything is
missing, it offers to download those files *first*, while the current gateway
keeps guarding, and "Restart to update" stays disabled until they are there.
The new version uses a pre-downloaded file only if its own signed catalogue
names the same file at the same revision-pinned URL. (Revised 2026-09-25,
after reading `setupModelDownloads`; the first draft said "never changes the
active models", which the code cannot honour.)

**Versions get skipped.** A machine that was off, or had checks turned off,
jumps from 0.2.18 straight to the latest. Every data migration must read *every*
older shape still in the field, not just the previous release's, and has to be
tested from the oldest version the updater shipped in.

**Old hooks, new gateway.** The gateway now advances on its own while employee
hooks do not. A release must keep accepting the hook protocol of the releases
before it. A breaking change there would turn an automatic update into the whole
team failing open. Detecting stale hooks already exists; being compatible with
them becomes a release requirement.

**A bad release reaches everyone within six hours, and Squirrel cannot roll
back.** Releases become deployments:
- Publish as a prerelease first. `update.electronjs.org` only serves full
  releases, so a prerelease can be installed by hand and checked before
  promotion.
- Fix forward with a new version. Deleting or editing a release does not undo
  machines that already installed it.
- Intel builds are best-effort in CI. A release with no `darwin-x64` zip leaves
  Intel Macs behind silently. The release job should fail or say so, rather than
  let the fleet split.

**The first boot after an update can fail.** Before quitting to install, the
old version writes `pending-update.json` (from-version, to-version, time) and a
copy of `data/` without `models/`: small JSON files, the only things a
migration could damage. The new version removes the marker once `/health`
answers. A marker still present at the next launch means the update did not
come up. The splash then says so, links to the previous version's DMG, and
points at the backup, instead of looping.

**The audit entry is written after the fact.** The old gateway is gone before
the downtime is known, so the new version writes the entry from the marker:
versions, when it went down, when it came back. "Who" is recorded as the
desktop operator. The desktop window has no administrator identity, and the
audit must not claim one.

**Squirrel.Mac cannot replace an app it cannot write.** An app run from the
mounted DMG or from `~/Downloads` (App Translocation), or installed in
`/Applications` by another user, fails every update. The desktop detects this
before downloading and shows "Move Warden to Applications to receive updates",
once, instead of a failure every six hours.

**Do not restart in the middle of administrative work.** "Restart to update" is
disabled while first-run or a model download is in progress, or while a role
lease is held for a model activation. A restart there aborts work that has its
own rollback semantics (`docs/MODEL-MANAGEMENT.md`).

**Another version is released while one is waiting.** If 0.2.25 appears while
0.2.24 is already downloaded, the newer one is downloaded and it replaces the
banner. The notification fires once per version, never repeatedly for the
same one.

**Electron raises the minimum macOS version.** A major Electron bump can drop an
older macOS, and the feed has no way of knowing which macOS the client runs.
Squirrel would install an app that does not launch. The release manifest
carries the minimum macOS version, and the updater compares it against the
running system before downloading anything.

### Privacy

Each check sends the service the machine's IP, platform, architecture and
current Warden version. It sends nothing about policy, prompts, people or
audit. `update.electronjs.org` is run by the Electron project, and GitHub
serves the download itself. This goes in `SECURITY.md` beside the other
outbound connections, with `WARDEN_AUTO_UPDATE=0` as the way to stop it.

### Data compatibility

Squirrel never downgrades, and reinstalling an older DMG over data that a newer
version has migrated is untested. Any release that changes the shape of files
in the data folder must still read the previous shape, and its release notes
must say that the data was migrated. That rule is not new, but auto-update
makes it bite without anyone choosing to upgrade, so it gets written down here.

## Out of scope

- Updating employee hooks. The Gateway screen already reports "devices on a
  hook older than this gateway". Refreshing hooks is a separate piece of work
  with its own trust questions.
- Forced or critical updates, delta updates, and release channels (beta/stable).
- Code-signing Windows, and therefore Windows auto-update (decision 6).
- Any restart button outside the desktop window (decision 5).

## Acceptance

1. A packaged, signed 0.2.N on macOS arm64 finds 0.2.N+1 on GitHub, downloads
   it, shows the menu item, the notification and the banner, and after
   **Restart to update** comes back as 0.2.N+1 with the same policy, directory,
   audit chain (`pnpm run verify-audit` passes) and models.
2. The same with "Later", followed by quitting: the next launch is 0.2.N+1.
3. With `autoUpdate: false`, no request reaches `update.electronjs.org`
   during 10 minutes of runtime. Check with a proxy or `nettop`, not by reading
   the code. With `WARDEN_AUTO_UPDATE=0` the switch is disabled.
4. The offline window from pressing Restart to `/health` answering again is
   **measured** on arm64 with the real adapter, and that number is what the
   confirmation dialog says. The splash measured about 30 s of warm-up on a
   first start, so do not assume it is short.
5. A decision in progress when Restart is pressed finishes and is recorded, or
   the log says it was cut off.
6. With the public tunnel on, the confirmation warns that the address will
   change, and the new address is shown after the restart.
7. The console opened in a browser (local or LAN) never shows the banner.
8. With the preferred port held by another process during the restart, the
   gateway does not silently come back on another port.
9. An update whose catalogue requires a model not on disk offers to download
   it before the restart, and after the restart boots with no download screen.
10. Updating from the oldest updater-bearing version to the newest (skipping
    the ones in between) preserves policy, directory and audit.
11. A new version killed before `/health` answers leaves a marker. The next
    launch shows the failed-update screen with the link and the backup.
12. The `AutoUpdate=false` managed preference, set with `defaults write`, turns
    checks off for an app opened from Finder.
13. An app run from the mounted DMG shows the move-to-Applications notice and
    downloads nothing.
14. Unpackaged, smoke and Windows runs make no update request. A Linux zip older
   than the latest release shows the notice and link, and downloads nothing.

Per `CLAUDE.md`, all of this is verified on the **packaged artifact**, not on
`app:dev` or a successful `app:make`. Testing needs two real signed releases.
The first release that contains the updater cannot update itself. It can only
be updated *to*, so owners on 0.2.23 or older still install by hand one last
time.

## Delivery

1. Settings field, env override, macOS updater, menu, notification, the
   drain-before-restart and the tunnel warning. Release it, then release a
   trivial follow-up to exercise acceptance 1–6 on macOS arm64 (Intel is
   best-effort in CI, as it already is).
2. Console banner through the desktop-only preload, the audit entry, and the
   Linux notice.
3. Docs: `DESKTOP.md` replaces the known limit with how updates work,
   `SECURITY.md` gains the outbound connections (the update feed, and the
   GitHub API on Linux), and this file moves from proposed to what shipped.

Windows follows as its own piece of work once signing exists.

## Open questions

1. **Quiet hours.** Should "install on quit" also skip a quit that happens
   during working hours? Probably not, since a quit is already an outage the
   administrator chose, but it is worth one sentence of agreement.
2. **Measured offline window.** If acceptance 4 comes back well over a minute
   (for example, warm-up of the 4B judge on an older Mac), is "Later, then
   install on quit" still the right default? Or should the banner suggest a time?
3. ~~Minimum OS.~~ Resolved by the release manifest: it carries the minimum
   macOS version, and the updater does not download a release this Mac cannot
   run.
