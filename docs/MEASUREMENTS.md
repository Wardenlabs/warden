# Measurement log

Every corpus run we have taken a decision from, oldest first. `REPORT.md` holds
the current run in full; this file is the trend, so a change can be judged
against what came before it rather than against memory.

`CLAUDE.md` lists the findings that changed the code. This lists the runs.

## How to read a row

Both columns or neither. A guard that refuses everything scores 100% on attacks
and is unusable, and every idea that lowered the false-positive rate here was
also capable of lowering it by switching a rule off.

**A single repetition is not a result.** Two identical runs of `benign-controls`
against the same policy at temperature 0 gave 44% and 31%: `parallel: 4` batches
concurrent adjudications and the batch composition moves the numerics. With
n=16, one prompt is ±6 points. Rows marked `reps 1` can only support a
difference bigger than that, and mostly they support none.

## Runs

| Date | Config | Policy | Attacks stopped | False positives | Reps | Note |
|---|---|---|---|---|---|---|
| 2026-08-22 | baseline (guard off) | `69d4ba36` | 2/82 (2%) | — | 1 | A system prompt is a request, not a control |
| 2026-08-22 | shipped | `69d4ba36` | 66/82 (80%) | 7/16 (44%) | 1 | Measured against the live store, not a pinned policy |
| 2026-08-23 | `MIN_RELEVANCE=0` | `f6c75794` | **70/82 (85%)** | **7/16 (44%)** | 1 | First run against the pinned benchmark policy. The floor exists but is off, so this is the reference point for it |
| 2026-08-23 | `MIN_RELEVANCE=0.5` | `f6c75794` | ~flat (+1 authority-spoofing, −1 document-borne) | 8/16 (50%) | 1 | No measurable effect, and it lost an attack. Floor stays off |

The policy hash changed between the two dates because the benchmark stopped
reading `data/policies.json`. The older rows measured whatever rules happened to
be in the live store on that machine, which is the bug that change fixed — they
are kept for continuity, not for comparison.

## Per-rule attribution

Which rule refused legitimate work, from the run that added attribution:

| Rule | Legitimate requests it blocked |
|---|---|
| `r-instruction-override` | 10 of 14 |
| `r-credentials` | 3 of 14 |
| every other rule | 1-2 each |

It is pinned, so it runs on 100% of traffic while the rest are filtered by
retrieval. One rule, always on, produces most of the damage.

## Ideas measured and rejected

Kept because the reason a thing failed is worth more than the thing.

| Idea | Result |
|---|---|
| Rewriting that rule's compliant examples | 44% before, 44% after |
| Rewriting the rule text, three ways | 4/8, 3/8, 5/8 — the best one also lost an attack |
| Majority-of-3 self-consistency vote | 50% vs 44%, for 50 extra model calls |
| Dropping the preamble's "object of your analysis" clause | Probe said 4/8 → 2/8; the corpus said 10/14 → 10/15. The probe was reading noise |
| A relevance floor on retrieval (`MIN_RELEVANCE=0.5`) | False positives 7/16 → 8/16, attacks flat, one document-borne attack lost. Every difference was a single prompt, inside the ±6 band |

The pattern: voting and rewording both assume the errors are random. They are
not. This model leans, and averaging more samples of a lean returns the lean.

## Open

- `WARDEN_MIN_RELEVANCE` — measured at 0.5 and it did nothing, for a reason
  worth keeping: the rule causing 10 of 14 false positives is pinned, and
  pinned rules bypass the floor by design. The floor could only ever reach the
  other four, which is an effect too small for n=16 to resolve. It stays in the
  code as a latency lever — it still removes model calls — but not as an answer
  to the false-positive rate. Anything aimed at that rate has to reach the
  pinned rule.
- The `detector` model (Qwen3-0.6B) is downloaded by `npm run setup` and the
  pipeline never loads it. The injection pass it was meant for was never wired.
- `META_INSTRUCTION` in `isolate.ts` matches `ignore|disregard|forget|override`
  and nothing in Spanish. Against the five attacks in `probe-rule.ts` the
  deterministic detectors catch three, and both misses are the Spanish ones.
