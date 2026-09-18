# Security

Warden is a policy gate for AI assistants. Its whole purpose is to be the thing
an employee cannot route around, so a weakness here is not a bug beside the
product — it is the product failing.

This document says what Warden defends against, what it does not, and how to
report something.

## Reporting a vulnerability

Open a [security advisory](https://github.com/Wardenlabs/warden/security/advisories/new)
on the repository, or email the maintainer listed in `package.json`. Please do
not open a public issue for something exploitable.

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
configuration this repo can produce. Rule *compilation* is the one thing that
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

Prompt text does exist in one other place, deliberately and with a limit. The
console has to be able to show an administrator what was actually blocked, so
`src/audit/prompts.ts` keeps the **masked** text — secrets already removed —
for **seven days by default**, in `data/prompts.jsonl`, mode `0600` and
gitignored. Expiry is enforced on every read and not only by a sweep, so a copy
of that file taken to another machine, or restored from a backup, still cannot
be read past its date. `WARDEN_PROMPT_RETENTION_DAYS=0` disables it entirely
and deletes the file.

What this means for the people being logged is a sentence you can put in
writing: *an administrator can read what you sent for seven days, with secrets
already masked, and after that nobody can — including them.* Lengthening the
window lengthens what an attacker who reaches the gateway walks away with, in
direct proportion.

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

Saved compiler endpoints are compiler-only. Analysis always uses local weights.
Remote compiler endpoints require HTTPS and an API key; direct loopback model
servers may use HTTP without one. Changing a saved endpoint never copies its
credential to a different address automatically. Catalogue responses expose key
presence and a suffix, never a key or test fingerprint. Provider response bodies
and raw JSON parser errors are suppressed during connection tests.

The catalogue and settings are atomically replaced in mode `0600`; endpoint
keys remain plaintext at rest, as with the existing compiler settings. Browser
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

**The hook fails open on timeout.** The `UserPromptSubmit` integrations wait a
bounded time for a decision. If the gateway is unreachable or slow past that
deadline, the prompt goes through unchecked and the employee is told so on
stderr. A cold Codex decision was observed exceeding the 30-second deadline on
2026-08-23. Failing closed would mean a broken gateway stops all work, and that
is a product decision the deployment gets to make, not one this repo makes for
it. `WARDEN_FAIL_CLOSED=1` selects refusal after the hook learns and remembers
that policy; a machine that has never reached the gateway has no remembered
policy. The native client's own deadline remains an independent boundary.

The deadline has two halves and both fail open. Warden's own is 90 seconds.
Claude Code has one of its own for `UserPromptSubmit` hooks, 30 seconds by
default as of September 2026, and a hook it cancels is a prompt that reaches
the model with the hook's output discarded. So the hook entry in
`~/.claude/settings.json` has to carry `"timeout": 120`; `warden-hook --fix`
writes it, and repairs an entry written before it did.

The same file has to carry the gateway address and the API key in its `env`
block. Hooks inherit Claude Code's environment, and a Claude Code opened from
the desktop app or the Dock never sourced a shell profile, so a hook wired
there with the values only in `~/.zshrc` asks `localhost:8080`, finds nothing
and fails open, on a laptop that looks wired. `--fix` writes both values into
`env` from its own environment and the install script hands them to it. That
is the key in a second file, in the same home directory, readable by the same
person; the alternative, measured on 2026-09-06, was a desktop app that
judged nothing.

**Both hook integrations are NOT VERIFIED end to end.** See
[`docs/HOOK-VERIFICATION.md`](docs/HOOK-VERIFICATION.md).

**Local root.** Anyone with a shell on the machine running the gateway can edit
`data/policies.json` and `data/company.json` directly. This is why loopback is
trusted as administrative: refusing it at the HTTP layer would buy nothing. Where
employees can log into the gateway host, set `WARDEN_ADMIN_REQUIRE_KEY=1` so
every administrative call must present an exempt key.

**API keys are stored in plaintext** in the directory file, and appear in the
onboarding script served to the employee they belong to. Read access to that
file is impersonation of every employee in it.

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

## Deployment notes

- `WARDEN_HOST` defaults to `0.0.0.0` so employees can reach the gateway. The
  administrative surface is authenticated, but set `127.0.0.1` if the gateway
  serves only the machine it runs on.
- **A proxied request no longer counts as loopback, and that is now enforced
  rather than configured.** `requireAdmin` grants administration to loopback and
  reads the peer address off the socket precisely so a header cannot forge it.
  A reverse proxy connects from `127.0.0.1`, so *every* request arriving through
  one used to satisfy that check: everyone who could reach the tunnel was an
  administrator, with the directory of plaintext API keys, policy edits and
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
- **The directory file is written 0600.** It holds every employee's API key in
  plaintext and was 0644 until v0.1.23: readable by every account on the
  machine, and by anything that picked up the data folder in a backup, a sync
  client or a container image. The mode change removes readers who never needed
  those keys; it does not make them not plaintext.

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

**What is still missing, on the honest list.** API keys are plaintext in the
directory file. The install route has to hand an employee their key and the
console re-displays it, so anything that stores a hash has to stop the server
being able to re-display one — keys shown once at issue, rotate to replace.
That is the right change and it is a change to how the product delivers
credentials, not a column swap; half a secret store in the meantime would be
worse than an admitted plaintext one.

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

### A gateway can require its hooks to refuse

`WARDEN_FAIL_CLOSED=1` makes an unreachable gateway block rather than let the
prompt through. Stated on `/health` like the deadline, and **remembered by the
hook across runs** in `~/.warden-hook.state.json`, because the outage is when
the policy matters and the outage is when the gateway cannot be asked. Learning
it only from a live response means never knowing it at the one moment it
decides anything — the first version of this shipped with exactly that hole.

A machine that has never reached this gateway has nothing remembered and fails
open, which is the only answer available: this closes the door for a team that
has been running, not for a laptop being set up while the gateway is already
down. The default stays open, and stays the documented trade it always was.
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
