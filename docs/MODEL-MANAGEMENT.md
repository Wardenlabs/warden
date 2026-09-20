# Models in an administrator's installation

The Models screen shows the two independent jobs: **compilation** writes policy
drafts; **analysis** judges employee requests. The saved catalogue belongs to the
gateway installation. Administrators of the same gateway share it. It is not a
separate catalogue per administrator account or a multi-tenant hosting service.

Each role also exposes **Edit prompts**. Administrators can read and customize
the complete compiler and analyzer templates, independently of the selected
weights or connection. Prompt settings are shared by this installation and
remain associated with their role and format when a model changes. See
[prompt management](PROMPT-MANAGEMENT.md) for variables, restoration, concurrency
and the limits of template validation.

Compilation can use a local GGUF, a supported installed CLI, or an endpoint that
implements OpenAI-style `/chat/completions` with structured JSON output. An
endpoint on `localhost`, `127.0.0.1`, or `[::1]` may use HTTP without an API key.
Other endpoints require HTTPS and a key. Provider presets are conveniences;
successful testing determines compatibility, not the provider's name.

For installations without a saved compiler, Claude Code is the initial choice.
The console guides the administrator through installation, sign-in, connection
testing and applying the choice. Existing selections remain intact. See
[compiler setup](COMPILER-SETUP.md) for the startup behavior and API contract.

Analysis always runs locally through QVAC. A custom endpoint cannot be assigned
to it. Model management is not available under the optional experimental
`WARDEN_ADAPTER=llamacpp` benchmark adapter. The compiler's initial choice does
not change analyzer weights, aggregation rules or measured accuracy claims.

## Adding and selecting a model

- Save a named compiler connection, including its model identifier and endpoint.
- Import an existing GGUF from an absolute path on the gateway computer, upload
  a GGUF from the browser, or download one from a public HTTPS URL.
- For local weights, choose the permitted roles and the analysis format:
  `compliance` for general instruction models or `dynaguard` for weights trained
  for DynaGuard's policy PASS/FAIL question. Use `shieldstral` or
  `granite-guardian` for their native binary formats (analyzer-only). Custom formats are stored explicitly;
  renaming the file cannot change them.
- Test each intended role, then select it. A test checks loadability and
  structured-output compatibility. It does **not** measure the model's policy
  accuracy. Use the benchmark and repeated corpus evaluation before relying on
  different judge weights in production.

The settings expose the selected configuration separately from the loaded
local model. A null `inForce` means no local weights currently occupy that role;
it is not a claim that loading succeeded. Endpoint compiler settings are applied
to the next compiler call without restarting the guard. Environment overrides
remain authoritative and prevent activating a custom selection that would be
ignored.

An active model must be replaced before its catalogue entry can be edited or
deleted. Editing clears its test results. Deleting an inactive imported model
removes Warden's managed copy; it does not delete the original source file.
Changing an endpoint address never silently carries its saved credential to the
new address. Supply the new endpoint's key or use an unauthenticated loopback
server.

## Optional native guards

Models → Request judge → Change model offers Shieldstral 1.0 3B (Q6_K,
2.82 GB) and Granite Guardian 4.1 8B (Q6_K, 6.88 GB). They also appear in
Models → Library, where a missing model's row menu offers **Download**. The
loaded judge remains in force throughout; nothing restarts. Once the file is on
disk the same menu offers **Use for analysis**, which tests the weights before
switching and restores the previous selection if the test fails. Both run
locally. DynaGuard remains the default.

Shieldstral uses its native instruction/query/document question and bare yes/no
answer. Granite uses its two-user-turn guardian protocol and a score tag.
For each rule, yes means VIOLATES and no means COMPLIES. Invalid or truncated
answers fail closed. Both retain nonce isolation and editable, request-snapshot
prompt templates. These binary classifiers cannot generate suggested rewrites.
Shieldstral is text-only here; attachments use Warden's existing local extraction.

