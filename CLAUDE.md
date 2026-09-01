# Working on Warden

Warden is a local AI gateway. An administrator writes policy in plain language;
every employee prompt is judged against it before it reaches any model, and all
inference runs on-device through QVAC.

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
  aggregate.ts     pass 4 — the only place a verdict is decided. No inference
  sanitize.ts      pass -1 — mask secrets before anything else sees the text
  quota.ts         pass -2 — per-role daily counters
src/policy/      rules, roles, people, retrieval, the compiler
src/qvac/        the only boundary to @qvac/sdk. Everything else uses an adapter
src/server/      HTTP: the console API, the OpenAI-shaped proxy, onboarding
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
runtime is express, zod, and the QVAC SDK.

## Running it

```bash
pnpm install
pnpm run setup                    # downloads the models (~1.8 GB)
pnpm run dev                      # gateway + console on :8080
WARDEN_ADAPTER=mock pnpm run dev  # no models, no GPU — the mock stands in
pnpm run typecheck
pnpm run redteam                  # the corpus. Writes REPORT.md
pnpm run bench                    # the adjudicator bench
pnpm run verify-audit             # walk the audit chain
```

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
for that to happen. If you add a third of these, gate it the same way and say
in its header exactly what leaves.

`src/qvac/` is the only place `@qvac/sdk` is imported, and the adapter interface
is six methods. That is what makes "is the runtime the problem" answerable
rather than arguable: `llamacpp.ts` runs the same weights under a different
engine, and `pnpm run bench -- --against` pairs the two over identical cells.
Keep the boundary that tight — the moment a guard pass imports the SDK, the
question stops being cheap to ask.

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
  before writing, and nothing in the hash chain `verifyChain()` walks contains
  a prompt.
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
- **The hook fails open on timeout, by design and under protest.** A 30-second
  deadline that passes lets the prompt through unchecked. This is documented in
  `SECURITY.md` and in `docs/HOOK-VERIFICATION.md`; it is a known, deliberate
  trade, not an oversight to fix quietly.

## What is honestly unfinished

Warden was built fast and the repo says so rather than pretending otherwise.

- Both hook integrations are **NOT VERIFIED** end to end. See
  [`docs/HOOK-VERIFICATION.md`](docs/HOOK-VERIFICATION.md).
- **No shipped configuration passes both columns.** On the 185-prompt paired run
  the 1.7B refuses 63% of legitimate requests, and the 8B that fixes that
  (down to 6%) drops attacks caught from 89% to 71%, losing thirteen of sixteen
  in `hypothetical-testing`, `multi-turn-escalation` and `roleplay-fiction`.
  A guard refusing two of every three honest requests gets switched off; a guard
  missing half the attacks that need judgement is not a guard. This is the
  thing to fix, and `docs/MEASUREMENTS.md` records where the remaining error
  lives: all 7 of the 8B's false positives are `r-instruction-override`, all 7
  are developer sentences about code, and the split is grammatical rather than
  semantic.
- The 8B also costs **46 s per decision** on four CPU cores, against a hook that
  gives up at 30 and fails open. That is a fact about the machine, and it is why
  the number is worth having: a deployment with a GPU should measure it again.
- Six attachment-bearing corpus prompts are skipped in every run, because the
  OCR model resolves only over the P2P registry. `document-borne` has never been
  measured.
- **The policy splitter does not split.** `compilePolicy` was built to turn one
  broad instruction into several specific rules. Run against the real
  `Qwen3-1.7B-Q4_0` on 2026-09-01, it returned **one statement on three of
  three inputs** — English and Spanish — so what it currently is, is
  `compileRule` plus a thirty-second model call. Two of those three runs were
  also actively worse than not splitting: *"nadie puede mandar datos de
  clientes afuera de la empresa"* came back as *"nadar datos de clientes"*, and
  *"dejen de filtrar datos de clientes"* compiled into a `warn` rule against
  **filtering** customer data — the false friend — whose compliant example was
  *"send customer data to a third-party for analysis"*. A draft that permits
  the leak it was asked to stop.

  The boundary held: nothing was enacted, and an administrator ratifying that
  draft would have rejected it. The paraphrase failure is now structurally
  impossible — a split of one returns the administrator's own sentence, never
  the model's rewrite of it.

  **It works on a capable compiler, which was the stated precondition.** Same
  day, same sentences, through `qvac/cli-compiler.ts` on the `claude` CLI
  (sonnet): *"no quiero que se filtren datos de clientes ni que aprueben pagos
  grandes sin mi"* split into two statements and compiled into a `block` rule
  about customer data and an `escalate` rule about payment approval, in 25
  seconds; *"quiero que dejen de filtrar datos de clientes"* — the false friend
  the 1.7B inverted — came back as `block`, "Employees must not share or leak
  customer data outside authorized channels", with Spanish examples on both
  sides, in 9. So the pass is not wrong; the local 1.7B is too small for it.

  It still ships off the measured path on the default configuration, because
  the default configuration is that 1.7B: `/api/policy/draft` is untouched,
  `/api/policy/draft-set` is its own route behind its own button, and no
  single-rule compile pays for it. What has changed is that there is now a way
  to turn it on that costs nothing — the coding agent already signed in on the
  machine. What is still missing is a corpus of broad instructions paired with
  the rules they ought to become, so "works" here means three sentences and a
  human reading the output, not a measurement.
- Quota counters live in memory and reset with the process.
- API keys are stored in plaintext in the directory file, and so is the compiler
  provider key in `data/settings.json` (written `0600`, gitignored).

If you fix one of these, add the row to `docs/MEASUREMENTS.md` with the run
behind it.
