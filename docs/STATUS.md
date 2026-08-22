# Where the project stands

Snapshot for the team. `README.md` is the submission document; this is the
working state.

## Built and verified

| | State |
|---|---|
| QVAC adapter + structured output | ✅ grammar + zod + repair + fail-closed. 80 first-try / 0 repaired / 0 failed on the last real-model run. |
| Guard pipeline | ✅ quota → sanitize → isolate → retrieve → adjudicate → aggregate, end to end |
| Policy compiler + presets + preview | ✅ 18 presets, NL→rule, preview before ratify |
| Secret sanitizer | ✅ keys, tokens, JWTs, Luhn-checked cards, emails. Offsets index the original text. |
| Quotas | ✅ per role per day |
| Audit log | ✅ hash-chained, `npm run verify-audit` passes |
| OpenAI proxy | ✅ 401 / 403 / 429 / 502 all correct |
| **Hook CLI** | ✅ blocks in both payload shapes, allows silently, fails open when Warden is down |
| Web console | ✅ three panes + red-team tab, verified in a browser |
| Red-team corpus | ✅ 98 prompts, 12 classes |
| Runner + REPORT.md | ✅ runs both modes, lists every failure by id |
| Setup script | ✅ diagnoses, downloads over HTTPS, proves inference |
| Benchmark generator | ⚠️ written, not yet run on real hardware |

## Open

**Latency is the real problem.** ~24s per prompt on this container's CPU with
four rules. Removing the KV cache key — which was silently replaying verdicts —
means every call reprocesses the whole prompt, and prompt length now dominates.
Mitigations applied: two few-shot examples per side instead of three,
`WARDEN_TOP_K` bounds the rule count. A Metal machine should be several times
faster, and **that number is what OPE-14 exists to find out.**

If the demo machine is still slow: lower `WARDEN_TOP_K` to 2 and say so on
camera as a measured trade-off. That is a better outcome than a demo with dead
air.

**Accuracy is not yet where it should be.** The benign-controls class went from
16/16 false positives to something better after four separate fixes, but the
number needs confirming on real hardware. Every failure is printed by id in
`REPORT.md`.

## Needs a human

| Who | What |
|---|---|
| Everyone | `npm run setup`, paste the report into OPE-14 |
| Fede | OPE-19 — watch the hook block inside real Claude Code / Codex. Until someone sees it, the central claim is unverified. |
| Jere | OPE-20 — improvised attacks + clean-clone check by someone who did not build it |
| Martin | OPE-12 — `npm run benchmark` and `npm run redteam` on the demo machine, pin the permalinks to a SHA, record, submit |

## What not to do

- Do not add OpenCode to the README. Nobody has watched it block anything.
- Do not re-add a `kvCache` key to adjudication. It replays verdicts, silently.
- Do not claim we intercept subscription traffic. We intercept the prompt via
  the tool's own hook before it is sent — accurate, and the stronger claim.
- Do not quote mock numbers as results. Everything that prints them says so.
