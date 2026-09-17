# Working on Warden

Warden is a local AI gateway. An administrator writes policy in plain language;
employee requests and supplied documents are checked before they reach their
assistant. Policy analysis uses local QVAC weights; document extraction uses
local parsers and offline OCR. Administrators can explicitly move compilation
or the allowed upstream assistant to another service, but not analysis.

This file is for whoever works on it next. It is about how the codebase thinks,
what has already been measured, and which mistakes are cheap to repeat.

## The invariant everything rests on

> Verdicts are ordered `ALLOW < ESCALATE < BLOCK`. Every model pass can only
> push a decision **toward stricter**, never toward looser. A pass that errors,
> times out, or returns unparseable output resolves to `ESCALATE`.

Models supply observations. One function — [`aggregate`](src/guard/aggregate.ts),
which contains no inference — turns observations into a verdict. An attacker who
fully compromises every model in the pipeline still cannot manufacture an
`ALLOW`, because no model is ever asked for one.

**Do not add a code path where a model's answer clears a request.** If you find
yourself writing one, the design has been misunderstood somewhere upstream.

`warn` severity is the one thing that looks like an exception and is not. A rule
the admin set to `warn` fires, attaches its explanation, and tightens nothing —
so it never reaches `tighten`, never lands in `firedRules`, and the request is
allowed exactly as it would have been if the rule did not exist. It adds
information to a verdict; it cannot subtract from one. Keep it that way: the
moment a warning can lower something, it has become a model clearing a request.

## Layout

```
src/guard/       the pipeline: one prompt in, one decision out
  isolate.ts       pass 0 — normalise, fence in a nonce envelope, flag tampering
  passes/          pass 1 injection (off), pass 3 adjudicate — the model calls
    adjudicate.ts    what happens around one call: windows, votes, deadline, fail-closed
    forms.ts         the words each prompt form uses, and how the answer reads back
    shots.ts         which of a rule's examples go into the prompt
  aggregate.ts     pass 4 — the only place a verdict is decided. No inference
  sanitize.ts      pass -1 — mask secrets before anything else sees the text
  quota.ts         pass -2 — per-role daily counters
src/documents/   inline-byte validation, bounded local parsing/OCR, extraction reports
  runner.ts        cancellable reader process; never an OS security sandbox
  extract.ts       PDF/DOCX/text/image completeness and resource limits
src/proxy/       content normalization and forwarding from inspected, masked results
src/models/      per-installation model catalogue, transfers, tests and activation
  store.ts         private atomic state, fingerprints and redacted public entries
  manager.ts       role compatibility, active-entry restrictions and rollback
  transfers.ts     bounded uploads/path imports/public HTTPS downloads
src/prompts/     administrator-owned prompt catalogue and immutable request snapshots
  catalog.ts       full role/stage templates from the original default builders
  store.ts         private atomic overrides, required variables and revision conflicts
src/policy/      rules, roles, people, retrieval, the compiler
  compile.ts       the compiler's logic; prompts.ts is what it says to the model
  preview.ts       a draft judged by the real adjudicator before anyone activates it
  ratify.ts        the only paths that put a rule in force or take one out
src/qvac/        the only boundary to @qvac/sdk. Everything else uses an adapter
  offload.ts       the one gate a compiler that leaves the local weights goes through
  json.ts          the one parser every adapter reads a model's JSON with
  coordination.ts  role leases: a decision finishes before its weights change
src/server/      HTTP. index.ts only boots; app.ts fixes the middleware order
  routes/          one router per surface: policy, people, guard, solo, system…
  middleware.ts    CORS, headers, rate limit, admin audit, admin gate
  identity.ts      API key -> actor, and running the guard for a request
web/             the console: index.html is the shell, style.css the styles,
                 app.js the entry, web/js/ one module per screen over
                 core/format/router/data/render. No build step. draft.js is the
                 rule conversation, draft-set.js the list a broad instruction
                 becomes, answers.js what the compiler says when it is not a rule
                 models.js/model-library.js manage the two roles and custom models;
                 documents.js prepares files; form-state.js excludes secrets/files
src/redteam/     the corpus and the runner that writes REPORT.md
scripts/         setup, benchmarks, and the adjudicator bench
integrations/    the UserPromptSubmit hooks for Claude Code, Codex, opencode
```

Four of the six guard passes are ordinary code, on purpose. Cheap and certain
first, expensive and probabilistic last.

## Before you change how the guard decides

**Read [`docs/MEASUREMENTS.md`](docs/MEASUREMENTS.md) first.** It is the log of
every corpus run a decision was taken from, including the ideas that failed. It
will save you from re-running experiments that are already settled:

- Asking the adjudicator for a confidence score, a free-text reason, or a quoted
  span. All three made it worse; the reason field measured **16/16 false
  positives**. Every field you ask a small model to fill is a chance for it to
  answer without deciding.
