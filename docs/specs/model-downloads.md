# Model downloads from Library: technical specification

Status: implemented 2026-09-20 in the working tree; automated checks pass, the browser and Electron walkthrough in section 9 has not been run. Deviations are listed in section 11. Companion: [PRD](../prd/model-downloads.md).

Repository inspection: 2026-09-20, HEAD `9f7ca9d`, package version `0.2.18`, plus the working tree. Existing unrelated edits were present in console UI/CSS and other specs; this work doesn't change them. Names marked **new** below describe proposed files or contracts.

Approach A is the approved design: [Library download progress](https://www.figma.com/design/RFPKLtSSZjQMHy9XaOOSqp/Warden?node-id=843-1796). This spec supersedes the no-server-changes and custom-only Library constraints in [models-redesign.md](models-redesign.md), not the rest of the console architecture.

## 1. Findings in the current code

| Area | What the repository does today | Consequence |
| --- | --- | --- |
| `web/js/model-library.js` | `builtInRows()` mixes analyzer choices with a compiler row derived from runtime inventory. Missing rows offer Select for download and, only with `canLeaveDemo`, Download models. | Download isn't a row-addressed browser operation. Runtime compiler inventory can describe a custom/overridden file rather than the bundled compiler. |
| `web/js/engine.js` | `bindGetModels()` posts to `/api/gateway/leave-demo`. | Reusing its class on A's action would restart Electron rather than download one file. |
| `src/server/routes/system.ts`, `desktop/main.ts` | The route signals `leave-demo`; the shell stops the gateway and relaunches. No attached shell produces 409. | The endpoint cannot implement the new browser behavior. |
| `src/setup/catalog.ts` | `MODEL_CATALOG` contains pinned HTTPS URLs without importing the SDK. `setupModelDownloads()` adds required files and optional selected analyzer extras. | Reuse catalogue data, but don't call the batch selector for a row download. |
| `src/setup/download.ts` | `downloadModel()` performs HEAD/GET, follows redirects, resumes with Range and retries up to four times. It writes directly to the final filename. `missingModels()` accepts 90% of approximate size. | Refactor publication and cancellation before running this downloader inside a live gateway. |
| `src/models/transfers.ts` | Custom downloads use public-address-checked HTTPS, a private `.part`, size/disk limits, cancellation and in-memory jobs. Imports serialize through a private `busy` flag. | Reuse protections and coordination, not the custom destination or UUID catalogue registration. Custom retry restarts from zero. |
| `src/server/routes/models.ts` | Start/list/cancel routes exist for custom downloads; model routes inherit the global admin gate. | Add built-in start and return both job kinds through the existing list/cancel surface. |
| `src/server/routes/settings.ts` | Selecting missing analyzer weights saves a pending choice. Installed analyzer switching tests under the role lease and rolls back settings on failure. | New Download must not call selection. New Use must reject missing files without saving a pending choice. |
| `src/qvac/client.ts` | `sourceFor()` uses environment overrides, custom models, selected non-default analyzer, `warden.local.json`, conventional path, then registry. It checks existence, not transfer completion. | Partial data must never occupy a new conventional final path. An explicit default activation also needs a test against stale `warden.local.json` paths. |
| `web/js/model-library.js` | While a known job is active, it polls every two seconds and calls whole-page `render()`. It doesn't discover another admin's job while idle, and a failed jobs response replaces jobs with an empty list. | Add idle discovery, preserve stale status on failures and update progress without destroying menus or editors. |
| `src/server/lifecycle.ts` | Shutdown closes HTTP and inference, with a four-second exit bound; mock mode exits immediately. `modelState()` records boot warmup, not current file downloads. | Stop active transfers even in mock mode. Don't use the boot warmup flag as download progress or claim a download repairs runtime health. |

The existing [model management documentation](../MODEL-MANAGEMENT.md) describes custom transfer limits correctly. It doesn't provide a built-in background job API. `scripts/test-desktop-lib.ts` checks downloader exports and approximate disk presence, not HTTP Range, cancellation or atomic publication.

## 2. Architecture and scope

Keep two destination policies over shared low-level protections:

```text
Library built-in row
  POST /api/settings/models/builtins/:id/download
    built-in job service -> SDK-free catalogue lookup
      shared transfer lease -> refactored built-in downloader
        private partial file -> validation -> conventional final file

Add model / URL, upload or gateway path
  existing routes -> custom transfer service
    same transfer lease and safety helpers -> custom/<uuid>.gguf
```

The gateway owns the job. Browser disconnects don't abort it, and no transfer invokes `saveAdjudicatorSettings`, `saveCompilerSettings`, `forgetRole`, `refreshCompiler`, `modelFor` or the desktop bridge. Custom imports continue to call `putModel`; built-in downloads never do.

Refactor the existing resumable downloader instead of feeding built-in URLs to `startDownload()`. The latter would create a custom UUID, duplicate the catalogue row and leave built-in existence checks unsatisfied. Don't add a third, unrelated HTTP downloader in a route handler.

No new dependency is required. Use the existing Node streams, filesystem APIs, Zod validation and console modules. Keep new setup helpers free of `@qvac/sdk` and model runtime imports so Electron can still load them before gateway startup.

### Built-in identity

Use catalogue artifact IDs, not filenames supplied by the browser. For this release, expose exactly these physical files:

| API `builtinId` | Existing catalogue `role` | Analyzer choice | Library jobs |
| --- | --- | --- | --- |
| `adjudicator` | `adjudicator` | `default` | adjudicator |
| `adjudicator-dynaguard` | same | `dynaguard` | adjudicator |
| `adjudicator-dynaguard-8b` | same | `dynaguard-8b` | adjudicator |
| `compiler` | `compiler` | `base` | compiler, adjudicator |
| `adjudicator-large` | same | `large` | adjudicator |
| `adjudicator-shieldstral` | same | `shieldstral` | adjudicator |
| `adjudicator-granite-guardian` | same | `granite-guardian` | adjudicator |

Add an explicit SDK-free Library descriptor list beside `MODEL_CATALOG`, referring to its existing IDs; include label, permitted roles, analyzer choice and format. Validate a one-to-one match with filenames and existing analyzer choices in tests. Keep pinned URLs in `MODEL_CATALOG`, not in the new descriptor list or the browser.

One `compiler` artifact represents both uses of Qwen3 1.7B. Current selection IDs remain unchanged. Download deduplication and disk paths use the artifact ID; activation still uses the intended role and existing selection contract.

Detector, embedder, optional assistant/OCR and benchmark-only Qwen3 4B stay out of the new endpoint's accepted Library IDs. Terminal and desktop setup retain their broader catalogue access.

## 3. Proposed HTTP contract

All routes remain under the existing administrative middleware. Don't change the employee allowlist, loopback-admin policy, CORS or CSP. Files transfer server-to-server; the browser talks only to Warden.

### Catalogue response

Extend `GET /api/settings/models` additively; keep `models`, `selections`, `overrides`, `inForce`, `importAvailable` and `maxUploadBytes`.

```ts
builtins: Array<{
  id: string;
  name: string;
  filename: string;
  roles: Array<'compiler' | 'adjudicator'>;
  adjudicatorChoice: string;
  format: 'compliance' | 'dynaguard' | 'shieldstral' | 'granite-guardian';
  approxBytes: number;
  onDisk: boolean;
  verifiedDownload: boolean;
  downloadBlockedReason: string | null;
  bytes: number | null;
  activeRoles: Array<'compiler' | 'adjudicator'>;
  selectedRoles: Array<'compiler' | 'adjudicator'>;
  latestJobId: string | null;
}>;
transfer: {
  available: boolean;
  reason: string | null;
  maxConcurrent: 1;
  active: { jobId: string | null; source: string; name: string } | null;
};
```

These are new fields, not TypeScript types already exported by the repo. `approxBytes = approxMB * 1_000_000`. `onDisk` and `verifiedDownload` have the distinct compatibility meanings in section 5. `activeRoles` comes from actual in-force identities, never solely from saved settings or presence. A compiler running through a CLI/endpoint isn't active on the bundled GGUF.

`available` means the gateway supports this administrative transfer operation; it doesn't mean the directory is writable or the internet is reachable. Those checks can fail when a job starts. A busy transfer doesn't turn support off; report it through `active`. Use an explicit unavailable reason for the experimental llamacpp adapter. Mock supports downloads but remains mock.

### Start one built-in

`POST /api/settings/models/builtins/:id/download`, empty JSON body.

Validate the ID and reject extra URL/path/filename fields. Resolve both source and destination on the server. Acquire the transfer lease before acknowledging a new job; network work starts after the response.

| Status | Response / meaning |
| --- | --- |
| 202 | `{ job, reused: false }` for an accepted job |
| 202 | `{ job, reused: true }` when this artifact already has an active gateway job |
| 200 | `{ alreadyInstalled: true, builtin }`; no new job or network request |
| 404 | `{ code: 'unknown_builtin', error }` for an ID outside the Library descriptors |
| 409 | `{ code: 'transfer_busy', error, active }` for a different transfer or an external setup owner |
| 409 | `{ code: 'model_management_unavailable', error }` for an unsupported adapter |
| 409 | `{ code: 'existing_file_invalid', error }` when a final file exists but cannot qualify as installed; no overwrite |
| 400 | `{ code: 'invalid_download_request', error }` for invalid body fields |

Use typed service errors for these routes; don't rely on the current generic model route helper, which maps most failures to 400. Authorization failures retain existing status semantics. A filesystem/configuration failure before job creation returns a sanitized actionable error; after acceptance it becomes a failed job.

Retry uses this same endpoint. An interrupted/failed artifact starts a new job ID, preserving eligible partial bytes; a completed or active artifact remains idempotent. Return the latest logical attempt for each built-in rather than accumulating duplicate UI rows.

### List and cancel

Extend `GET /api/settings/models/downloads` without removing existing custom fields:

```ts
// Built-in records only; existing custom records retain their current shape.
type BuiltinDownloadJob = {
  id: string;
  source: 'builtin';
  builtinId: string;
  name: string;
  state: 'connecting' | 'downloading' | 'retrying' | 'verifying'
    | 'cancelling' | 'complete' | 'failed' | 'cancelled' | 'interrupted';
  received: number;
  total: number | null;
  attempt: number;
  maxAttempts: 4;
  modelId: null;
  error: string | null;
  errorCode: string | null;
  canCancel: boolean;
  canRetry: boolean;
  startedAt: string;
  updatedAt: string;
};
```

`received` includes a validated resumed prefix. `total` is the complete file size, not the remaining response length. Custom consumers must tolerate the new discriminator and states; records without `source: 'builtin'` continue through the custom renderer. Never expose filesystem paths, signed redirect URLs, response bodies or credentials in jobs.

Dispatch `DELETE /api/settings/models/downloads/:id` by job ownership. Built-in cancellation returns 202 with `cancelling`; publish `cancelled` only after streams close and cleanup finishes. Repeated cancellation of a cancelling/cancelled job is idempotent. A completed job cannot delete its installed file: return 409 `transfer_finished`. Unknown IDs return 404. Preserve the current custom cancellation response during this release.

After final publication begins, set `canCancel: false`; a late request returns the current terminal/non-cancellable state, not a false cancellation success. Register these routes before generic `/:id` catalogue routes.

## 4. Job ownership, concurrency and restart

**New `src/models/builtin-downloads.ts`** owns jobs and exposes catalogue status, start/list/cancel, startup reconciliation and shutdown. Inject the download runner in tests; don't replace real authentication or filesystem publication tests with mocks.

**New `src/setup/transfer-lock.ts`** owns a single lease per resolved models directory. Replace the custom service's private `busy` flag with this shared primitive. All updated writers participate: browser built-ins, custom URL/upload/path imports, terminal setup and Electron first-run. A browser-level disabled button isn't a lock.

Canonicalize the models directory with `realpath` before choosing a lock identity, so path aliases cannot acquire separate leases. Use an exclusive filesystem lock with a random ownership token and PID, plus an in-process owner record. Release only the lock owned by that token, in `finally`, after stream/file handles close. No age-only lock stealing: a slow 5 GB transfer can legitimately hold a lock for minutes. Reclaim only when the previous local process is confirmed absent; treat an ambiguous owner or permission failure as busy and explain recovery. Same-directory multi-host/network-filesystem coordination is outside the supported deployment model.

The gateway reserves a lease before returning 202 and passes it to the downloader so it doesn't acquire twice. Direct CLI/desktop calls acquire their own lease. Keep the established `downloadModel(spec, dir, onProgress?, attempts?)` positional arguments; add an optional options argument for signal, phase/retry callbacks and an internally validated existing lease. Keep `missingModels()` exported. Update the mirrored desktop type contract if needed.

Store built-in job metadata and resumable-file metadata under `<modelsDir>/.downloads/`, with private atomic JSON writes. Keep only the latest job per accepted Library artifact; the current custom map remains bounded to twenty in-memory records. Persist state transitions, source identity, expected total and validators, not every streamed chunk. Recover byte count from the partial file after a restart.

On startup, reconcile journal entries against the lease owner, private files and completed-file receipts. Jobs that belonged to a dead gateway become `interrupted`; don't start HTTP requests automatically. A valid installed result wins over a stale nonterminal journal from a crash after publication. An unreadable journal must not erase installed weights or allow untracked concurrent writes: report unavailable management and retain the file for recovery.

Explicit Cancel removes only that job's private partial and resume metadata. A recoverable failure or process interruption retains valid partials for explicit Retry; invalid data and mismatched metadata cannot resume. Retry must not overwrite another job's retained files or an installed target. Bound retained state to one partial per artifact and check actual free space before extending it.

Add transfer shutdown to `src/server/lifecycle.ts`, including its mock branch. Stop accepting new jobs, abort active I/O with an interrupted reason, flush metadata and join inference shutdown within the existing four-second exit bound. A forced exit is still possible, so startup reconciliation cannot depend on graceful cleanup having run.

## 5. Downloader and filesystem changes

### Shared helpers

Extract `inspectGGUF`, resource-limit checks and the public HTTPS transport out of `src/models/transfers.ts` into SDK-free setup helpers. Proposed files: **`src/setup/model-files.ts`** for file validation/presence/receipts and **`src/setup/model-http.ts`** for HTTPS metadata and streaming responses. Both importers and the built-in downloader use them.

The transport retains public-address checks and pins a verified DNS result for every request and redirect. Reject embedded credentials, non-HTTPS schemes, private/loopback/transition addresses and more than five redirects. This applies to HEAD as well as GET. Don't weaken the custom URL defenses to make Hugging Face redirects work; its public CDN addresses can pass the same checks.

Keep the 20 GiB bound and 512 MiB free-space reserve, rechecking disk space during streaming. Apply a 30-second idle timeout and 30-minute overall budget to the built-in job, including verification and retry delays. The HEAD request and partial-file validation also need cancellation/deadline handling. No full-file buffers or synchronous multi-gigabyte hashing on the gateway event loop.

### Resumable private files

`src/setup/download.ts` must write to a server-derived private `.part`, never the conventional `.gguf` filename. Validate safe basenames from the shipped catalogue; user input never becomes a disk path. Reject symlink targets in managed transfer paths and protect directory/file permissions.

For each partial, record the artifact ID and source fingerprint (pinned source URL/revision plus filename), expected total and an available strong validator. Reuse a prefix only when the new response confirms the same object. Use `Range` and `If-Range`; if no reliable validator exists, restart that job's partial rather than append speculatively.

A 206 response must have a valid `Content-Range` whose start equals the local offset and whose total matches metadata. Validate the returned segment length and actual received bytes. If a server ignores Range and returns 200, restart the private partial; never append the full response to an existing prefix. Treat changed validators, unexpected encoding and malformed range metadata as restart/refusal cases. A 416 can mean complete only after exact size and file validation; it isn't success by itself.

Preserve four attempts and 2/4/8-second backoff for recoverable failures. Make sleeps abortable. Don't retry missing resources, unsafe URLs, permission errors, disk exhaustion, invalid GGUF or rejected range integrity as if they were dropped sockets. When a safe restart loses reusable bytes, report the changed byte count rather than pretending progress is monotonic.

### Publication and installed receipts

Once all bytes arrive, set `verifying`. Require the exact expected length and a supported GGUF v2/v3 header before publication. Compute a local SHA-256 through an asynchronous stream, including any resumed prefix. This digest records what Warden installed; without an independently trusted upstream digest it doesn't prove publisher authenticity. Don't label it a verified upstream checksum.

Under the lease, recheck the final destination, then publish the complete file atomically on the same filesystem. Never truncate or replace a previously installed file in the download action. If another writer supplied the destination, validate/reconcile that result or refuse; don't blindly rename over it. Store a private receipt with artifact/source identity, exact byte count, SHA-256, file modification time and completion time. Completion in the API requires both a complete final file and a consistent receipt.

Handle the crash window between file publication and receipt/job updates explicitly. Keep the verified candidate metadata until receipt commit, so reconciliation can validate and finish recording the installed file without redownloading or deleting it. Failure before publication leaves the final path absent; failure after publication doesn't report the file as complete until reconciliation succeeds.

### Existing files and compatibility

New downloads must never use the 90%-of-estimate heuristic as completion evidence. Extend `missingModels()` and inventory helpers to prefer receipts and to ignore private partials. Keep its export and offline behavior; the shell loads it by name from `dist/setup/download.js`.

Existing installations have final files without receipts. Preserve them as legacy on-disk files rather than automatically redownloading, renaming or deleting them. Require a readable regular file, a supported GGUF header and the existing approximate-size threshold; don't weaken the old offline presence test to header-only. Report `onDisk: true`, `verifiedDownload: false` and `On disk · built-in`, not a newly verified download. The approximate threshold applies only to legacy presence, never to completion of a new transfer.

Known-invalid legacy files report `onDisk: false` with `downloadBlockedReason` explaining that an existing file requires repair. Keep that reason in the row/menu and reject Download with `existing_file_invalid`; this release doesn't add an overwrite/repair action. A header and approximate size still cannot prove a legacy file complete, so runtime compatibility checks remain necessary. Retrofitting trusted offline integrity requires exact-size/digest manifests and is outside this release. Resuming an old partial that already occupies the final filename also requires a separate repair/migration flow; don't silently move a potentially loaded file to make the new downloader work.

Use the shared presence helper for built-in choices and conventional runtime paths so in-progress managed artifacts or mismatched receipts don't become usable simply because `existsSync` returns true. A known-invalid managed file must produce an explicit load error, not silently fall through to a different registry source. Preserve environment-override and external `warden.local.json` path semantics; don't apply a managed-directory receipt requirement to arbitrary administrator-owned paths. Separate physical legacy presence from new-transfer completion in tests and UI.

## 6. Activation and runtime integration

Keep download completion free of settings or inference side effects. Refresh UI metadata, not the runtime. In a gateway that has no loaded weights, later normal inference may load its already configured model once files become available; downloading a different model must never select it.

For new built-in analyzer Use actions, extend `POST /api/settings/adjudicator` with `requireInstalled: true`. On this path, validate installed eligibility, supported real runtime mode and environment control before acquiring the role change; return 409 without changing settings if the candidate is unavailable, the gateway is mock/experimental, or an override controls the role. The console may download in mock mode but must disable real Use with an explanation; don't inherit the legacy mock branch's save-only success and describe it as loaded inference. Keep legacy pending-selection requests compatible when the field is absent, for old clients and desktop flows. No new console Download or missing-picker action uses that legacy path.

Retain `withModelManagement`, `withRoleChange`, compatibility testing and rollback on Use. Recheck availability under the role lease. Don't hold an inference role lease during a network transfer. Distinguish a selected-but-unloaded model from an active one, and allow explicit Use/retry for installed weights even if the saved choice already matches. Current `aria-checked` early returns must not turn that case into a dead action.

The resolver currently skips the default analyzer choice before consulting `warden.local.json`. Add a regression where explicit Use of DynaGuard 4B encounters a stale setup-config analyzer path. Ensure an explicitly saved built-in choice, including `default`, resolves to its tested file before the setup fallback, below environment/custom overrides. Preserve installations with no explicit analyzer configuration; add a settings helper that detects a valid saved analyzer choice rather than treating the default returned for missing/corrupt settings as an explicit selection. Never test one file and report another as the successful activation.

For the bundled compiler, Download installs the Qwen file without applying local compilation. Keep compiler selection through its existing Active/editor flow; don't introduce a new compiler activation endpoint or imply that a saved local configuration already loaded weights. Preserve explicit CLI, endpoint and custom model selections.

The boot-only `modelState()` flag and five-minute load-failure cooldown aren't installation receipts. A download doesn't set them to ready, switch mock to real or unload the previous judge. Analyzer Use already passes through `forgetRole`, which clears `unloadable` for that role; retain that behavior and cover it in the activation regression test. Runtime diagnostics must continue to distinguish installed files, selected configuration and an actual loaded model.

## 7. Console changes

### Library source and markup

In `web/js/model-library.js`, use the new `catalog.builtins` as the built-in file inventory. Stop constructing a purported built-in compiler row from `state.models.models`. Keep the existing custom catalogue rows separate and preserve role-specific actions. Add stable `data-builtin-id`, status-container IDs and menu trigger IDs.

Replace Select for download and `.js-get-models` in built-in rows with `data-builtin-download="<artifactId>"`. Bind it to the new endpoint; gate support on `catalog.transfer`, not `state.canLeaveDemo`. Use `data-cancel-download` for job cancellation with a pending-request guard. Never leave `.js-get-models` on these actions because `render.js` also binds that class globally.

Build row status from installed metadata plus the latest job for that artifact. Show an active job first, then installed/in-force status, then a terminal failure/interruption, then Not downloaded. A cancelled job doesn't permanently override the absent-file state. Show installed active roles only from actual in-force identities. Escape all names and error strings.

Leave custom transfers in `transferMarkup()`, filtering out `source: 'builtin'` so a built-in download doesn't appear twice. A custom job without a registered model still needs its existing transfer area. Keep Add model forms, compatibility tests and secret/file field exclusions intact.

### Polling and DOM stability

Use one timer and one in-flight read per Library controller. Poll active jobs every two seconds and, while the Models view is visible with no known active job, every ten seconds to discover another administrator's work. Refresh immediately on entry and visibility return. Stop background polling on view exit; the backend job continues. Maintain the generation/abort guard so late responses cannot repaint another route.

Don't call `render()` for every byte update. Patch the stable row's status text, progress attributes and cancel availability while retaining the arrow element, overflow menu, input focus and selection. Otherwise the 1.6-second pulse restarts every poll and Cancel disappears as soon as a menu opens. Structural/terminal changes may render the view only with stable menu identity/open-state and focus restoration; keep existing form/scroll preservation.

On a transition to complete or an external installation change, refresh the catalogue, analyzer choices and compiler/model inventory together before presenting Use. The present `loadLibrary()` refreshes only catalogue/jobs and can leave `state.adjudicator.choices[].onDisk` stale. Don't probe runtime through `/api/models` every two seconds; refresh it on entry and terminal transitions.

On status-read failure, retain the last known jobs and bytes. Mark progress as stale, stop implying live transfer activity and retry reads with a bounded delay. Don't replace failed responses with `jobs = []`, announce completion or enable a conflicting download. A later successful response reconciles all rows.

### Related entry points

In `web/js/models.js`, missing analyzer choices lead to `go('models', 'library', { model: builtinId })`, with row focus after load, rather than saving a pending selection. Installed choices keep Use with `requireInstalled: true`. Use the same deep link for missing-weights notices in `web/js/compiler.js`; remove the requirement to apply local compilation before obtaining its weights.

In `web/js/engine.js`, link managed Library files to their rows instead of invoking the desktop batch downloader. For missing supporting files outside this release, keep the setup guidance and label it as support-file setup. Preserve `/api/gateway/leave-demo` and `bindGetModels()` for the explicit desktop demo/setup flow, including its global banner; don't silently repurpose them as per-model actions. `canLeaveDemo` still controls desktop-only tunnel/demo behavior elsewhere.

The existing hash router already accepts query parameters; no router syntax change is needed. `models.js` should focus the requested row without reopening a download or altering settings when revisiting a deep link.

### Styling and accessibility

Add a download-specific SI byte formatter in `web/js/format.js`: GB = 1,000,000,000 bytes and MB = 1,000,000 bytes, with up to two decimals. Use it for both the approximate menu size and live transfer counts; prefix only the estimate with `~`. The existing `fileSize()` divides by 1024 but labels values MB/GB, while built-in `approxMB` uses decimal units. Don't reuse that mismatch or change attachment/custom-import formatting as an unrelated side effect. Test zero, unit boundaries, resumed counts and unknown totals.

Add a local download arrow to `web/js/icons.js` using the shared inline SVG helper, `currentColor` and `aria-hidden`. In `web/styles/settings.css`, reserve a two-line status slot with tabular numeric glyphs; animate only arrow opacity with the specified 1.6-second ease-in-out cycle. Keep the icon mounted between polling updates. Existing global reduced-motion rules already disable animation; verify the new rule respects them.

Use text as the primary status. Add progressbar semantics with actual received/total values when known and omit a determinate value when unknown. Keep a polite live region for state transitions outside the per-byte DOM replacement, announcing each transition once. Retry/cancel errors belong beside the affected row. Ensure the small visual dots still have a usable keyboard/pointer target and a model-specific accessible label.

Preserve the current menu system and design tokens. Only adjust `web/styles/responsive.css` if narrow-width checks require it; that file and `web/js/ui.js` already had unrelated local edits during inspection. No new framework, icon package, global tray or expanded transfer panel.

## 8. File impact

| File | Planned change |
| --- | --- |
| `src/setup/catalog.ts` | Add the explicit Library descriptor mapping over existing pinned catalogue entries. Preserve batch setup selection. |
| `src/setup/download.ts` | Add abort/phase hooks, private resumable files, validated Range handling, atomic publication and receipts while preserving desktop exports. |
| `src/setup/model-http.ts` **new** | Shared pinned-public-address HEAD/GET transport extracted from custom imports. |
| `src/setup/model-files.ts` **new** | Shared limits, GGUF inspection, managed-file presence and completion receipts. |
| `src/setup/transfer-lock.ts` **new** | Shared in-process/filesystem transfer lease for updated gateway, CLI and desktop writers. |
| `src/models/builtin-downloads.ts` **new** | Background built-in jobs, bounded persisted state, reconciliation and cancellation/shutdown. |
| `src/models/transfers.ts` | Use shared helpers/lease without changing custom UUID storage, test requirements or retry-from-zero behavior. |
| `src/server/routes/models.ts` | Add built-in start; extend catalogue/list/cancel with typed errors and test injection. |
| `src/models/manager.ts` | Expose built-in inventory/transfer metadata through the catalogue response without registering custom entries. Keep inference operations separate. |
| `src/server/routes/settings.ts` | Add installed-only Use mode and shared presence checks for analyzer choices. |
| `src/settings.ts`, `src/qvac/client.ts` | Distinguish an explicit saved default from fallback settings; resolve the tested built-in consistently and reject incomplete managed artifacts. |
| `src/server/lifecycle.ts` | Reconcile jobs before exposing download state; stop transfers during bounded shutdown, including mock mode. |
| `desktop/first-run.ts`, `scripts/setup.ts` | Adapt optional downloader hooks/contracts as needed; participate in locking and publication without changing their batch-selection UX. |
| `web/js/model-library.js` | Canonical built-in rows, start/retry/cancel actions, status mapping and non-destructive polling. |
| `web/js/models.js`, `web/js/compiler.js`, `web/js/engine.js` | Link missing weights to Library; keep Download separate from Use and explicit desktop setup. |
| `web/js/data.js` | Reuse existing refresh functions; change only if a shared terminal-refresh helper avoids duplicate reads. |
| `web/js/format.js` | Consistent decimal sizes for built-in download estimates and progress; leave other formatters unchanged. |
| `web/js/icons.js`, `web/styles/settings.css` | Download arrow, compact progress treatment and motion. |
| `web/styles/responsive.css` | Conditional narrow-layout fix after visual checks; preserve concurrent edits. |
| `scripts/test-builtin-downloads.ts` **new**, existing test suites | Cover transport, jobs, API/auth, storage and console behavior. Register the new suite in `scripts/test-all.mjs`. |
| `docs/MODEL-MANAGEMENT.md` | Update the shipped contract only when implementation lands; replace the restart-only built-in instructions. |

No guard pass, aggregation, prompt template, policy schema or security configuration change belongs in this feature. `src/models/store.ts` retains the custom catalogue format; reuse its atomic JSON helper only if the dependency direction remains SDK-free. Keep desktop download modules free of runtime imports.

## 9. Tests and verification

Write failing tests for the new contract before implementation. Use temporary directories and tiny GGUF fixtures with supported headers, not real multi-gigabyte downloads. The existing desktop tests use `test-weights` strings; update those fixtures when file-presence checks start inspecting headers.

### Downloader and job tests

| Case | Assertion |
| --- | --- |
| Normal response | Private bytes remain unavailable until exact-size/header verification and publication finish. Receipt and job agree. |
| Range continuation | Valid 206 resumes at the exact offset; total/received refer to the whole file. |
| Unsafe continuation | Ignored Range, changed validator, malformed Content-Range, 416 and compressed responses never corrupt an appended file. |
| Resource failures | Oversize, disk exhaustion, timeout, missing length, short response and invalid GGUF don't install a file or leak a live lease. |
| Retry/cancel | Backoff is bounded and abortable; cancel during HEAD, GET, retry or verification closes resources before terminal cleanup. |
| Publication race | A pre-existing/competing final file survives; late cancellation can't delete a successful installation. |
| Process recovery | Interrupted journals become Interrupted; safe partials can resume only after Retry. Crash after publication reconciles receipts without losing weights. |
| Compatibility | Legacy valid files stay available offline without a false verified claim. Invalid receipts/managed partials don't pass presence checks. |
| Concurrency | Same-model starts coalesce; different/custom/CLI writers can't acquire a second lease; stale/ambiguous owners follow the stated rules. |
| URL boundary | HEAD/GET/redirect DNS checks reject unsafe addresses. No browser-provided URL/path reaches the built-in transport. |

Inject metadata/body transports or a controlled TLS fixture at the transport boundary. Don't add a production flag that permits HTTP/private sources just to make tests easier. Test DNS/address policy separately from simulated network failures.

### API, runtime and console tests

Extend `scripts/test-model-management.ts` with real Express authorization, unknown-ID rejection, duplicate starts, competing imports and cancellation ownership. Use fake runtime loading only where inference would be expensive. Verify settings bytes and loaded identities remain unchanged throughout a download, including when an environment override or a custom judge is active.

Add installed-only Use cases, rollback on load failure, default-selection precedence over stale setup config and selected-but-unloaded retry. Keep native guard formats attached to the loaded model. `scripts/test-native-guards.ts` must still pass and check the new Library descriptor mapping against analyzer choices.

Extend `scripts/test-console.mjs` to cover `canLeaveDemo: false`, one-file POSTs, unknown total, each terminal state, stale status, another admin's job, Qwen deduplication and terminal inventory refresh. Replace expectations for Select for download and the compiler's apply-before-download dependency. Simulate a poll while the menu is open and while Add model contains unsaved fields; verify stable DOM updates rather than only checking static markup.

Keep `scripts/test-desktop-lib.ts` export checks and batch selector coverage. Add proof that setup helpers don't import the QVAC runtime into Electron main. Register the new isolated backend suite in `scripts/test-all.mjs`; a dedicated package script is optional, not required to run it.

Implementation verification commands:

```sh
pnpm run typecheck
pnpm exec tsx scripts/test-builtin-downloads.ts
pnpm run test:model-management
pnpm run test:desktop
pnpm exec tsx scripts/test-native-guards.ts
pnpm run test:console
pnpm test
pnpm run build
```

The new suite doesn't exist yet. Use Node 22.17+; no command above constitutes verification of this documentation-only change until the implementation and tests land.

Manually run the built server in a browser without Electron, against an isolated installation, and verify A at desktop and narrow widths in light/dark themes. Exercise menu/focus preservation, reduced motion, refresh, navigation, another administrator, connection loss and cancellation. Start a small controlled fixture download first; any real Hugging Face download needs deliberate test setup and disk budget. Confirm the gateway PID stays constant and the old judge still answers. Repeat the console path in Electron, then check first-run setup separately.

## 10. Delivery sequence and review gates

1. Land catalogue identity, shared lease/file/HTTP primitives and downloader regression tests. Keep the exported desktop contracts working; don't expose the new browser button before the service can protect live files.
2. Add built-in jobs, recovery/shutdown and the authenticated API. Verify custom import contention and no selection writes. Cover installed-only Use and resolver identity before connecting UI actions.
3. Implement A's rows and focused polling; update related missing-model links and console tests. Compare the built browser screen with the approved Figma frame.
4. Run the complete checks, document the shipped API in `docs/MODEL-MANAGEMENT.md` and attach browser/desktop evidence to the implementation PR.

Review the PRD scope before coding: seven selectable physical files, one transfer at a time, no automatic restart-resume, no browser demo-to-real transition, and custom transfer UI unchanged. These are recommended limits, not additional product approvals inferred from choosing A.

The most consequential compatibility decision is legacy files: preserve usable installations without pretending an approximate size or GGUF header proves complete historical downloads. If the release must verify every existing byte against upstream metadata offline, obtain trusted exact-size/digest manifests first and revise the scope; don't hide that work behind the new status icon.

## 11. Implementation notes

Recorded when the work landed, where it differs from or sharpens the text above.

- **Transfer budget.** The 30-minute budget applies to gateway jobs only. `downloadModel` takes it as an option and terminal/first-run setup pass none, as before: 5 GB on a 20 Mbit line is a legitimate 35 minutes there. A job that hits the budget fails as retryable and Retry continues from the partial. Granite Guardian (6.88 GB) needs about 31 Mbit/s sustained to finish inside one budget.
- **Publication.** A hard link, which fails on an existing destination instead of replacing it, with a rename fallback only where links are unsupported. A destination supplied by another writer mid-transfer is refused (`existing_file_invalid`), not reconciled.
- **Lock reuse of our own PID.** A lock naming this process's PID with no lease held in this process is treated as stale. Without that, a container that always restarts as PID 1 would read its previous life's lock as a live owner forever.
- **Failed and interrupted jobs cannot be cancelled.** Their partial is retained for Retry and bounded to one per file; there is no discard action in this release.
- **Compiler Use.** Unchanged, per section 6: the Qwen row offers Use for analysis only, and local compilation is still applied from Active.
- **Not covered by automated tests.** Built-in analyzer Use with the real runtime (load, rollback and `forgetRole` clearing the cooldown) still runs through `RealQvacAdapter` directly and is exercised only by hand; the mock-mode refusal and the unchanged-settings guarantee are tested. Real DNS pinning is tested as address policy, not against a live resolver.
