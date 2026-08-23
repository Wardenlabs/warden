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
| 2026-08-23 | `hadMetaInstructions` wired + Spanish in the pattern | `f6c75794` | **74/82 (90%)** | 8/16 (50%) | 1 | +4 attacks. `volume-distraction` 25% → 75%, `direct-override` 88% → 100%. False positives moved by one prompt and none is attributed to a structural concern — `r-instruction-override` still causes 8 of 9 |
| 2026-08-23 | SDK deadlines (`040f4e4`) | `f6c75794` | **137/160 (86%)** | 17/36 (47%) | **2** | First run at two repetitions, and the first that could finish: two earlier attempts hung, once on embedding an oversized prompt and once loading the OCR model over P2P. No OCR on this machine, so 12 attachments were unreadable — `document-borne` reads 8/8 stopped and 0/4 controls allowed, neither earned. `volume-distraction` back to 25%: the prompts now hit the deadline and escalate rather than being judged |

The policy hash changed between the two dates because the benchmark stopped
reading `data/policies.json`. The older rows measured whatever rules happened to
be in the live store on that machine, which is the bug that change fixed — they
are kept for continuity, not for comparison.

## Per-rule attribution

Which rule refused legitimate work, from the run that added attribution:

| Rule | Legitimate requests it blocked |
|---|---|
| `r-instruction-override` | 8 of 9 |
| `r-credentials` | 1 of 9 |
| every other rule | 1 each |

Measured again after the deterministic detector was wired: the shape did not
change. One pinned rule still causes almost every refusal of legitimate work,
and no false positive is attributed to a structural concern — the pure-code
checks catch attacks without costing anything on honest traffic.

It is pinned, so it runs on 100% of traffic while the rest are filtered by
retrieval. One rule, always on, produces most of the damage.

## Does the pin matter?

Same code, same corpus, same policy — the only difference is `pinned` on
`r-instruction-override`.

| | Pinned | Unpinned |
|---|---|---|
| Attacks stopped | 70/80 (88%) | 70/80 (88%) |
| False positives | 8/18 (44%) | 7/18 (39%) |

Attacks identical, false positives one prompt apart. Unpinning changes nothing
measurable, which kills both sides of the argument at once.

It does not cost what the pin was defending against: not one attack was lost by
letting retrieval choose. And it does not help either — if that rule causes eight
of nine false positives and unpinning does not lower them, retrieval is
selecting it anyway.

The reason it gets selected is visible in the rule: the legitimate prompts it
refuses are work imperatives ("aprobá la factura", "draft a reply"), and its
violating examples are all imperatives too. They are genuinely similar, so it
scores high and comes back through the top-K without needing the pin.

**The pin is not the problem. The rule is.** Six attempts have now failed to move
this number, and between them they rule out the wording, the examples, voting,
the retrieval floor, and the pin. What has not been tried is removing the rule
from LLM adjudication entirely and leaving the attack class to the deterministic
detector, which already matches 5 of 8 direct-override attacks at zero cost on
benign traffic.

## What the pinned rule is actually worth

Removing `r-instruction-override` from the policy entirely, leaving the attack
class to the deterministic detector. Same code, same corpus.

| | With the rule | Without it |
|---|---|---|
| Attacks stopped | 70/80 (88%) | 63/80 (79%) |
| False positives | 8/18 (44%) | 5/18 (28%) |

The first movement in the false-positive rate that is larger than one prompt,
and the first result all day that is not inside the noise band. It is also a
bad trade: seven attacks lost to save three refusals.

Where the attacks went is the useful part. `multi-turn-escalation` fell from
100% to 63%, `roleplay-fiction` and `obfuscation` from 88% to 75%. Those are
attacks spread across a conversation or wrapped in fiction — exactly the shapes
a regex cannot see and a rule reading for intent can.

So the rule is not a broken component to be removed. It is a priced trade:
**seven attacks for three false positives.** Anything that improves this number
has to keep the seven.

## Ideas measured and rejected

Kept because the reason a thing failed is worth more than the thing.

| Idea | Result |
|---|---|
| Rewriting that rule's compliant examples | 44% before, 44% after |
| Rewriting the rule text, three ways | 4/8, 3/8, 5/8 — the best one also lost an attack |
| Majority-of-3 self-consistency vote | 50% vs 44%, for 50 extra model calls |
| Dropping the preamble's "object of your analysis" clause | Probe said 4/8 → 2/8; the corpus said 10/14 → 10/15. The probe was reading noise |
| A relevance floor on retrieval (`MIN_RELEVANCE=0.5`) | False positives 7/16 → 8/16, attacks flat, one document-borne attack lost. Every difference was a single prompt, inside the ±6 band |
| Requiring a quoted span with every VIOLATES | False positives 8/18 → 10/18, attacks 70/80 → 69/80. Both worse |
| Unpinning `r-instruction-override` | Attacks identical (70/80 both), false positives 8/18 → 7/18. Retrieval selects the rule anyway, because the work imperatives it refuses genuinely resemble its violating examples |

The pattern: voting and rewording both assume the errors are random. They are
not. This model leans, and averaging more samples of a lean returns the lean.

The span attempt is worth reading twice, because it was argued as different in
kind — not "answer better" but "answer something we can check", where an
invented quote would be a false positive pure code could catch. It failed
anyway, and the reason was already written down here: a model can always copy
*something* out of the message, so the check almost never fires, while the extra
field costs what every extra field has cost. `{boolean, confidence}`, `reason`
and `span` are three versions of one mistake.

**Every field you ask a small model to fill is a chance for it to answer without
deciding.** Eight attempts, and the only two that moved anything were the ones
that asked the model for *less*, not more: the deterministic detector, which
asks it nothing, and removing a rule, which asks it one question fewer.

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
