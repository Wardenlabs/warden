# Architecture and code review — 2026-09-04

What the codebase looked like, what was changed, what was measured, and what
is still worth doing. Written for whoever picks this up next.

## The short version

The guard is well designed and was left alone. The invariant in `CLAUDE.md`
(verdicts only tighten, `aggregate()` is the one place a verdict is decided,
no model is ever asked for an ALLOW) holds in the code, the pipeline is four
passes of ordinary code around two model calls, and every measured default has
a note beside it. Nothing in this review touches how a rule is judged, so the
bench has nothing to say about it, and nothing here moves a security-relevant
default.

The debt was at the two edges: the HTTP server and the console. Each was one
file that everything had been appended to, and each showed the same symptoms.

| File | Before | After |
| --- | ---: | ---: |
| `src/server/index.ts` | 2394 lines, 60 routes, 12 concerns | 44 lines: boot, listen, warm, exit |
| largest file under `src/server/` | 2394 | 241 (`middleware.ts`) |
| `web/app.js` | 3807 lines, 11 screens | 35 lines: import the screens, `boot()` |
| largest file under `web/js/` | — | 566 (`draft.js`, the rule conversation) |

Both splits are mechanical: no function body changed, no route path changed,
no request or response shape changed. The one behaviour change is a bug fix
the verification surfaced, described below.

## What "patch after patch" looked like, concretely

These are the specific symptoms, so the next person can recognise them early.

- **A header that no longer described the file.** `server/index.ts` opened
  with "This file is intentionally thin. Each route delegates to a module."
  It was 2394 lines. Every route did delegate, and there were sixty of them,
  plus the environment, six middlewares, the SSE stream, the desktop message
  channel and the exit path.
- **Doc comments that had drifted off their subject.** Twelve of them. The
  paragraph explaining why authorisation runs ahead of every route sat above
  the admin *audit* middleware; the one about the install script sat above the
  OpenCode plugin route; "Wrap an async route so a rejected promise becomes a
  500" sat above `looksLikeModelDown`. Each is a route that was inserted
  between a comment and the thing it explained. The comments carry the
  project's reasoning, so a comment on the wrong thing is worse than none.
- **A constant declared after its first use.** `REQUIRE_HTTPS` was read by
  the security-headers middleware and declared forty lines further down, with
  the rate limiter's explanatory comment sitting above it instead of above the
  limiter. It worked because middleware runs after module evaluation. That is
  the kind of correctness that survives exactly until somebody calls the
  function at load time.
- **Scaffolding that outlived its purpose.** `optional()` dynamically imported
  five modules "that may not exist yet" so routes could be wired against a
  frozen contract. All five have existed for a long time. What the pattern was
  still doing: erasing every type at the call site (`compileRule: (a: unknown,
  t: string, p: unknown) => Promise<unknown>` followed by a cast), keeping two
  stub branches alive that could not run, and turning a broken transitive
  import into a silent 503. It also hid a real type: `compileRule` returned a
  refusal `as unknown as Rule`, and both callers re-cast it back.
