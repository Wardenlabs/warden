<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/warden-lockup-dark.svg">
    <img src="brand/warden-lockup-light.svg" alt="Warden" width="220">
  </picture>
</p>

# Warden

Warden checks AI requests against rules you write. It runs policy analysis on
its host using QVAC; it can block a request, hold it for review, or let it pass.
The desktop app includes the gateway and its admin console.

[Website](https://warden-theta.vercel.app) ·
[How it works](https://warden-theta.vercel.app/how-it-works) ·
[Documentation](https://warden-theta.vercel.app/docs)

[Download the desktop app](https://github.com/Wardenlabs/warden/releases/latest)
for macOS or Windows. Open Rules, describe a restriction, review the draft, and
activate it. Connect your tools under This device.

## Run from source

Use Node 22.17 or newer and the pnpm version pinned in `package.json`. CI uses
Node 22. See [CONTRIBUTING.md](CONTRIBUTING.md) for desktop build requirements.

```sh
git clone https://github.com/Wardenlabs/warden
cd warden
pnpm install
pnpm run setup
pnpm run dev
```

Open `http://localhost:8080`. Setup downloads the local models; Models in the
console configures the rule writer. New installations offer Claude Code, which
requires its own installation and sign-in.

To explore without downloading models:

```sh
WARDEN_ADAPTER=mock pnpm run dev
```

Mock mode does not provide policy protection. For a walkthrough with expected
results, see [TRY-IT.md](docs/TRY-IT.md).

## What gets checked

Claude Code, Codex and opencode integrations use prompt hooks. Tools that accept
an OpenAI-compatible base URL can use the gateway proxy. Coverage depends on
what each host sends to Warden, particularly for attachments; the
[integration guide](integrations/README.md) and
[verification record](docs/HOOK-VERIFICATION.md) describe those limits.

The proxy accepts supported documents as bytes and extracts their contents
locally. Incomplete extraction holds the request. It forwards allowed content
only after inspection and masking. See [document handling](docs/DOCUMENTS.md).

Rule writing and request checking use separate models. An administrator may
choose a remote provider or signed-in CLI to draft rules. That provider can
receive the rule instruction and directory context. Employee policy analysis
stays on the gateway. Details: [compiler setup](docs/COMPILER-SETUP.md) and
[model management](docs/MODEL-MANAGEMENT.md).

## Working in the console

Rules opens into the composer; View rules opens the current policy. Activity
shows recorded decisions. Inbox records review answers, and Team manages people
and roles. Record panels stay beside the lists that opened them.

This device shows tool connections, device rules and identity. Gateway shows
request deadlines, access and retention. Models controls the rule writer,
request judge and their prompt templates.

## Security and limits

Warden can miss attacks and refuse legitimate requests. Read the
[measurements](docs/MEASUREMENTS.md) before choosing a model or interpreting an
accuracy claim. Passing the regression suite does not establish model accuracy.

- Hooks fail open when the gateway cannot answer unless they have learned
  `WARDEN_FAIL_CLOSED=1`. The host application's deadline also applies.
- The gateway trusts direct local administration. Other callers need a key for
  an exempt role. On a shared host, set `WARDEN_ADMIN_REQUIRE_KEY=1`.
- API keys remain plaintext in the private directory file. An installation link
  carries a credential; rotating the person's key invalidates that link.
- The audit chain stores prompt hashes. A separate store keeps masked prompt
  text for seven days by default; `WARDEN_PROMPT_RETENTION_DAYS=0` disables it.

Read [SECURITY.md](SECURITY.md) for deployment requirements, trust boundaries and
reporting. The [console and security review](docs/SECURITY-REVIEW-2026-09-17.md)
records the scope and remaining findings of the latest code review.

## Development

```sh
pnpm run typecheck
pnpm test
pnpm run build
pnpm run app:dev
pnpm run app:make
```

Tests use temporary state and mock inference. Desktop CI builds installers and
starts the packaged app. Real model evaluation uses `pnpm run redteam` and the
paired `pnpm run bench` harness. `pnpm run verify-audit` checks the audit chain.

| Code | Responsibility |
| --- | --- |
| `src/guard/` | Inspection passes and deterministic verdict aggregation |
| `src/documents/` | Validation, local extraction and OCR |
| `src/server/` | HTTP routes, authentication and request limits |
| `src/policy/` | Rule compilation, ratification and directory |
| `src/qvac/` | Inference adapters and compiler offloading |
| `web/js/` | Console views and shared components |
| `web/styles/` | Design tokens, controls, screens and responsive rules |
| `desktop/` | Electron shell and gateway lifecycle |

A model pass may tighten a verdict, never loosen it. Errors and unreadable
model output escalate. Keep this invariant when changing the pipeline.
[CLAUDE.md](CLAUDE.md) documents contributor conventions and previous experiments.

## Website

The public website lives in `landing/` and deploys separately from the desktop
app. It runs without models. See [website development](landing/README.md) for
the local server, metadata generator, share images and production checks.

```sh
pnpm run landing:metadata
pnpm run landing:check
pnpm run landing:build
```

[Production verification](docs/WEBSITE-PRODUCTION.md) records what the checks
cover and the dependency advisories that still require local patches.

Apache-2.0. Bundled dependencies and model licenses appear in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