- Majority-of-3 self-consistency voting. 50 extra model calls, no improvement.
  The errors are a lean, not noise, and averaging a lean returns the lean.
- Rewording the pinned rule, rewriting its examples, unpinning it, and putting a
  relevance floor on retrieval. All inside the noise band.

The two things that ever worked asked the model for **less**, not better.

### The measurement rule

A single corpus run is not a result. n is 16-18 on the false-positive side, and
two identical runs at temperature 0 have given 44% and 31% — `parallel: 4`
batches adjudications and the batch composition moves the numerics.

For anything about how a rule is judged, use the bench instead:

```bash
pnpm run bench -- --a base --b <variant>      # paired, with a McNemar p-value
```

It measures one message against one rule, runs both variants over the identical
cells, and reports the disagreements. `pnpm run redteam` measures the product;
the bench measures the change.

**Security-relevant defaults do not move on an argument, however good.** Every
unmeasured lever in this repo ships off with a note saying why — `CONFIRM_VOTES`,
`MIN_RELEVANCE`, `WINDOW_CHARS`, `INJECTION_PASS`. Follow that.

## Conventions

**Comments carry the reasoning, not the mechanics.** The house style explains why
a thing is the way it is, and especially what was tried before and what it
measured. A comment that restates the line below it is noise; a comment
recording that a KV cache key once caused a 100% false-positive rate is what
stops someone re-adding it. Write them in English, in prose, above the thing
they explain.

**Everything is in English** — code, comments, docs, commit messages. Rule text
and corpus prompts are mixed Spanish/English because that is what the traffic
looks like.

**Commit messages are prose.** Say what changed and why, what you measured, and
what you could not measure. No bullet lists of files.

**No new dependencies without a reason that survives being written down.** The
HTTP/guard core uses Express, Zod and QVAC. Document reading adds pinned local
PDF, XML, ZIP, image and OCR libraries; their purposes and licenses are recorded
in `THIRD_PARTY_NOTICES.md`. Preserve upstream notices and the lockfile. PDF.js
upgrades must rerun the partial-operator-stream regression in
`docs/DOCUMENTS.md`: a resolved rendering promise alone is not proof that every
source image was inspected.

## Running it

```bash
pnpm install
pnpm run setup                    # downloads the selected local models (~4.3 GB for initial Claude setup)
pnpm run dev                      # gateway + console on :8080
WARDEN_ADAPTER=mock pnpm run dev  # no models, no GPU — the mock stands in
pnpm run typecheck
pnpm test                        # isolated regression suites; real parser/OCR fixtures
pnpm run build                   # server and desktop assets
pnpm run redteam                  # the corpus. Writes REPORT.md
pnpm run bench                    # the adjudicator bench
pnpm run verify-audit             # walk the audit chain
```

Use Node 22.17+ for the runtime requirement. CI uses Node 22; Node 24 is the
verified local desktop-packaging choice. A 2026-09-08 local Forge run under
Node 26 exited successfully during Electron ZIP extraction without producing
an application, while the same packaging path under Node 24 completed. That is
an observed toolchain compatibility issue, not a claim that Warden's server
cannot run under Node 26. Verify the actual packaged artifact, not just the
packaging command's exit code. The packaged macOS arm64 app has been booted and
its PDF and offline-OCR readers checked; other target platforms still need their
own artifact verification.

The mock adapter is a test double, never a fallback. If the real adapter fails,
Warden escalates — it does not downgrade to keyword matching and keep answering.

**Compilation may leave the machine; judging may not.** Two adapters wrap the
local one and both are gated on the `compiler` role and nothing else:
[`qvac/remote.ts`](src/qvac/remote.ts) for an OpenAI-shaped endpoint, and
[`qvac/cli-compiler.ts`](src/qvac/cli-compiler.ts) for the `claude` or `codex`
CLI already signed in on the machine — no API key, no endpoint, and a model
that makes rules the 1.7B cannot. What goes to either is the administrator's
own sentence, the role names and the employee roster, and nothing else; there
is no flag anywhere that routes a prompt under judgement off-machine, and the
role check is repeated inside the call as the line that would have to be wrong
for that to happen. Both are subclasses of [`qvac/offload.ts`](src/qvac/offload.ts),
which is that gate written once; a third one is a subclass with a `run()` and
a header saying exactly what leaves.

**New compiler setup starts with Claude Code.** Since 2026-09-08, an installation
without a configured compiler offers the installed Claude CLI and asks the
administrator to install, sign in, test and apply it before real compilation.
This is the owner's requested initial choice, not a new accuracy measurement.
Preserve existing saved selections and environment overrides. An empty model
means the CLI's own default; opening the form must not silently turn it into
`opus`. Fresh demos remain mock. Installation detection, authentication status
and a successful structured response are different checks. Never expose raw
authentication metadata. Read [`docs/COMPILER-SETUP.md`](docs/COMPILER-SETUP.md)
before changing this flow.