Downloads are pinned to upstream revisions. Shieldstral's GGUF is from noctrex;
Granite's GGUF is from IBM. Both are Apache 2.0. These are optional, unmeasured
candidates: successful runtime tests do not establish policy accuracy. See
[measurements](MEASUREMENTS.md) for the limited integration evidence.

## Storage and transfers

The catalogue is `models.json` beside `WARDEN_SETTINGS_PATH` (normally
`data/models.json`); `WARDEN_MODEL_CATALOG_PATH` overrides that location.
Imported weights are copied into `<WARDEN_MODELS_DIR>/custom/<uuid>.gguf`.
The catalogue and settings are atomically replaced with mode `0600`, preserving
unrelated settings. An unreadable existing file is retained and edits fail
instead of erasing its contents. As with the existing settings file, provider
keys are plaintext at rest; the browser receives only `hasKey` and a short
suffix, never the key or the validation fingerprint.

All model endpoints require the existing administrative authorization. Gateway
path import additionally requires a direct loopback request; a remote
administrator uploads file bytes instead of gaining a gateway-filesystem read
capability. No uploaded filename is used as a destination path.

Transfers stream to a private partial file. The maximum is 20 GiB, one transfer
at a time, with a 30-minute deadline, disk-space checks and cleanup on failure or
cancellation. File size and the GGUF v2/v3 header are checked before the managed
copy is registered. A SHA-256 digest is computed while streaming; file size and
modification time must still match before a test or activation. The actual QVAC
load and structured response are checked separately by **Test**.

URL downloads accept public HTTPS sources, pin a verified public DNS address
for every redirect, reject local/private/transition addresses and embedded URL
credentials, and follow at most five redirects. Transient network errors retry
up to three times. A retry starts a new partial transfer; it does not resume
bytes from an arbitrary server. Progress and cancellation remain available
while downloading. Jobs are held in memory (up to twenty); a gateway restart
does not resume a custom download.

### Built-in downloads

Since 2026-09-20 the gateway fetches its own built-in weights, one file at a
time, from the model's Library row. It works in a browser against `pnpm run dev`
or a built server as well as in the desktop app, and does not depend on an
attached shell. The job belongs to the gateway: closing the browser does not
stop it, and another administrator's browser finds it within ten seconds.

Seven physical files are offered: DynaGuard 4B, 1.7B and 8B, Qwen3 1.7B, Qwen3
8B, Shieldstral 1.0 3B and Granite Guardian 4.1 8B. Qwen3 1.7B is both the local
compiler and the `base` analyzer seat; it is one row and one transfer. The
detector, the embedder, the optional assistant and OCR files are not in the
Library and still come from `pnpm run setup` or the desktop first run. A
downloaded judge does not by itself make a gateway ready to serve.

A download changes a disk and nothing else. It writes no selection, loads and
unloads no model, and leaves mock mode mock. **Use** is a separate action with
the compatibility test and rollback described below. The browser sends an id
from the shipped catalogue and an empty body; the source address and the
destination path are resolved on the gateway and are never accepted from a
request.

Bytes arrive in `<WARDEN_MODELS_DIR>/.downloads/<filename>.part` (directory mode
`0700`, files `0600`), never at the final filename, because the resolver treats
a file at the conventional path as loadable. When the exact declared length has
arrived and the GGUF v2/v3 header checks, the file is published with a hard link
that fails rather than replaces, and a receipt records its size, modification
time and a locally computed SHA-256. That digest records what Warden installed.
No upstream digest is pinned, so it is not a verified publisher checksum and the
console does not call it one.

An interrupted transfer resumes with `Range` and `If-Range` only when the server
returns the same strong validator and a `Content-Range` that starts at the local
offset and names the same total. An ignored Range restarts the partial; a
mismatched range, a 416 or a changed validator discards it. Dropped connections
retry up to four times with 2, 4 and 8 second waits; missing resources,
oversize or invalid files, permission errors and disk exhaustion do not. The
same 20 GiB bound, 512 MiB free-space reserve, 30-second idle timeout and
30-minute job budget apply. Terminal and first-run setup use the same downloader
without the job budget.