- **A test double that did not know the schema had grown.** The mock filled
  every property of a JSON schema, optional or not. When `usageFactor` was
  added to the rule draft with `gt(0)`, the mock started writing `0` into
  every draft and `/api/policy/draft` began answering 500 in demo mode. Nobody
  noticed because nobody drafts rules in demo mode on purpose, which is the
  one flow the mock exists for. `CLAUDE.md` already records two earlier cases
  of the same class ("when you add a pass with a new enum label, add that
  label to the mock").

## What changed

### `src/server/`

`index.ts` boots. `app.ts` creates the Express app and is the only file that
knows the order middleware runs in; the reasons for that order (audit before
the gate, gate after CORS) are beside the lines that set it. Everything else
is a file named for what it is:

- `config.ts` — `PORT`, `HOST`, `ASSETS`, `seedPath()`, and the
  `ELECTRON_RUN_AS_NODE` note. A flag only one route reads stays with that
  route.
- `middleware.ts` — CORS, security headers and the https refusal, the two
  rate limits, the administrative-action audit, the administrator gate.
- `http.ts` — `asyncRoute`, `looksLikeModelDown`, `readJsonFile`,
  `gatewayUrl`, `lanAddresses`.
- `identity.ts` — `resolveActor` (the API key is the whole identity),
  `extractPrompt`, `reportedUsage`, `evaluateRequest`, `UNKNOWN_KEY`.
- `events.ts` — the SSE client set, `emitDecision`, and the remembered-prompt
  join.
- `desktop-bridge.ts` — the `parentPort` channel to the Electron shell.
- `lifecycle.ts` — model preload state, `preloadModels`, the exit handlers.
- `routes/` — one router per surface: `audit`, `policy`, `settings`,
  `people`, `company`, `guard` (what an employee's tool calls), `review` (the
  administrator's side of appeals and escalations), `proxy`, `redteam`,
  `install`, `solo`, `system`.

`admin-auth.ts` and `rate-limit.ts` were already separate and were not
touched. `needsAdmin`'s allowlist is unchanged, so the "administrative by
default" property survives the split unchanged: a new route in any router file
is closed until it is named there.

`policy/compile.ts` gained `type Declined` and `isDeclined()`, and
`compileRule` returns `Promise<Rule | Declined>`. This replaced three casts.

### `web/`

`app.js` imports one module per screen and calls `boot()`. The screens are in
`web/js/`: `activity`, `inbox`, `rules`, `draft`, `compiler`, `limits`,
`engine`, `team`, `simulator`, `redteam`, `solo`, over a shared floor of
`core` (state, escaping, the admin key, `api`), `format`, `router`, `data`,
`render`, `nav`, and `views` (the `VIEWS` registry, alone in a file that
imports nothing so it exists before any screen writes into it).

The import graph has cycles, which is fine for ES modules as long as nothing
reads another module's `const` during its own top-level evaluation. Two things
guarantee that here: `VIEWS` and `state` live in leaf modules, and the five
arrow-function consts other modules referenced from top-level statements
(`onNewRule`, `inConversation`, `composing`, `pendingEscalations`,
`regressionSample`, `toggleSel`) are function declarations now, which are
bound at instantiation.

No build step was added. `index.html` already loaded the console as
`type="module"`, and the desktop packager keeps everything under `web/`.

### The mock

`MockQvacAdapter.completeJSON` now fills only the properties the schema lists
as `required`. An optional property is the schema giving a model room to say
something extra — a refusal, a spending fraction — and the mock has no opinion
to add there. Rule drafting works in demo mode again.

## How it was verified

- `tsc --noEmit`, `tsc -p tsconfig.build.json`, the full `build` (server,
  desktop, corpus copy), `test:auth` (30/30 paths), `test:hook` (7/7).
- **A/B against the committed server.** Both the original and the refactored
  gateway ran in mock mode from fresh state on separate ports, driven through
  the same 96-request sequence covering every route (happy paths, 400s, 401s,
  404s, 409s, the install script, the solo surface). Transcripts were
  normalised for volatile fields and diffed: the only differences were
  timestamps, ports, generated keys and install tokens, and the chain hashes
  that depend on those. The original produced five 500s (all the mock
  `usageFactor` bug); the refactored server with the mock fix produced none
  and every other status was identical.
- **The console in a browser**, served by the refactored gateway in mock
  mode: every screen renders with no console error except the expected 404
  for a red-team report that has not been run. The sample company loads; a
  prompt sent in the simulator is judged and offers a rewrite; a rule is
  drafted, refused at Activate until an audience is chosen, activated, and
  landed on; a person opens with their rule groups and their onboarding pack.
- The compiled `dist/server/index.js` boots in mock mode and passes the same
  three checks the Linux CI job runs.

## What is still large, and why it was left

These are the next files by size. None was touched, for the reason given.

| File | Lines | Why not now |
| --- | ---: | --- |
| `scripts/bench-adjudicator.ts` | 675 | A measurement tool. Its shape is the experiment's shape; splitting it buys nothing until the experiment changes. |
| `src/policy/compile.ts` | 569 | `ratifyRule`/`removeRule` are store operations sitting beside the compiler and could move to `policy/store.ts`; the rest is one prompt and its parsing. Worth doing, but it is the compiler and `docs/MEASUREMENTS.md` says what moving its text cost. Move the two store functions and leave the prompt alone. |
| `src/policy/people.ts` | 553 | Directory persistence plus key issuance plus seeding. Seeding (`loadSampleCompany`, `discardSeededPeople`, `clearDemoDirectory`) is a natural second file. |
| `src/guard/passes/adjudicate.ts` | 547 | A guard pass. Everything in it is under the measurement rule. Do not restructure it without a bench run either side. |
| `src/qvac/client.ts` | 522 | Model loading, the runtime probe, and the inventory. `probeRuntime` + `modelInventory` are diagnostics and could sit apart from the load cache. |
| `src/guard/isolate.ts` | 521 | Pass 0. Same rule as adjudicate. |
| `desktop/main.ts` | 602 | The Electron shell. Menu building and the tunnel/LAN toggles are separable from window lifecycle. |
| `web/index.html` | 1092 | Markup is 10 lines; the rest is the stylesheet. It could be `web/styles.css`, which the header comment in `app.js` already half-describes. |
| `web/js/draft.js` | 566 | The rule conversation. It is one flow and reads as one; the size is the flow's size. |

Two smaller things noticed and not done:

- `proxy/openai.ts` has its own two-line `resolveActor`, identical to the one
  now in `server/identity.ts`. Deduplicating means the proxy importing from
  the server layer; it is not obviously the right direction and it saves two
  lines.
- The `docs/implements/solo-mode.md` plan discusses whether solo routes should
  be their own file. They are now (`routes/solo.ts`). The plan is left as the
  historical document it is.

## The rule that made this safe

Everything above was possible without risk because the guard has a boundary
that does not care where the HTTP handlers live, the mock is a real test double
rather than a fallback, and the repo already had a way to run the whole thing
with no models. A refactor is verifiable exactly to the extent the system can
be run without its expensive parts. Keep that property.
