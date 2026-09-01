# Security

Warden is a policy gate for AI assistants. Its whole purpose is to be the thing
an employee cannot route around, so a weakness here is not a bug beside the
product — it is the product failing.

This document says what Warden defends against, what it does not, and how to
report something.

## Reporting a vulnerability

Open a [security advisory](https://github.com/Wardenlabs/warden/security/advisories/new)
on the repository, or email the maintainer listed in `package.json`. Please do
not open a public issue for something exploitable.

Include what you can reach, from where, and what it gets you. A working request
is worth more than a description. We will acknowledge, and we would rather have
a report that turns out to be a misunderstanding than not have it.

## Threat model

The attacker is an **employee of the company running Warden**, or anyone who can
reach the gateway's port. They are not assumed to be unskilled, and they are
assumed to have read this repository.

What they want is for a prompt the policy forbids to reach a model anyway.

### What Warden defends

**Prompt-level attacks.** Instruction override, authority spoofing, roleplay and
fiction framings, hypothetical framing, obfuscation, homoglyphs and invisible
characters, language switching, injections riding in on an attachment, and
attacks aimed at the guard itself. The corpus in
[`src/redteam/corpus/`](src/redteam/corpus/) is 98 prompts across twelve
classes, and [`REPORT.md`](REPORT.md) is the last recorded run against it.

**Attacks on the evaluator.** The untrusted text is fenced inside a delimiter
carrying a 128-bit nonce chosen after the text is fixed, so a forged fence
cannot be guessed. Forged delimiters, dictated verdict labels and instructions
addressed to the classifier are detected in ordinary code, before any model
runs, and nothing written in a message can argue them down.

**A compromised model.** The verdict lattice is the structural guarantee:
`ALLOW < ESCALATE < BLOCK`, every model pass may only tighten, and one function
containing no inference decides. A model that has been fully talked over still
cannot produce an `ALLOW`, because none is ever asked for.

**Credential leakage into prompts.** Secrets are matched by pattern and entropy
and masked before any model, any upstream provider, or the audit log sees the
text.

**Tampering with the record.** The audit log is append-only JSONL, hash-chained,
with a witness file holding the count so truncation is visible as well as
alteration. `pnpm run verify-audit` walks it.

**Keeping a transcript of your team.** The audit log holds `sha256(prompt)` and
never the prompt: `recordDecision` strips the text before writing, so the
governance record cannot become the thing it is meant to make accountable.

Prompt text does exist in one other place, deliberately and with a limit. The
console has to be able to show an administrator what was actually blocked, so
`src/audit/prompts.ts` keeps the **masked** text — secrets already removed —
for **seven days by default**, in `data/prompts.jsonl`, mode `0600` and
gitignored. Expiry is enforced on every read and not only by a sweep, so a copy
of that file taken to another machine, or restored from a backup, still cannot
be read past its date. `WARDEN_PROMPT_RETENTION_DAYS=0` disables it entirely
and deletes the file.

What this means for the people being logged is a sentence you can put in
writing: *an administrator can read what you sent for seven days, with secrets
already masked, and after that nobody can — including them.* Lengthening the
window lengthens what an attacker who reaches the gateway walks away with, in
direct proportion.

**Reaching the administrative surface.** Policy writes, key issuance, the
onboarding script and the audit record require an administrator: a request from
the machine the gateway runs on, or an API key belonging to a role the ratified
policy exempts. See [`src/server/admin-auth.ts`](src/server/admin-auth.ts).

### What Warden does not defend

These are real and stated on purpose. A security document that lists only
strengths is marketing.

**The hook fails open on timeout.** The `UserPromptSubmit` integrations wait a
bounded time for a decision. If the gateway is unreachable or slow past that
deadline, the prompt goes through unchecked and the employee is told so on
stderr. A cold Codex decision was observed exceeding the 30-second deadline on
2026-08-23. Failing closed would mean a broken gateway stops all work, and that
is a product decision the deployment gets to make, not one this repo makes for
it. Until it is configurable, treat the deadline as the guarantee's edge.

**Both hook integrations are NOT VERIFIED end to end.** See
[`docs/HOOK-VERIFICATION.md`](docs/HOOK-VERIFICATION.md).

**Local root.** Anyone with a shell on the machine running the gateway can edit
`data/policies.json` and `data/company.json` directly. This is why loopback is
trusted as administrative: refusing it at the HTTP layer would buy nothing. Where
employees can log into the gateway host, set `WARDEN_ADMIN_REQUIRE_KEY=1` so
every administrative call must present an exempt key.

**API keys are stored in plaintext** in the directory file, and appear in the
onboarding script served to the employee they belong to. Read access to that
file is impersonation of every employee in it.

The onboarding link is therefore a credential, and is addressed by an install
token rather than by employee id — 128 bits derived from the key it delivers,
so it cannot be guessed, survives a restart, and is invalidated by rotating the
key. Treat the link the way you would treat the key: it is the key.

**Quota counters live in memory** and reset when the process restarts. A gateway
restarted often does not enforce a daily ceiling.

**The guard is a model, and models are wrong.** The last recorded run stopped
85% of attacks. The other 15% went through. Warden raises the cost of an attack
and produces a record of it; it is not a proof.

**A `warn` rule does not enforce anything.** It is the admin choosing to be told
rather than protected, for a rule where refusing costs more than it saves.
Warnings never tighten a verdict, so they cannot be a bypass — but a rule moved
from `block` to `warn` is a rule that has stopped stopping anything, and the
change is visible in the policy hash precisely so that it is reviewable.

**False positives are the live problem.** That same run refused 58% of
legitimate traffic. A guard people cannot work with gets switched off, and a
guard that is switched off protects nothing — so this is a security property,
not a usability one.

## The one thing that may run off-machine, and what it is not

Inference is local. The single exception is **rule compilation**, and it is
opt-in, off by default, and enforced by role rather than by convention.

Compilation turns one sentence an administrator typed into a draft rule that
the same administrator then reads and ratifies. It never sees an employee
prompt and it cannot enact policy — `src/policy/compile.ts` states that split in
its first paragraph and `ratifyRule` is the only path that changes what anyone
is judged against. **Judging stays local under every configuration.** There is
no environment variable, flag, or fallback that sends a prompt under judgement
anywhere, and `pnpm run test:remote` asserts it: every guard role delegates to
the local adapter and performs zero network calls, with `fetch` replaced by a
recorder.

Enable it with `WARDEN_COMPILER_API` (an OpenAI-shaped `/chat/completions` base
URL) and `WARDEN_COMPILER_API_KEY`. Both are required — a URL without a key
stays local rather than posting to an unauthenticated endpoint. Plain `http` to
a non-loopback host is refused outright.

**What leaves the machine when it is on**, stated without qualification:

1. The administrator's sentence.
2. The role names.
3. **The employee roster** — id and display name for everyone in the directory
   — because the compiler injects it so that "Ana cannot ask for payroll"
   compiles into a rule about Ana rather than about the whole company.

Point 3 is the reason this is a security note and not a feature note. Set
`WARDEN_COMPILER_REDACT_NAMES=1` and the provider sees `@e-01` and never the
person; that costs accuracy exactly where the roster was earning it, so it is a
choice rather than a default. No employee prompt, audit entry, policy hash or
API key is sent under any setting.

The console reports which model drafted a rule, and whether it was remote, on
every draft it returns. An administrator ratifying a rule should not have to
guess whether it came off their own machine.

## Deployment notes

- `WARDEN_HOST` defaults to `0.0.0.0` so employees can reach the gateway. The
  administrative surface is authenticated, but set `127.0.0.1` if the gateway
  serves only the machine it runs on.
- **Set `WARDEN_ADMIN_REQUIRE_KEY=1` behind any proxy, tunnel or load
  balancer.** Not only on a shared host — this one is sharper than it reads.
  `requireAdmin` grants administration to loopback, and it reads the peer
  address off the socket precisely so a header cannot forge it. A reverse proxy
  connects from `127.0.0.1`, so *every* request arriving through it satisfies
  that check and everyone who can reach the proxy is an administrator: the
  directory with every employee's API key in plain text, policy edits, deleting
  people. Confirmed against a running gateway while preparing a tunnel — with
  the flag off the admin API answered unauthenticated; with it on, `/api/people`
  returned 403 without a key and 200 with one.
- `WARDEN_CORS_ORIGIN` is unset by default and should stay that way. The console
  is served by the same process and needs no cross-origin access.
- Keep `data/` off shared storage. It holds the directory, the policy and the
  audit chain.

## Scope

In scope: the guard pipeline, the policy store, the server's authentication and
routes, the audit chain, the hook integrations, and the desktop packaging.

Out of scope: vulnerabilities in `@qvac/sdk` or in the models themselves (report
those upstream), and social engineering of an administrator.