One transfer runs per models directory, whoever starts it: built-in jobs, custom
URL downloads, uploads, gateway-path imports, `pnpm run setup` and the desktop
first run share a lock file with an owner token and PID. A lock is reclaimed
only when its owner process is confirmed gone; an unreadable one reads as busy.
Sharing a models directory between hosts is not supported.

The latest job per file is journalled in `.downloads/jobs.json`. After a restart
a job that was running reads **Interrupted** and waits for an explicit Retry,
which continues from the retained partial when the server allows it; nothing
resumes on its own. Cancel removes that job's partial. A crash between
publication and the receipt is reconciled at the next boot by hashing the file
against the recorded candidate. An unreadable journal disables downloads and
deletes nothing.

Files installed before receipts existed are kept. A regular file with a GGUF
header and at least 90% of its catalogue size reads **On disk · built-in**, not
as a verified download; that threshold vouches only for legacy presence, never
for a new transfer. A file at the final name that fails the check reads **Model
file requires repair**, blocks its Download, and makes the resolver throw rather
than fall through to another source. There is no overwrite or repair action:
move the file out of the models directory and download it again.

## Applying a change while requests are running

Each role has a fair read/write coordinator. A decision holds its analysis lease
across all rule prompts, windows and nested generations. A waiting change stops
new decisions from entering, lets existing decisions finish, and then unloads
the old role. Existing compiler calls likewise finish on the connection they
started with. Compiler routing resolves the saved connection anew for the next
call without disposing the local guard adapter.

A local candidate test frees the idle previous weights before loading the
candidate, so an import does not require memory for two large judges. Testing
does not change the saved selection. Activation loads the selected local model
before succeeding; a failed load restores the previous settings. Subsequent
requests can reload those previous weights. A timed-out SDK load that finishes
late is unloaded as well. Remote compiler activation repeats its connection
test before replacing the previous connection. Model failures continue through
the existing fail-closed guard paths.

## HTTP contract

All routes are under `/api/settings/models`:

| Method and suffix | Request / response |
| --- | --- |
| `GET /` | `{models, selections, overrides, inForce, importAvailable, maxUploadBytes, builtins, transfer}` |
| `POST /` | Endpoint `{kind:"endpoint",name,baseUrl,model,apiKey?}` or loopback file `{kind:"local",name,path,roles,format}`; returns the public entry |
| `PUT /:id` | Endpoint fields, or local `{name,roles,format}`; active entries cannot be edited |
| `DELETE /:id` | Deletes an inactive entry and its managed file, if local |
| `POST /:id/test` | `{role:"compiler"\|"adjudicator"}`; `{ok,ms,error?}` |
| `POST /:id/activate` | Same role body; `{ok,...catalogueState}` |
| `POST /upload` | `application/octet-stream`; query fields `name`, `filename`, comma-separated `roles`, `format`; returns the public entry |
| `POST /download` | `{name,url,roles,format,filename?}`; HTTP 202 with a download job |
| `POST /builtins/:id/download` | Empty JSON body. 202 `{job,reused}`; 200 `{alreadyInstalled,builtin}`; 404 `unknown_builtin`; 409 `transfer_busy` (with `active`), `existing_file_invalid` or `model_management_unavailable`; 400 `invalid_download_request` for any body field |
| `GET /downloads` | `{jobs}`: custom `{id,name,state,received,total,modelId,error}` and built-in jobs, which carry `source:"builtin"` |
| `DELETE /downloads/:id` | Custom: cancels, `{ok}`. Built-in: 202 `{job}` in `cancelling`, idempotent; 409 `transfer_finished` once publication has begun or the job has ended |

`builtins` lists each Library file as `{id,name,filename,roles,adjudicatorChoice,
format,approxBytes,onDisk,verifiedDownload,downloadBlockedReason,bytes,
activeRoles,selectedRoles,latestJobId}`. `activeRoles` comes from the weights
actually loaded: a compiler running through a CLI or an endpoint is not active
on the bundled file, and a file that matches the saved default but never loaded
is selected, not active. `transfer` is `{available,reason,maxConcurrent:1,
active}`; `available` says the gateway supports the operation, not that the disk
is writable or the internet reachable, and a busy lease is reported through
`active` rather than by turning it off.