`src/qvac/` is the only place `@qvac/sdk` is imported, and the adapter interface
is six methods. That is what makes "is the runtime the problem" answerable
rather than arguable: `llamacpp.ts` runs the same weights under a different
engine, and `pnpm run bench -- --against` pairs the two over identical cells.
Keep the boundary that tight — the moment a guard pass imports the SDK, the
question stops being cheap to ask.

**A document is checked completely or held.** `src/documents/` produces
sanitized reports and transient text, not verdicts. Documents require every
applicable input rule and every overlapping text window; failed extraction,
an unreadable source image or an unfinished window cannot be waived because a
paragraph was readable. The proxy forwards only masked text matched to the
complete original-byte digests. Do not add URL fetching, gateway paths or
unrecognized content passthrough to an employee API.

**Changing weights is an administrative operation.** The Models catalogue is
shared within an installation. Test each role before activation, keep analysis
local, and hold the role lease across the whole decision. A failed load restores
prior settings; an edit invalidates previous compatibility tests. Read
`docs/MODEL-MANAGEMENT.md` before changing these boundaries. Compatibility is
not evidence of policy accuracy.

**Prompt text is also administrative state.** Read `docs/PROMPT-MANAGEMENT.md`
before changing compiler/analyzer prompt builders. Defaults must remain byte
identical unless a measured default change is explicitly intended. Templates
replace complete prompts with one-pass literal variables; request data is never
re-interpolated. Hold one snapshot across a split and its rules, or an analysis
and all its windows. Keep schema/parsing/isolation contracts in code. The bench
cache keys on effective template hashes so editing instructions cannot reuse
answers generated under another prompt. Never put template text in the audit.

**When you add a pass with a new enum label, add that label to the mock.** Its
`mockValue` picks from the enum by matching known benign and hostile names; a
label it does not recognise falls through to `choices[0]` and makes the mock
answer "attack" to everything. It has cost two false alarms already.

## Security posture

See [`SECURITY.md`](SECURITY.md) for the threat model and how to report
something. The parts that matter while you are editing:

- **The administrative API is protected by [`src/server/admin-auth.ts`](src/server/admin-auth.ts).**
  Its allowlist names the routes an *employee* may call; everything else needs an
  administrator. Adding a route makes it administrative by default — which is
  the correct direction, and the reason the list is written that way.
- **Nothing an employee sends identifies them.** Identity is the API key and only
  the API key. Never read a name, role, or id from a request body or header.
- **`exemptRoles` lives inside the policy hash.** It is the most
  security-relevant sentence in the spec. Do not add a second notion of "admin"
  beside it.
- **The audit log stores prompt hashes, never prompt text.** Keeping the text
  would make the governance record the largest data-exposure risk in the system.
  That has not changed and must not: `recordDecision` strips `maskedPrompt`
  and `maskedDocuments` before writing. Original document bytes and extracted
  document text do not enter retention or events either; sanitized filenames,
  complete-byte hashes and extraction metadata remain as audit evidence.
- **Prompt text lives in a second store with a date on it**
  ([`src/audit/prompts.ts`](src/audit/prompts.ts)). The console has to be able
  to show an administrator what was blocked, and it used to do that from a Map
  of the last 300 that emptied on restart — which is not a retention policy but
  an accident of process lifetime, and not a sentence a company can put in
  writing for the people being logged. It is now masked text only, seven days
  by default, `0600`, gitignored, and expiry is checked **on every read** so a
  file that outlived its sweep cannot serve anything. `WARDEN_PROMPT_RETENTION_DAYS=0`
  turns it off and deletes the file. If you make this longer, you are making
  the blast radius of a stolen gateway larger by the same factor — say so out
  loud when you do.
- **The hook defaults to failing open on timeout.** A deadline that passes
  lets the prompt through unchecked unless the hook has learned the gateway's
  `WARDEN_FAIL_CLOSED=1` setting; a native client's own deadline is independent. This is documented in
  `SECURITY.md` and in `docs/HOOK-VERIFICATION.md`; it is a known, deliberate
  trade, not an oversight to fix quietly. It was 30 seconds until v0.1.18 and
  is 90 now, because the optional 8B adjudicator was measured at 46 seconds on
  four CPU cores and a guard that cannot answer inside the deadline is not a
  slow guard, it is an absent one. Raising it costs a person waiting; leaving
  it costs the check. Both halves of the deadline have to move together — the
  harness kills the hook on its own clock, so `integrations/claude-code/settings.json`
  carries `timeout: 120` beside it, and `warden-hook --fix` writes the same
  number into `~/.claude/settings.json`. Claude Code's own default for this
  event is 30 seconds (checked 2026-09-06), and an entry without the field is
  a guard that stops guarding on the machines where it is slow.

