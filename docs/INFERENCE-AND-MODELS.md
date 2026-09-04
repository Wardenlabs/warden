# Inference in the native app, and what would make it better — 2026-09-04

The question was: how do we make the guard faster and more accurate in the
desktop app, with RAG or anything else QVAC or Hugging Face offers, without
lowering model quality. This is the answer, split into what was measured on
this machine today, what the SDK actually offers, which models are worth the
weights, and the order to test them in. Nothing here moves a default; the
measurement rule in `CLAUDE.md` still applies to every line.

## What the native app runs, measured

The desktop app is the gateway in an Electron utility process, and the gateway
judges through `@qvac/sdk` 0.17, whose LLM backend is the `@qvac/llm-llamacpp`
addon — llama.cpp under the `bare` runtime. The SDK's defaults for a completion
model are `device: 'gpu', gpu_layers: 99` (`schemas/llamacpp-config.js`,
`LLM_CONFIG_DEFAULTS`); the only built-in override to CPU is for Google Pixel
phones. So on a Mac the judge already runs on Metal, and there is nothing to
switch on. The 46 s per decision recorded for the 8B in `docs/MEASUREMENTS.md`
was a four-core Linux box with no GPU, which the log said at the time and
which `CLAUDE.md` asked a GPU machine to remeasure.

Remeasured here. M1 Pro, 16 GB, Metal, the three weights the app downloads,
one adjudication call (221-token prompt, `predict: 24`, grammar-constrained
JSON), three hot runs each:

| Adjudicator | Backend reported | Load | Per rule call (hot median) | Time to first token | Decode |
| --- | --- | ---: | ---: | ---: | ---: |
| Qwen3-1.7B Q4_0, as shipped | `gpu` | 2.6 s | 404 ms | 178 ms | 108 tok/s |
| Qwen3-1.7B Q4_0, `device: 'gpu', gpu_layers: 99` explicit | `gpu` | 1.4 s | 406 ms | 174 ms | 92 tok/s |
| Qwen3-8B Q4_K_M, as shipped | `gpu` | 8.2 s | 1 576 ms | 915 ms | 19 tok/s |

Setting the GPU explicitly changes nothing, which is the point of the second
row. The 8B costs about four times the 1.7B per call, not the five to eighteen
times the CPU numbers suggested.

A decision is not one call. Every prompt is judged against the pinned rule plus
the top three retrieved rules, four calls in parallel against a model loaded
with `parallel: 4`, after an embedding call of about 14 ms. Both models were
then run through `pnpm run eval -- --attacks` on this machine, 185 prompts,
one repetition, benchmark policy, the same configuration as the 2026-08-31
rows in `docs/MEASUREMENTS.md`:

| 185 prompts, M1 Pro Metal | Qwen3-1.7B | Qwen3-8B |
| --- | --- | --- |
| Legitimate cleared | 31/109 cleared (78 refused, 72%) | 99/109 cleared (10 refused, 9%) |
| Attacks stopped | 72/76 (95%) | 55/76 (72%) |
| p50 / p95 per decision | 2.5 s / 2.9 s | 11.0 s / 25.9 s |
| Verdicts changed vs the CPU run | 23 of 185 (9 fixed, 14 broken; 20 of them on `r-instruction-override`) | 6 of 185 (2 fixed, 4 broken) |

Both records are in `data/measurements/` (marked dirty because the worktree
carried an untracked `node_modules` symlink, not because the code differed).
Three things in that table:

- **The 1.7B is 4.3× faster here** (2.5 s against 10.5 s on the CPU box) and
  no more accurate: 72% of honest requests refused against 63%, with 23
  verdicts moving between two runs of identical code and weights on two
  machines. The 8B moved 6. The small model's errors are close to a coin on
  those prompts; the large model's are a lean, which is what the log already
  said about them.
- **The 8B is not 8× faster in the product, it is 2.7×** (11 s against 30 s
  before deadlines, 46 s with them). One 8B call costs 1.6 s here, and a
  decision makes four of them concurrently against a model loaded with
  `parallel: 4`; four sequential calls would be 6.4 s and the measured median
  is 11 s. Eleven of 185 decisions ran past the 25 s pass deadline. The
  suspect was `parallel: 4`; measured, four concurrent 8B calls take 4.4 s
  under 1, 2 or 4 slots alike, so the slots are not it. The eval's prompts
  are three to four times longer than the probe's, and the 8B prefills at
  about 150 tok/s here: the 8B's cost on this machine is prompt length.
- **The 8B's accuracy is the same on Metal as on CPU**, which settles a
  question the log left open: its 16 lost attacks are the model, not the
  clock.

## Where the time goes, and which levers are real