A built-in job is `{id,source:"builtin",builtinId,name,state,received,total,
attempt,maxAttempts:4,modelId:null,error,errorCode,canCancel,canRetry,startedAt,
updatedAt}` with `state` one of `connecting`, `downloading`, `retrying`,
`verifying`, `cancelling`, `complete`, `failed`, `cancelled` or `interrupted`.
`received` includes a resumed prefix and `total` is the whole file. Retry is the
same POST and returns a new job id; the list keeps the latest attempt per file.
Jobs never contain filesystem paths, source or redirect addresses.

`testedRoles` and `activeRoles` are arrays of role names. `selections` maps each
role to a catalogue UUID or null for a built-in/legacy setting. `overrides` maps
each role to a boolean. Error responses contain a human-readable `error` and
never echo upstream HTTP response bodies. Endpoint tests also suppress raw JSON
parser diagnostics and redact the configured credential.

Existing `/api/settings/compiler` and `/api/settings/adjudicator` routes remain
available. They report `modelId`, `configuredModel`, and `inForce`. Saving a
compiler endpoint through the legacy route tests it before applying it; the
legacy local or installed-CLI options remain available. Built-in analysis choices
already on disk are checked before activation. The console sends
`requireInstalled: true`, and the route then answers 409 without saving anything
when the weights are absent (`not_installed`) or when the gateway is mock, runs
the experimental llamacpp adapter or has an environment override for the role
(`use_unavailable`). Without that field the legacy behaviour remains for older
clients and the desktop first run: choosing an absent built-in saves a pending
choice, and the currently loaded judge keeps serving until the desktop
downloader finishes and restarts. An explicitly saved built-in choice, including
`default`, resolves to its file in the models directory ahead of a path recorded
in `warden.local.json`; an installation that never saved a choice keeps the
setup path. Its identity, declared prompt
format and active-entry protection remain attached to the loaded weights even
when the desired selection changes. `configuredModel` names the pending choice;
`inForce` names the model still answering.

## Verification

`pnpm run test:model-management` exercises real Express authorization and a real
local HTTP provider, replacing only the expensive QVAC file loader. It covers
compiler hot switching after router initialization; preservation of the local
guard boundary; no-auth loopback endpoints; active-entry editing/deletion;
credential echo suppression; streaming uploads from a remote authenticated
administrator; explicit formats; invalid inputs; activation rollback; nested
decision leases; transfer limits; private-address rejection; cancellation; and
corrupt-file preservation. For built-in downloads it covers non-administrator
refusal of start, list and cancel; unknown ids and rejected body fields;
coalesced double starts; busy responses to a second built-in, a custom URL and
an upload; cancellation and its cleanup; completion with unchanged settings
bytes and no runtime calls; and installed-only Use.

`pnpm exec tsx scripts/test-builtin-downloads.ts` covers the downloader and job
service against temporary directories and an injected transport, with no network:
private publication, every unsafe continuation, retry bounds and abortable
waits, the publication race, crash reconciliation, lock ownership including a
reused PID, interrupted journals, legacy files and resolver precedence. The
address policy is tested separately from simulated network failures, and no
production flag admits HTTP or private sources.

The optional real-runtime check is:

```sh
pnpm exec tsx scripts/smoke-model-management.ts /absolute/path/to/a/general-purpose.gguf
```

It imports and tests both roles in a temporary installation, activates them,
verifies the loaded identity and explicit format, and performs an actual
structured compiler completion. It also changes the desired analyzer to an
unavailable built-in, verifies that the loaded custom model keeps its dialect
and deletion protection, and completes another actual analyzer call. It cleans
up its copied weights and settings.
On 2026-09-08 it passed with `Qwen3-0.6B-Q4_0.gguf` on this machine: compiler
import/test/activation 17,207 ms and analysis test/activation 1,641 ms. This is
runtime compatibility evidence, not a guard-accuracy measurement.