## What is honestly unfinished

Warden was built fast and the repo says so rather than pretending otherwise.

- Both hook integrations are **NOT VERIFIED** end to end. See
  [`docs/HOOK-VERIFICATION.md`](docs/HOOK-VERIFICATION.md).
- **The default judge has one run behind it.** Since 2026-09-04 the default
  adjudicator is **DynaGuard-4B** (a Qwen3 fine-tune for user-written
  policies): 23% of honest requests refused and 87% of attacks stopped, on one
  185-prompt run on one GPU machine, against 72% / 95% for the Qwen3-1.7B it
  replaced and 9% / 72% for the 8B. It was made the default on the owner's
  decision, not because it cleared this file's measurement rule, and
  `docs/MEASUREMENTS.md` says so. Owed before anyone relies on the numbers:
  `--reps 3`, a second machine, and a CPU-only machine — 4.4 s a decision on
  Metal will be several times slower on CPU, against a hook that fails open at
  90 s. Local compilation uses separate Qwen3-1.7B weights because DynaGuard can
  only say PASS or FAIL; initial Claude setup does not need those compiler
  weights. Where the remaining error lives: developer sentences about
  code against `r-instruction-override`, on every model, in both languages; a
  **rule boundary** (what a rule is *not* about, now a schema field the
  compiler fills) fixes twenty points of it on the base model and hurts the
  fine-tune, so the judge reads it only under the base model's prompt forms.
- The 8B also costs **46 s per decision** on four CPU cores, against a hook that
  gives up at 30 and fails open. That is a fact about the machine, and it is why
  the number is worth having: a deployment with a GPU should measure it again.
- Historical model runs skipped attachment-bearing prompts because the old
  QVAC OCR model resolved only over the P2P registry. The current public path
  has tested PDF/DOCX/text parsing and bundled English/Spanish OCR, including a
  packaged macOS arm64 smoke. Those tests do not establish document attack
  accuracy or retroactively repair historical scores. Native attachment coverage
  still depends on hosts exposing bytes or explicit paths; never infer paths
  from prose. See `docs/DOCUMENTS.md` and `docs/HOOK-VERIFICATION.md`.
- **The policy splitter splits on a capable compiler, and only there.**
  `compilePolicy` turns one broad instruction into the specific rules it
  means. Run against the real `Qwen3-1.7B-Q4_0` on 2026-09-01 it returned
  **one statement on three of three inputs** and paraphrased two of them
  wrongly (*"dejen de filtrar datos de clientes"* became a `warn` rule against
  **filtering**, the false friend), so the console never routes the local
  model to it, and a split of one returns the administrator's own sentence
  rather than the model's rewrite of it. Through `qvac/cli-compiler.ts` on the
  `claude` CLI it works, and on 2026-09-05 it was made to do the job it was
  built for: the prompt used to say "at most five, fewer is better, and if it
  is already one prohibition return it alone", and a capable model obeyed —
  *"hacé que no leakeen datos"* came back as one statement and one rule
  naming three categories in a sentence. It now asks for what the worry is
  made of, one concrete thing per statement, up to eight; the same sentence
  becomes five rules (customer contacts, credentials, unreleased financials,
  source code, internal documents), a spending target inside the sentence
  survives as its own statement and comes back as proposed limits beside the
  rules, and the console shows the whole set with a check under each card and
  one button to activate all of them, on the owner's decision. See
  `docs/MEASUREMENTS.md`, "The splitter, asked to enumerate". Still missing: a
  corpus of broad instructions paired with the rules they ought to become, so
  "works" means five sentences and a person reading the output, and whether
  item-shaped rules judge better than category-shaped ones on the real judge
  is a hypothesis that row sets up and does not test.
- Quota counters live in memory and reset with the process.
- Employee API keys are stored in plaintext in the directory file; compiler
  provider keys are plaintext in `data/settings.json` and `data/models.json`
  (written `0600`, gitignored). On every
  employee laptop the key is also in the shell profile and, since 0.1.44, in
  the `env` block of `~/.claude/settings.json`, because a Claude Code opened
  from the desktop app reads the second and not the first.

If you fix one of these, add the row to `docs/MEASUREMENTS.md` with the run
behind it.

## Console copy

Page and section headings have no explanatory subtitle by default. Remove text
that repeats a title, tab, loading state or visible action; do not move the same
introduction into the content or replace it with an information icon. Keep record
metadata, rule scope, error recovery and action consequences where they matter.
When text is absent, omit its element and spacing. Figma and `web/` are the shared
reference, including dark variants; standalone layout artifacts are not. This
supersedes the historical decisions to move header descriptions into section
ledes. Verify copy changes with `pnpm run test:console` and browser renders.