Per decision, on the 1.7B: quota, secrets and isolation are code and cost
nothing; retrieval is one embedding; the four rule calls run concurrently and
each is dominated by prefill of a 200–600-token prompt, followed by at most 24
decoded tokens. On the 8B the same shape at four times the cost per call.

Levers that do not touch model quality, in order of what they are worth:

- **The model, at the same quality bar.** Every per-call cost above scales with
  parameter count; nothing in the configuration comes close. A fine-tuned 1.7B
  that answers as well as the base 8B would be the largest efficiency change
  available, which is why the next section is about weights.
- **Fewer calls per decision.** Four calls because TOP_K is 3 plus one pinned
  rule. A model trained on multi-rule policies (DynaGuard's policies have a
  median of three rules) could take the selected rules in one call. That is a
  variant to build and bench, not a setting to flip: the repo measured that
  the base Qwen answers one narrow question far better than one broad one.
- **KV cache.** Off, correctly. The keyed cache replays conversation state
  including the user turn, so reusing a key across messages replayed the
  previous verdict — measured at a 100% false-positive rate and recorded in
  `adjudicate.ts`. The SDK's `kvCache: true` auto-cache keys on the whole
  history too (`examples/kv-cache-example.js`), so it reuses nothing between
  two different messages. A prefix-only cache of the system block would save
  most of the prefill and the SDK does not expose one; worth asking upstream.
- **Context and KV type.** `ctx_size: 8192` with `parallel: 4` is 2 048 tokens
  per slot, ample. The addon's README says that on Metal with flash attention
  it already quantises K and V to q8_0 by default, "quality-neutral vs f16".
  Nothing to set.
- **Deadlines.** The hook waits 90 s and the pass 25 s. At 1.6 s per 8B call
  the pass deadline is not close; the CPU-era note in `models.ts` telling
  administrators to raise `WARDEN_HOOK_TIMEOUT_MS` for the 8B is about CPU
  machines and should say so.

## Models worth the weights

The failure to fix is specific and measured: the 1.7B refuses 63% of honest
requests, 46 of 51 of them on `r-instruction-override`, and the 8B fixes that
to 6% while losing sixteen attacks in three classes. Nine prompt-side attempts
sat inside the noise. The candidates below are ranked by how directly they
address *that*, not by a leaderboard.

**1. DynaGuard** — `tomg-group-umd/DynaGuard-{1.7B,4B,8B}`, Apache 2.0.
**Measured the same afternoon**, both sizes. 1.7B Q8_0: 45% of honest
requests refused against 72% for the shipped model, attacks 93% against 95%,
2.0 s a decision. 4B Q6_K: 23% refused, attacks 87%, 4.4 s a decision — the
first configuration inside both columns at once. Both have seats in the
console beside the default and the 8B. Writing the fine-tune a longer policy
made it worse every time (see the rule-format rows); it wants a short rule and
two examples per side. The full rows are in `docs/MEASUREMENTS.md`; the rest
of this entry is what was known before the run.
Qwen3-1.7B/4B/8B fine-tuned on 40 000 user-written policies to answer PASS or
FAIL about a dialogue. This is the pass's job on the pass's base model. On
DynaBench (free-form policy compliance) it scores F1 65.2 / 72.0 / 73.1 for the
three sizes against 26.7 for base Qwen3-8B, 70.1 for GPT-4o-mini and 13.1 for
LlamaGuard3; on standard safety sets it holds 77–80. Fast mode is a single
token; a chain-of-thought mode exists and is not what the guard wants. Two
caveats, both measurable: the training data is English and Warden's traffic is
half Spanish (the base is multilingual, the fine-tune may or may not carry),
and it has no UNCLEAR. GGUFs: `mradermacher/DynaGuard-1.7B-GGUF` (Q8_0 2.17 GB,
Q6_K 1.67 GB, Q4_K_M 1.28 GB) and `mradermacher/DynaGuard-4B-GGUF` (Q8_0
4.69 GB, Q6_K 3.63 GB). Use Q8_0 for the 1.7B and at least Q6_K for the 4B:
the brief was not to lose quality, and at these sizes the difference is a
gigabyte, not a decision. The `dynaguard` form in `adjudicate.ts` and the
bench variant of the same name are the wiring; the command is at the end.

**2. Qwen3-4B, base.** The proportionate step between the two seats Warden
has, never measured because the SDK's registry entry for it is S3-only. A
public GGUF exists (`bartowski/Qwen_Qwen3-4B-GGUF`) and `WARDEN_MODEL_ADJUDICATOR`
takes any path. Cheap to try and tells whether the 8B's permissiveness is
about size or about that model.

**3. Granite Guardian 3.3 8B** — `ibm-granite/granite-guardian-3.3-8b`, Apache
2.0. Supports a user-defined criterion (`guardian_config.custom_criteria`) and
answers yes/no in `<score>` tags, with an optional thinking mode. Real
bring-your-own-policy support, but 8B is the only 3.3 size, and its prompt
template would need its own form. Second in line if DynaGuard disappoints.

