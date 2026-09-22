# Security audit — 2026-09-21

## Executive summary

This review found no unmitigated critical or high-severity application
vulnerability. Warden already has strong controls around local credentials,
browser-to-loopback trust, Electron isolation, fail-closed hooks, document
parsing, model downloads, and audit integrity.

The review fixed the actionable release-pipeline and HTTP-baseline issues it
found. Two bounded code risks remain: the server-wide 30-minute request window
used for model uploads also applies to ordinary requests, and generic async
errors are still returned as user-facing text because the console depends on
many of those messages. GitHub's registry also continues to report two high
advisories in a transitive packaging dependency; Warden's pinned local patch
and exploit regression tests mitigate them until the time-bounded review on
2026-10-21.

Private vulnerability reporting is enabled. The repository still needs an
owner to enable a `main` ruleset so the new CODEOWNERS policy is enforced.

## Scope and method

The audit covered the TypeScript/JavaScript application, Express gateway,
Electron boundary, local model and document handling, browser landing pages,
GitHub Actions, dependency graph, credential storage, and recent Git ownership
history. It used the OpenAI `security-best-practices` and
`security-ownership-map` skills, the repository's existing security regression
suite, registry audit data, and manual review of trust boundaries.

The ownership analysis examined 432 non-merge commits, five contributor
identities, and 757 files over the repository history. It found no abandoned
sensitive area, but it did find single-maintainer ownership in credential
storage, dependency patches, untrusted document parsers, several download
paths, and parts of the server boundary.

## Findings

### SEC-01 — Mutable CI actions and broad signing-secret exposure

- **Severity:** Medium
- **Status:** Remediated
- **Evidence:** `.github/workflows/desktop.yml:74-78`,
  `.github/workflows/desktop.yml:161-188`,
  `.github/workflows/desktop.yml:211-272`, and
  `.github/workflows/landing.yml:18-21`
- **Impact:** A compromised mutable action tag could change the code executed
  by CI. The macOS signing secrets were also made available to every macOS
  build on `main`, even when the run was not publishing a release.
- **Fix:** Every action now uses an exact commit SHA, checkout credentials are
  not persisted, and signing/notarization secrets are populated only for a
  version tag or an explicit release dispatch.

### SEC-02 — Long request window applies to the whole gateway

- **Severity:** Medium when the gateway is network-accessible; Low on the
  default loopback-only desktop installation
- **Status:** Open
- **Evidence:** `src/server/index.ts:88-92`; ordinary JSON and document limits
  are set at `src/server/app.ts:59-67`
- **Precondition:** An attacker must be able to reach the gateway over the LAN
  or its configured public address.
- **Impact:** A client can hold ordinary request bodies open much longer than
  needed. Enough slow connections could consume sockets and reduce
  availability.
- **Recommended fix:** Give ordinary requests a short receive deadline and
  isolate the 30-minute allowance to
  `POST /api/settings/models/upload`, ideally behind a separate upload handler
  or listener. Keep the existing byte, disk, authorization, and transfer
  limits.

### SEC-03 — Generic async failures retain a broad public-message boundary

- **Severity:** Low
- **Status:** Partially remediated
- **Evidence:** `src/server/http.ts:39-66`
- **Impact:** A generic backend exception can be returned to a caller as an
  actionable UI message. Current credential paths redact secrets, but this
  convention could expose a filesystem path or provider detail if a future
  route forwards an unsafe exception.
- **Fix in this review:** Server logs no longer receive raw exception objects,
  stack traces, prompts, paths, or provider responses. They keep only the error
  class and public category.
- **Recommended fix:** Introduce a typed public HTTP error with status, code,
  and safe message. Return a generic 500 for every untyped exception, then
  migrate the existing intentional validation messages to that type.

### SEC-04 — Registry advisories in transitive packaging dependencies

- **Registry severity:** High
- **Residual status:** Mitigated and time-bounded
- **Evidence:** `pnpm-workspace.yaml:42-44`,
  `scripts/security-audit.mjs:8-45`,
  `patches/extract-zip@2.0.1.patch`, and
  `scripts/test-archive-security.mjs`
- **Impact:** Unpatched `extract-zip@2.0.1` allows archive symlink traversal and
  arbitrary writes. The full development graph also contains a legacy
  `image-size@0.7.5` under the DMG build tool.
- **Mitigation:** pnpm applies content-pinned local patches; CI verifies the
  patch digests, the exact affected versions and dependency paths, and real
  exploit fixtures. A new advisory or changed patch fails the security gate.
- **Next review:** Replace the patches with verified upstream releases, or
  revalidate and renew the exception, before **2026-10-21**.

### SEC-05 — Sensitive changes can still merge without owner review

- **Severity:** Medium operational risk
- **Status:** Repository policy prepared; GitHub configuration pending
- **Evidence:** `.github/CODEOWNERS:1-19`; the repository currently has no
  branch protection and no rulesets.
- **Impact:** The ownership analysis found bus-factor-one files across
  credentials, parsers, download validation, server trust, and dependency
  patches. A mistaken or compromised push to `main` does not currently require
  a second maintainer or passing checks.
- **Fix in this review:** CODEOWNERS now assigns MartinPuli and Gastonfoncea to
  the repository and explicitly covers the security and release boundaries.
- **Owner action:** Add an active ruleset for `main` requiring pull requests,
  one approval, code-owner review, dismissal of stale approvals, and the
  security/build checks. Restrict direct pushes and force pushes. The current
  GitHub credential has push access but no admin or maintain permission, so it
  cannot create this ruleset.

## Confirmed controls

- The desktop app encrypts persisted credentials, binds ciphertext to its
  context, restricts key permissions, rejects tampering, and tests migration
  and restart behavior.
- Browser administration rejects cross-site requests, null origins, origin
  port mismatches, and DNS-rebinding hostnames while preserving local CLI use.
- Electron uses context isolation, disables Node integration, enables the
  sandbox, blocks cross-origin navigation, and validates external URLs.
- Hooks fail closed during timeouts and malformed responses. Only a versioned,
  explicit administrator override can permit unchecked traffic.
- Document ingestion validates filenames, canonical base64, file counts and
  byte limits; extraction runs without network access and under cancellation,
  concurrency, and time budgets.
- Model download URLs require public HTTPS destinations, reject credentials and
  private addresses, validate redirects, constrain filenames, stream to
  server-owned paths, and verify GGUF structure.
- Express now disables its framework header, sends controlled JSON 404s, and
  has a generic final error boundary at `src/server/app.ts:28-117`.
- Private vulnerability reporting is enabled for `Wardenlabs/warden`.

## Verification

All checks completed on the reviewed tree:

- `pnpm test`: **29/29 regression suites passed**.
- Landing tests: **53/53 passed**.
- Console tests within the regression suite: **97/97 passed**.
- `pnpm run typecheck` and `pnpm run build`: passed.
- `node scripts/security-audit.mjs`: four reviewed local mitigations validated;
  no unreviewed advisory found.
- `pnpm audit --prod`: still reports the two documented `extract-zip` registry
  advisories; both are covered by the verified patch and exploit tests above.
- Workflow YAML parsing and immutable-action scan: passed.

This report is a point-in-time review of the current repository. It does not
replace review of future model runtimes, new parsers, external compiler
providers, deployment topology, or GitHub policy changes.
