# Warden — notes for working in this repo

Local AI gateway. An admin writes policy in plain language; every employee
prompt is judged against it before reaching a model. All inference is on-device
via `@qvac/sdk`. Built for the Aleph Hackathon 2026 QVAC track.

Read `README.md` first for what it does. This file is about how to change it.

## Commands

```bash
npm run setup      # diagnose machine, download models, verify inference
npm run dev        # server + console on :8080
npm run smoke      # structured-output reliability
npm run redteam    # full corpus -> REPORT.md
npm run typecheck  # tsc --noEmit, run before every commit
```

`WARDEN_ADAPTER=mock` runs everything with no model present. Use it for UI work,
for the corpus, and in CI. It is a test double, never a production fallback.

## Layout

```
src/qvac/       the ONLY place @qvac/sdk is imported
  types.ts      QvacAdapter interface — the boundary everything else uses
  real.ts       grammar-constrained generation + zod + repair + fail-closed
  mock.ts       deterministic stand-in
  client.ts     per-role model loading
src/policy/     Rule/Quota/PolicySpec, compiler, presets, store, retrieval
src/guard/      isolate, sanitize, quota, passes/adjudicate, aggregate, pipeline
src/proxy/      OpenAI-compatible endpoint
src/hook/       warden-hook CLI for Claude Code and Codex
src/redteam/    corpus/*.json, runner, report generator
src/server/     Express host: proxy + /api + SSE
web/            console — one HTML file, one ES module, no build step
```

## Rules that are load-bearing

**Never import `@qvac/sdk` outside `src/qvac/`.** Everything takes a
`QvacAdapter`. This is what lets the whole system run against the mock, and what
makes "where does inference happen" answerable with one directory — which the
track's judges check first.

**Verdicts only ever get stricter.** `ALLOW < ESCALATE < BLOCK`, combined with
`tighten()` in `src/guard/types.ts`. Any pass that errors, times out, or returns
unparseable output resolves to `ESCALATE`, never `ALLOW`. If you add a pass, it
observes; only `aggregate()` decides. Do not add an early `return ALLOW`
anywhere in the pipeline.

**Ask a model for a label, not a boolean plus a confidence.** Measured on
Qwen3-1.7B: `{violates: bool, confidence: number}` gave 7/8 false positives with
incoherent pairings ("violates" at confidence 0.00). A single enum choice gave
0/8 on identical inputs. Confidence in `RuleVerdict` is derived from the label
on purpose — self-reported probability at this model size clustered at
0.00/0.95/1.00 regardless of the answer.

**One narrow question per rule.** Never batch rules into a single call. Small
models asked about eight rules answer confidently about none.

**Untrusted text never enters a prompt un-fenced.** Call `isolate()` and use its
`envelope`, plus `isolationPreamble(nonce)` in the system prompt. The nonce is
chosen after the text is fixed, which is the point — a fixed delimiter is one
the attacker can write.

**The mock reads only inside the envelope.** Matching keywords against the whole
prompt flags every request, because our own question text contains words like
"override". Same hazard the real passes face in subtler form.

## Adding things

**A guard pass** — add to `src/guard/passes/`, return `{ result, trace }`, wire
it into `pipeline.ts` in cost order (cheap and deterministic first), and feed
its output to `aggregate()`. Every pass appends a `PassTrace`; the console and
the audit log both render it.

**A rule field** — `src/policy/types.ts` (zod schema plus
`RULE_DRAFT_JSON_SCHEMA` if the compiler should emit it), then the compiler
prompt, then the console's draft renderer.

**A corpus class** — a new `src/redteam/corpus/NN-name.json`. The runner picks up
any file in that directory. Set `expect` to what a *correct* guard should do.
`ESCALATE` counts as stopping an attack.

**A tool integration** — extend `detect()` in `src/hook/cli.ts` with that tool's
prompt field and block format, and add its config under `integrations/`.

## Things that will bite you

- **Model download hangs forever.** QVAC's registry uses Hyperswarm (P2P/UDP),
  blocked on restricted networks. `npm run setup` downloads over HTTPS from
  HuggingFace instead — use it rather than letting `loadModel` fetch.
- **Stale servers.** `pkill -f "tsx src/server"` matches your own shell command
  and kills it. Use `ps -eo pid,args | grep '[t]sx .*server/index' | awk '{print $1}' | xargs kill`,
  and put it in its own command so the pattern is not in the same line.
- **The adjudicator is slow on CPU** — around 2-4s per rule. `WARDEN_TOP_K`
  bounds how many run, and `parallel: 4` at load time lets them overlap. If a
  demo machine is slow, lower `TOP_K` and say so rather than hiding it.
- **`data/policies.json` is generated.** Edit `data/seed/policies.seed.json` and
  delete the generated file to reseed.

## Honesty rules for this project

The track discards submissions describing capabilities that do not exist, so:

- Nothing goes in the README until it has been observed working. OpenCode is
  absent for exactly this reason.
- `REPORT.md` lists every failure by id. An all-green run means the corpus is too
  easy, and the report says so.
- Numbers generated from the mock are labelled as such, everywhere they appear.

## Measured findings, in the order we hit them

These are the load-bearing results. Each one changed the code, and each is
reproducible with the harness in the repo.

| Finding | Effect |
|---|---|
| `{boolean, confidence}` output shape | 7/8 false positives, incoherent pairings ("violates" at confidence 0.00) |
| Same task as a single enum label | 0/8 false positives, same model, same inputs |
| Adding a `reason` string to the verdict | **16/16 false positives** — truncated JSON → fail-closed, 7-12s latency, formulaic content |
| Removing `reason`, composing it in code | Fixed all three at once |
| `UNCLEAR` escalating on its own | Every prompt touching several rules eventually met one the model hedged on |
| Self-reported confidence | Clustered at 0.00/0.95/1.00 regardless of the answer — no information |

The pattern across all of them: **every field you ask a small model to fill is
a chance for it to answer without deciding.** Ask for the minimum, derive the
rest.