**4. Qwen3Guard-Gen 0.6B/4B/8B and Llama Guard 3 1B.** Fixed safety
taxonomies (violence, sexual content, and so on). They are not policy judges:
LlamaGuard3 scores 13.1 on DynaBench. Not a fit for the adjudicator seat.

**5. Prompt injection classifiers** — `meta-llama/Llama-Prompt-Guard-2-86M`,
`protectai/deberta-v3-base-prompt-injection-v2`. Encoder classifiers, a few
milliseconds each, and exactly the shape of the `r-instruction-override`
question that causes nine tenths of the false positives. The obstacle is the
runtime: QVAC's `@qvac/classification-ggml` is an image classifier
(MobileNetV3) and llama.cpp does not run BERT-style classification heads. This
needs a second inference path, so it is a later project, noted here because it
is the cheapest possible answer to the most expensive rule.

**6. Thinking on, for one rule.** `reasoning_budget` is zero everywhere. A
budget of a few hundred tokens on the pinned rule only, on the 8B, is an
unmeasured hypothesis that costs latency in exactly the place the GPU just
made affordable. A bench variant is two lines.

## The rule format

Asked directly whether the problem is how rules are written and presented, the
answer is yes for the shipped model: one boundary sentence per rule — what the
rule is *not* about — took the base 1.7B from 72% to 52% honest requests
refused for two attacks, almost all of it on the pinned rule, and no prompt
change on that model had ever left the noise before. The rule schema has no
field for a boundary and the compiler is never asked for one; that is where the
next change belongs. The same sentences made DynaGuard worse (45% to 68%), so
the fix is coupled to the seat: a boundary clause for the base model, short
rules with the boundary as the first two compliant examples for the fine-tune
— measured on the 4B at 23% to 16% refused, no attack lost, and now what the
compiler is told to write. Rows and per-rule
attribution in `docs/MEASUREMENTS.md`.

## RAG, honestly

Warden already does retrieval-augmented judging: rules are embedded with their
violating examples, the top three by cosine plus every pinned rule are the
ones adjudicated, and each rule's prompt carries two examples per side. That
is the right shape for this problem, and `@qvac/rag` — a document RAG library
over HyperDB with chunking adapters — is built for a different one. Three
things retrieval could still do here:

- **Choose the shots.** Pick the two examples per side nearest the message
  instead of the first two. Built as `shotSelection: 'nearest'` and the
  `nearest-shots` bench variant, and measured: no difference on either column
  (p = 0.20 and 0.5, 32 cells disagreeing). It stays off.
- **Add evidence, never subtract it.** A message very close to a rule's
  violating examples could add an ESCALATE signal without a model call. It
  cannot go the other way: a similarity score clearing a request would be a
  model clearing a request, which the invariant forbids.
- **Give the fine-tuned judge more.** DynaGuard reads a policy of several
  rules at once; the retrieved set could go in one prompt. See "fewer calls".

## Fine-tuning, which is closer than the meeting assumed

`@qvac/llm-llamacpp` trains LoRA adapters on GGUF models on-device and loads
them with the `lora` config option (its README's "LoRA Finetuning" section and
examples). Warden already owns the labelled data a first adapter needs: the
109 legitimate prompts in `data/eval/` and the 76 corpus attacks, each with the
rule it should or should not trip. That is small, but the target is narrow —
one rule's grammatical false positives — and the measurement machinery to
tell whether an adapter helped already exists. It is the path if no public
fine-tune fits; it is not the first thing to try.

## The order to run things

Each step is one command and one paired comparison. None changes a default;
each writes a row in `docs/MEASUREMENTS.md`.

```bash
# 0. A saved base run to pair against (once per machine).
pnpm run bench -- --a base && cp data/bench-last.json data/bench-base.json

# 1. DynaGuard 1.7B, best quantisation, same prompt shape it was trained on.
WARDEN_MODEL_ADJUDICATOR=models/DynaGuard-1.7B.Q8_0.gguf \
  pnpm run bench -- --a dynaguard --against data/bench-base.json

# 2. The same with the 4B, if the 1.7B moved a column without losing the other.
# 3. Nearest-example shots on the shipped model, no download needed.
pnpm run bench -- --a base --b nearest-shots

# 4. Whatever wins the bench goes through both columns of the product run.
WARDEN_MODEL_ADJUDICATOR=... pnpm run eval -- --attacks --reps 3 --label "..."
```

Steps 0, 1 and 3 were run on 2026-09-04 and are recorded in
`docs/MEASUREMENTS.md`; step 2 was queued behind a download that the Hugging
Face CDN kept resetting.
