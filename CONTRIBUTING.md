# Contributing

Thanks for looking. Warden is a policy gate for AI assistants, and the thing
that makes it worth anything is that its claims are measured rather than
asserted. Most of what follows is about keeping that true.

## Getting set up

```bash
pnpm install
pnpm run setup                     # downloads the models, ~1.8 GB
pnpm run dev                       # gateway + console on http://localhost:8080
```

No GPU, no models, or a locked-down network? Everything runs against a
deterministic test double:

```bash
WARDEN_ADAPTER=mock pnpm run dev
```

Node 22.17+ and pnpm 11. Read [`CLAUDE.md`](CLAUDE.md) before your first change
— it is the short version of how the codebase thinks.

## Before you open a pull request

```bash
pnpm run typecheck
WARDEN_ADAPTER=mock pnpm run redteam -- --no-baseline   # the pipeline still runs
```

If you touched anything the desktop app bundles, `pnpm run build` is the check
CI runs.

## If your change affects what the guard decides

This is the part that is different from most repositories, and it is not
optional.

**A single corpus run is not a result.** The false-positive side is n=16-18, and
two identical runs at temperature 0 have produced 44% and 31%. A change that
moves one or two prompts has not been measured, it has been observed once.

So: use the bench, which measures one message against one rule, runs both
variants over the identical cells, and reports a p-value on the disagreements.

```bash
pnpm run bench -- --a base --b <your-variant>
```

Then confirm on the pipeline:

```bash
pnpm run redteam -- --reps 3
```

Report **both columns or neither.** A guard that refuses everything stops 100%
of attacks and is worthless; the false-positive rate is what decides whether
anyone leaves it switched on. Every idea that lowered one of those numbers was
also capable of lowering it by quietly switching a rule off.

Add a row to [`docs/MEASUREMENTS.md`](docs/MEASUREMENTS.md) with the run behind
it — including if the answer was "no measured difference". That file records
failed ideas on purpose: the reason a thing did not work is worth more than the
thing.

**Security-relevant defaults do not change on an argument.** New levers ship off
with a note explaining what they are for and what would settle them. There are
several in the tree already; follow the pattern.

## Style

**Comments explain why, not what.** The house style is prose above the thing it
describes, recording the reasoning and especially what was tried before. A
comment restating the line under it is noise. A comment recording that a KV
cache key once caused a 100% false-positive rate is what stops the next person
re-adding it.

English everywhere — code, comments, docs, commit messages. Rule text and corpus
prompts are mixed Spanish and English because that is what real traffic in the
target deployment looks like.

**Commit messages are prose**, not bullet lists of files. Say what changed, why,
what you measured, and what you could not.

**Dependencies**: the runtime is express, zod and the QVAC SDK. Adding a fourth
needs a reason that survives being written down.

## Adding to the red-team corpus

New attacks are welcome and are one of the most useful contributions available.
A prompt goes in [`src/redteam/corpus/`](src/redteam/corpus/) with an `expect`
of `BLOCK`, `ESCALATE` or `ALLOW`.

Two things to know. Adding prompts moves the denominators, so rows in
`MEASUREMENTS.md` from before your change cannot be compared to rows after it —
say so in the commit. And **benign controls are worth more than attacks**: the
corpus needs legitimate work that superficially resembles an attack far more
than it needs another jailbreak, because that is the side the project is
currently losing on.

## Security

Do not open a public issue for something exploitable. See
[`SECURITY.md`](SECURITY.md), which also documents what Warden deliberately does
not defend against — worth reading before reporting one of those as a bug.

## Licence

Apache 2.0. By contributing you agree your work ships under it.
