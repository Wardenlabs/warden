# Warden — benchmarks

Measured by `pnpm run benchmark` on 2026-08-23T08:42:42.363Z, from commit `040f4e4`.

These numbers describe the machine below and nothing else — regenerate on
whichever one records the demo. To find out whether the code has moved since, `git log 040f4e4..HEAD -- src/guard src/qvac`; anything listed means this table is describing something that no longer runs.

## Machine

| | |
|---|---|
| Platform | linux x64 (6.18.44-fc-v21) |
| CPU | Intel(R) Xeon(R) Processor @ 2.10GHz × 4 |
| RAM | 17 GB |
| Node | v22.22.2 |
| Adapter | real |

## Models

| Role | Model | Quantization | Engine |
|---|---|---|---|
| Adjudicator, compiler | Qwen3-1.7B-Instruct | Q4_0 | llama.cpp via @qvac/sdk |
| Retrieval | EmbeddingGemma-300M | Q8_0 | llama.cpp via @qvac/sdk |
| Attachments | OCR_LATIN | — | ONNX via @qvac/sdk |

## Latency

8 runs each, after warm-up. Cold model load is excluded — it is a few
seconds and would describe startup rather than steady state.

| Operation | p50 | p95 | mean |
|---|---|---|---|
| **Single rule adjudication** — rule + few-shots, as the pipeline calls it | **2720ms** | 2928ms | 2710ms |
| Bare labelling call — no rule in the system block | 1014ms | 1117ms | 1013ms |
| Embedding one prompt | 15ms | 57ms | 22ms |
| **Full pipeline** (3 rules + pinned) | **11382ms** | 13411ms | 11518ms |

Generation throughput: **26 tok/s**.

The gap between the first two rows is prompt length, and it is why the KV cache
key was tempting: the rule block is identical across calls about that rule, so
caching it looks free. It replayed verdicts instead. That cost is paid on every
call, deliberately.

The pipeline does not cost the sum of its rules: the adjudicator loads with
`parallel: 4`, so several rule judgements share one model instance instead of
queueing. `WARDEN_TOP_K` bounds how many run — lowering it is the first lever
if a machine is too slow to demo on.

## Structured-output reliability

Every call the guard actually makes — the adjudications and the full pipeline
runs above. The rejected verdict shape is measured separately below, so its
failures do not flatter or damage this table.

| | count | share |
|---|---|---|
| Validated first attempt | 49 | 100% |
| Needed one repair | 0 | 0% |
| Failed closed | 0 | 0% |

Every verdict is generated under a JSON-schema grammar, so the shape is
guaranteed by the decoder. Zod then checks the content, which a grammar cannot:
it can require a number, not a number between 0 and 1. Anything still invalid
after one repair escalates to a human rather than being guessed at.

## What one extra field costs

The same model, the same prompts, the same bare system block, one free-text
`reason` added next to the label — the design this project started with and
threw away. 8 runs:

| Verdict shape | p50 | p95 | repaired | failed closed |
|---|---|---|---|---|
| `{verdict}` — what the guard asks for | 1014ms | 1117ms | 0 | 0 |
| `{verdict, reason}` — what it used to ask for | 5760ms | 5967ms | 4 | 0 |

That is **5.7×** on latency, and the last two columns are the rest of
it: the reason runs long, overruns the token cap, and leaves JSON that will not
validate. The explanation an employee reads is composed in code from the
ratified rule instead — instant, and it cannot fail to parse.
