# Security

Warden is a policy gate for AI assistants. It checks requests routed through its configured connections. Host integration
coverage and administrative control of the device determine whether a user
can bypass those connections.

This document says what Warden defends against, what it does not, and how to
report something.

## Reporting a vulnerability

Open a [security advisory](https://github.com/Wardenlabs/warden/security/advisories/new)
using GitHub private vulnerability reporting when enabled. If the private form
is unavailable, ask the maintainer to enable it without posting exploit details.
Do not post credentials or reproducible exploit details in a public issue.

Include what you can reach, from where, and what it gets you. A working request
is worth more than a description. We will acknowledge, and we would rather have
a report that turns out to be a misunderstanding than not have it.

## Threat model

The attacker is an **employee of the company running Warden**, or anyone who can
reach the gateway's port. They are not assumed to be unskilled, and they are
assumed to have read this repository.

What they want is for a prompt the policy forbids to reach a model anyway.

### What Warden defends

**Prompt-level attacks.** Instruction override, authority spoofing, roleplay and
fiction framings, hypothetical framing, obfuscation, homoglyphs and invisible
characters, language switching, injections riding in on an attachment, and
attacks aimed at the guard itself. The corpus in
[`src/redteam/corpus/`](src/redteam/corpus/) is 98 prompts across twelve
classes, and [`REPORT.md`](REPORT.md) is the last recorded run against it.

**Attacks on the evaluator.** The untrusted text is fenced inside a delimiter
carrying a 128-bit nonce chosen after the text is fixed, so a forged fence
cannot be guessed. Forged delimiters, dictated verdict labels and instructions
addressed to the classifier are detected in ordinary code, before any model
runs, and nothing written in a message can argue them down.

**A compromised model.** The verdict lattice is the structural guarantee:
`ALLOW < ESCALATE < BLOCK`, every model pass may only tighten, and one function
containing no inference decides. A model that has been fully talked over still
cannot produce an `ALLOW`, because none is ever asked for.

**Credential leakage into prompts.** Secrets are matched by pattern and entropy
and masked before any model, any upstream provider, or the audit log sees the
text.

**Tampering with the record.** The audit log is append-only JSONL, hash-chained,
with a witness file holding the count so truncation is visible as well as
alteration. `pnpm run verify-audit` walks it.

**Sending prompts to a model you do not run.** Judging is local under every
configuration this repo can produce. Built-in GGUF judges run through QVAC;
optional Kev judges run through an open sidecar that Warden restricts to
`localhost`, `127.0.0.1` or `::1`. The sidecar receives the policy instructions
and nonce-isolated request as separate structured fields. It cannot be pointed
at a remote host. Rule *compilation* is the one thing that
can be moved — to an endpoint you configure (`WARDEN_COMPILER_API`) or to the
`claude`/`codex` CLI already signed in on the machine (`WARDEN_COMPILER_CLI`,
or the provider picker in the console) — because compilation turns a sentence
*you* typed into a draft *you* then ratify, and a model that cannot enact
policy cannot be talked into enacting it. What goes with it: your sentence,
your role names, and your employee roster (`WARDEN_COMPILER_REDACT_NAMES=1`
reduces the roster to tokens). What never does: employee prompts, audit
entries or the active policy as employee evaluation input. Employee API keys
are not compiler content; an endpoint's own provider key authenticates that
connection. Compiler wrappers gate on the `compiler` role and repeat the check
inside the call.

**Keeping a transcript of your team.** The audit log holds `sha256(prompt)` and
never the prompt: `recordDecision` strips the text before writing, so the
governance record cannot become the thing it is meant to make accountable.

Masked prompt history is separate from the audit chain. The console can show
an administrator the retained text for seven days by default. The store uses
`data/prompts.jsonl`, mode `0600`, and filters expired entries on application
reads. A cleanup sweep removes expired records from the active file.

These controls do not encrypt or erase independent copies. Someone with direct
access to an old file, backup or filesystem snapshot may still read its contents.
Backup retention and access controls must match the deployment's policy.
`WARDEN_PROMPT_RETENTION_DAYS=0` disables the active store and attempts to remove
its file; it cannot delete backups, snapshots or recoverable disk blocks.
Credential masking is detection-based and may miss an unfamiliar secret format.

**Reaching the administrative surface.** Policy writes, key issuance, the
onboarding script and the audit record require an administrator: a request from
the machine the gateway runs on, or an API key belonging to a role the ratified
policy exempts. See [`src/server/admin-auth.ts`](src/server/admin-auth.ts).

### Documents and the inspection boundary

Public attachment APIs accept canonical base64 bytes and sanitized display
names, never a gateway path, remote URL or stored file ID. The proxy normalizes
all supported text/file parts before evaluation and reconstructs allowed
forwarding from the exact inspected documents, matched by ordered SHA-256.
Unknown content parts, mismatched results and incomplete extraction are refused;
original file bytes are not forwarded. Extracted text and filenames are masked
before upstream forwarding. See [document screening](docs/DOCUMENTS.md).

Files are treated as untrusted parser input. Limits bound original bytes, page
and image counts, decoded pixels, ZIP expansion, XML structure, extracted text,
concurrent reader processes and elapsed time. The reader runs in a separate
process with a 512 MiB JavaScript heap ceiling and is killed on timeout or client
cancellation. That process is fault isolation, **not an OS security sandbox**:
native PDF/image/OCR dependencies remain in the trusted computing base. A
malformed native-parser exploit is not prevented merely by spawning a child.

A document check evaluates every applicable input rule over overlapping text
windows. An unreadable source image, missing page, failed rule/window or expired
deadline cannot turn into ALLOW. OCR uses bundled English/Spanish language data
and local PDF assets; there is no remote-OCR or document-URL download fallback.
Empty or low-confidence OCR, active/embedded document content and unsupported
structures are held rather than silently discarded. This conservative behavior
can hold a legitimate document containing an unreadable logo or image.

The audit chain retains each original file's digest, sanitized name, byte size,
reading status and extraction metadata. It does not retain original bytes or
extracted document text. Existing retention of the separately supplied prompt is
unchanged. An administrator can still learn a document's sanitized filename and
whether it matched a policy from the audit record; this is metadata, not an
absence of information.

Hooks run on the employee's computer and can read only attachments explicitly
exposed by the host event as bytes or paths. They do not infer file permissions
from prose. A hook cannot replace its host's original file with sanitized text:
if the returned metadata reports masked credentials, it asks for a cleaned
original and refuses. A claimed ALLOW without complete matching inspection
metadata is refused as well. Gateway-outage behavior still follows the hook's
configured fail-open/fail-closed policy, and a client-side hook deadline can
still discard its result. Synthetic hook tests do not prove that a native client
provides all attachments to that hook.

### Administrator-owned models

Compiler and analyzer templates are also administrative configuration. The
`/api/prompts` read, save and restore routes use the same authorization gate as
model settings. Template edits can weaken model observations; structural
validation is not a guarantee of policy accuracy. Required dynamic context,
response schemas, isolation, ratification and verdict aggregation remain in
code. Rewrite customizations do not remove the original-block binding, one-shot
limit or mandatory re-check.

Templates are plaintext in `data/prompts.json` (or
`WARDEN_PROMPT_TEMPLATES_PATH`), atomically written `0600` and gitignored. They
are not the retained employee request store. Do not put credentials in template
text: authorized administrators can read it, and compiler instructions travel
to the configured compiler service when compilation is offloaded. Each operation
keeps an immutable snapshot; revision checks prevent accidental concurrent
overwrites. The audit records revision and content hashes without copying
template text. See [prompt management](docs/PROMPT-MANAGEMENT.md).

`/api/settings/models` and its import, test, activation and deletion routes use
the existing administrative gate. Models belong to one gateway installation;
they are not isolated per administrator. A direct loopback request may import a
file already on the gateway. A remote administrator must upload bytes instead
of gaining a path-based read capability on another machine.

Saved compiler endpoints are compiler-only. Analysis always uses a local QVAC
model or the selected loopback-only Kev sidecar. Remote compiler endpoints
require HTTPS and an API key; direct loopback model servers may use HTTP without
one. Changing a saved endpoint never copies its
credential to a different address automatically. Catalogue responses expose key
presence and a suffix, never a key or test fingerprint. Provider response bodies
and raw JSON parser errors are suppressed during connection tests.

The catalogue and settings are atomically replaced in mode `0600`; endpoint
keys are encrypted at rest, as with the compiler settings and employee directory. Browser
form snapshots exclude password and file controls. An employee credential in a
Simulator request takes precedence over a saved administrator credential, so
its policy exemption cannot silently change the test identity.

Custom downloads accept public HTTPS sources only, validate and pin DNS results
on each redirect, reject local/private addresses and URL credentials, and enforce
size, disk-space and time bounds. Transfers use private partial files and clean
up on cancellation or failure. Filenames never choose a destination path.
Imported GGUF headers and complete-byte digests are checked, but the real native
model loader remains part of the trusted computing base. Import weights from
sources you trust; a successful compatibility test is not a provenance audit or
a policy-accuracy result.

A model must pass the test for its intended role before activation. Editing
invalidates prior tests, active selections cannot be edited or removed, and a
failed activation restores prior settings. Role leases let existing evaluations
finish before a model is changed and prevent one decision from mixing weights.
Environment overrides remain authoritative. Full storage, transfer and API
contracts are in [model management](docs/MODEL-MANAGEMENT.md).

### What Warden does not defend

These are real and stated on purpose. A security document that lists only
strengths is marketing.

**Hooks block on gateway failure by default.** Missing or corrupt cached state,
first contact, timeouts and invalid responses all result in refusal. An
administrator can set `WARDEN_FAIL_CLOSED=0` on the gateway to allow unchecked
requests during an outage. Updated hooks accept that opt-out only from a
versioned `/health` response and remember it per gateway URL. Old unversioned
fail-open cache entries are ignored. Distribute updated hooks to existing clients.

A host application can still discard a hook's refusal or kill it before it
answers. Warden's text deadline defaults to 90 seconds; document checks allow
240 seconds. `warden-hook --fix` sets Claude Code's hook timeout to 300 seconds.
That does not prove the host honors the result; see the verification record below.
The OpenCode plugin also refuses if its hook crashes, is absent or times out.

Hooks read their encrypted credential file directly, including when launched
from the Dock. `--fix` removes the plaintext key from Claude Code's active
settings. New installer scripts no longer put keys in shell profiles. Old shell
exports and configuration backups are not erased automatically: remove those
copies and rotate their keys when migrating an existing deployment.

**Both hook integrations are NOT VERIFIED end to end.** See
[`docs/HOOK-VERIFICATION.md`](docs/HOOK-VERIFICATION.md).

**Local root.** Anyone with a shell on the machine running the gateway can edit
`data/policies.json` and `data/company.json` directly. This is why loopback is
trusted as administrative: refusing it at the HTTP layer would buy nothing. Where
employees can log into the gateway host, set `WARDEN_ADMIN_REQUIRE_KEY=1` so
every administrative call must present an exempt key.

**Onboarding scripts and links carry credentials.** The directory stores
encrypted keys, but the authorized install response contains the employee key.
Treat saved scripts, browser downloads and copied onboarding commands as secrets.

The onboarding link is therefore a credential, and is addressed by an install
token rather than by employee id — 128 bits derived from the key it delivers,
so it cannot be guessed, survives a restart, and is invalidated by rotating the
key. Treat the link the way you would treat the key: it is the key.

**Quota counters live in memory** and reset when the process restarts. A gateway
restarted often does not enforce a daily ceiling.

**The guard is a model, and models are wrong.** The last recorded run stopped
85% of attacks. The other 15% went through. Warden raises the cost of an attack
and produces a record of it; it is not a proof.

**A `warn` rule does not enforce anything.** It is the admin choosing to be told
rather than protected, for a rule where refusing costs more than it saves.
Warnings never tighten a verdict, so they cannot be a bypass — but a rule moved
from `block` to `warn` is a rule that has stopped stopping anything, and the
change is visible in the policy hash precisely so that it is reviewable.

**False positives are the live problem.** That same run refused 58% of
legitimate traffic. A guard people cannot work with gets switched off, and a
guard that is switched off protects nothing — so this is a security property,
not a usability one.

## The one thing that may run off-machine, and what it is not

Policy analysis and document extraction are local. **Rule compilation** may use
an explicitly configured endpoint or installed CLI, enforced by role rather than
by convention. Allowed, sanitized requests may also be sent to the administrator's
configured upstream assistant; that forwarding is separate from analysis.

New installations offer Claude Code as the initial compiler and require the
administrator to complete configuration before using it. The setup check sends
only a fixed, synthetic compatibility question. Normal compilation uses the
CLI's configured account and provider; running the CLI locally does not make
the provider's inference local. Warden does not collect the CLI's login tokens
or expose its account identity in the console. Existing saved selections and
explicit environment overrides are preserved.

Compilation turns one sentence an administrator typed into a draft rule that
the same administrator then reads and ratifies. It never sees an employee
prompt and it cannot enact policy — `src/policy/compile.ts` states that split in
its first paragraph and `ratifyRule` is the only path that changes what anyone
is judged against. **Judging stays local under every configuration.** There is
no environment variable, flag, or fallback that sends a prompt under judgement
anywhere, and `pnpm run test:remote` asserts it: every guard role delegates to
the local adapter and performs zero network calls, with `fetch` replaced by a
recorder.

Enable it with `WARDEN_COMPILER_API` (an OpenAI-shaped `/chat/completions` base
URL) and `WARDEN_COMPILER_API_KEY`, or use Models in the console. A remote
endpoint requires a key and HTTPS. An endpoint on `localhost`, `127.0.0.1` or
`[::1]` may use HTTP without a key for a model served on the gateway itself.

**What leaves the machine when it is on**, stated without qualification:

1. The administrator's sentence.
2. The role names.
3. **The employee roster** — id and display name for everyone in the directory
   — because the compiler injects it so that "Ana cannot ask for payroll"
   compiles into a rule about Ana rather than about the whole company.

Point 3 is the reason this is a security note and not a feature note. Set
`WARDEN_COMPILER_REDACT_NAMES=1` and the provider sees `@e-01` and never the
person; that costs accuracy exactly where the roster was earning it, so it is a
choice rather than a default. Employee prompts, documents, audit entries and
employee keys are not sent to the compiler. The configured provider key is used
only to authenticate that provider's connection.

The console reports which model drafted a rule, and whether it was remote, on
every draft it returns. An administrator ratifying a rule should not have to
guess whether it came off their own machine.

### Desktop update checks

The desktop app on macOS makes three outbound requests that nothing else in
Warden makes, none of them carrying policy, prompts, people or audit:

1. `github.com/Wardenlabs/warden/releases/latest/download/warden-release.json`,
   the release manifest, at launch and every six hours.
2. `update.electronjs.org`, which learns this machine's IP, architecture and
   Warden version, when the manifest names a newer release.
3. The release zip from GitHub and, only if the next version needs model files
   that are not on disk and the administrator chooses to download them, those
   files from their revision-pinned Hugging Face URLs.

Squirrel.Mac installs only an update signed by the same Developer ID as the
running app. A prefetched model file is kept only if the new, signed
version's own catalogue names that file at the same URL. Nothing is installed
until an administrator restarts or quits the app. Turn all of it off with
`WARDEN_AUTO_UPDATE=0`, the menu, or the managed preference `AutoUpdate`
in `com.warden.gateway`, which wins over both. See
`docs/specs/desktop-auto-update.md`.

## Deployment notes

- `WARDEN_HOST` defaults to `0.0.0.0` so employees can reach the gateway. The
  administrative surface is authenticated, but set `127.0.0.1` if the gateway
  serves only the machine it runs on.
- **A proxied request no longer counts as loopback, and that is now enforced
  rather than configured.** `requireAdmin` grants administration to loopback and
  reads the peer address off the socket precisely so a header cannot forge it.
  A reverse proxy connects from `127.0.0.1`, so *every* request arriving through
  one used to satisfy that check: everyone who could reach the tunnel was an
  administrator, with access to employee keys, policy edits and
  deleting people behind it. Confirmed against a running gateway while preparing
  a tunnel — the admin API answered unauthenticated.

  The guard against it was `WARDEN_ADMIN_REQUIRE_KEY=1`, which worked and which
  somebody had to remember. `isLoopback` now returns false whenever a request
  carries any header a proxy adds (`x-forwarded-for`, `forwarded`,
  `cf-connecting-ip`, and the rest of the list in `admin-auth.ts`). A forged
  header can only *withdraw* trust, never grant it, so the check is safe to make
  from data the caller controls. Setting the flag as well costs nothing and is
  still worth doing on a shared host.
- **Both expensive paths are rate limited**, per API key where there is one and
  per address where there is not: 60 decisions a minute
  (`WARDEN_RATE_DECISIONS`) and 600 requests a minute on `/api/`
  (`WARDEN_RATE_REQUESTS`). Each decision costs a model call, so before this one
  loop from one caller pinned the CPU every real decision was queued behind —
  a denial of service against the guard itself, in one line. Failed
  administrative authentication is capped separately at 10 attempts per address
  per 15 minutes, because the administrative surface is guarded by a string and
  unlimited guesses against a string is not a lock. Counters live in memory and
  reset with the process, like the quotas.
- **Plain HTTP through a proxy is refused.** Every employee request carries an
  API key in a header and every install link carries one in its path, so a
  gateway reachable over http through a tunnel is handing credentials to every
  hop. A request whose proxy says `x-forwarded-proto: http` gets 403. An absent
  header is not a claim and is allowed, because refusing on a guess breaks
  working deployments; `WARDEN_REQUIRE_HTTPS=1` takes the stricter reading for
  an administrator who knows their proxy sets it. A direct request on a LAN
  carries no forwarded headers and is untouched.
- **Set `WARDEN_TRUSTED_PROXY=1` behind a tunnel, and only there.** Without it
  every proxied request reports the proxy's own loopback address, so the whole
  internet shares one rate-limit bucket and the first flood locks out every
  other caller — a denial of service performed by the rate limiter. With it,
  callers are counted by the address the proxy reports. It is off by default
  and deliberately not inferred: with nothing in front, that header is written
  by the caller, and believing it would let anyone evade the limit by rotating
  a string. It never affects authorisation — `isLoopback` refuses a proxied
  request either way.
- **Credential files are encrypted and written atomically with mode 0600.**
  Encryption does not protect against a compromised gateway process or an OS
  account that can unlock the credential key. See the storage details below.

### Running one in production

The desktop app does steps 1 to 4 from its own menu — **Put Warden on the
internet…** starts a Cloudflare quick tunnel, hands the gateway the public URL
so the onboarding pack gives employees an address that works, and sets
`WARDEN_TRUSTED_PROXY` and `WARDEN_REQUIRE_HTTPS` itself. `cloudflared` is not
bundled: it is tens of megabytes of somebody else's binary inside a security
product, so a missing one is a message saying how to install it rather than a
download. A quick tunnel's address is public to anyone holding it and changes
on every restart, which the app says on the way in rather than leaving to be
discovered. For anything long-lived, use a named tunnel with Cloudflare Access
in front of it.

Doing it by hand, or running the gateway some other way:

1. Put a tunnel or reverse proxy in front that terminates TLS. Nothing here
   handles certificates.
2. `WARDEN_TRUSTED_PROXY=1`, so rate limits count real callers.
3. `WARDEN_ADMIN_REQUIRE_KEY=1`. Proxied requests already lose loopback trust
   without it; this closes the case where something reaches the port directly.
4. `WARDEN_HOST=127.0.0.1`, so the only way in is through the proxy.
5. Decide `WARDEN_PROMPT_RETENTION_DAYS`. The default keeps masked prompt text
   for seven days, and an exposed gateway is a larger blast radius than a
   laptop.

### Credential storage and migration

Gateway employee keys, compiler keys and model endpoint keys use AES-256-GCM
with fresh nonces and authenticated field locations. Valid legacy files are
migrated on read. Decryption failures do not replace saved credentials. Old
published sample keys are rotated on load, even if their employee was renamed.
Those clients need to reconnect with a newly issued onboarding link.

On desktop, Electron `safeStorage` wraps the encryption key using the OS store
when available. Its `basic_text` Linux fallback is not treated as secure storage.
If an existing OS-protected key cannot be unlocked, startup stops. A new
installation without an available OS store uses a mode-0600 key file under
`~/.warden/keys/`, outside the gateway data directory, and logs that limitation.
That installation stays file-backed if a keyring is subsequently enabled.

Headless gateways use `~/.warden/keys/gateway.key`. Set
`WARDEN_CREDENTIAL_KEY_PATH` to a separately managed 32-byte binary key file,
or supply `WARDEN_CREDENTIAL_KEY` as 64 hexadecimal characters via a secret
manager. The gateway consumes the environment value before spawning workers.
The hook has its own file-backed key at `~/.warden/keys/hook.key` and encrypted
credentials at `~/.warden/credentials.json`. These files use private POSIX
permissions; on Windows, restrict their ACLs to the owning account.

Back up the encryption key separately and protect it as a credential. Copying
both the key and data defeats the protection; losing the key prevents recovery.
An OS-wrapped key may be tied to its machine/account. Migrate through the running
installation or reissue credentials on a new machine. Encryption of active files
does not remove plaintext from old backups, snapshots, scripts or shell history.

The failed-administrative-attempt counter is persisted (`data/admin-attempts.json`,
0600, gitignored), because a restart there handed a guesser ten fresh attempts
and a gateway restarts every time the desktop app is reopened. The request
counters are still in memory: losing one costs a caller a minute of allowance.
Neither coordinates across instances. There is no account lockout beyond the
per-address throttle.

### Administrative actions are in the chain

Every mutating request to an administrative route is appended to the same
hash-chained log as the decisions, and `verifyChain()` covers both. The chain
held every decision and none of the edits that produced them, so somebody could
rewrite the policy, issue themselves a key or delete a person and leave nothing
behind but the effect.

Recorded on the way out and keyed to the status, from **before** the
authorisation check — a stranger turned away from the administrative API is the
entry an incident looks for, and `requireAdmin` ends the response itself, so
nothing mounted after it ever sees a refusal. Three kinds of actor are kept
apart deliberately: a named key, `local`/`administrator` for the machine
itself, and `unknown`/`unauthenticated` for everyone else — the first version
of this labelled a refused stranger as the local administrator, which is a log
that lies. The method and the path, never the body: `/api/people/:id/key`
carries a credential and `/api/policy/ratify` carries rule text, and this log's
promise is that it holds neither. 429s are skipped so a flood cannot write the
log. Read it at `GET /api/audit/admin`.

### Failure policy

Updated hooks refuse an unreachable gateway by default. Only the explicit
`WARDEN_FAIL_CLOSED=0` opt-out, advertised with `failurePolicyVersion: 1`, enables
unchecked requests. Hook caches remember that opt-out across runs. Changing the
gateway back to closed requires clients to contact it again; an offline client
cannot learn a policy change. Host deadlines remain an independent boundary.

- `WARDEN_CORS_ORIGIN` is unset by default and should stay that way. The console
  is served by the same process and needs no cross-origin access.
- Keep `data/` off shared storage. It holds the directory, the policy and the
  audit chain.

## Scope

In scope: the guard pipeline, document validation/extraction adapters, model
catalogue and transfers, the policy store, server authentication and routes,
audit chain, hook integrations, console identity boundaries and desktop packaging.

Out of scope: vulnerabilities in `@qvac/sdk` or in the models themselves (report
those upstream), and social engineering of an administrator.

### Browser access to local administration

Local administration also validates the HTTP Host and browser Origin. A web
page on another origin cannot borrow loopback trust with a simple POST, and an
attacker-controlled DNS name cannot gain it by resolving to a local address.
`WARDEN_CORS_ORIGIN` may name one explicit development origin; `*` and `null`
do not grant local trust. Custom hostnames need an administrative key.

The [2026-09-17 review](docs/SECURITY-REVIEW-2026-09-17.md) records the tests,
dependency updates and local extract-zip patch, including the advisories that
remain visible in the dependency scanner.
