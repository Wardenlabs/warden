# Open-source security follow-up — 2026-09-21

This review addresses the findings from the publication-readiness check. It is
a code review with regression evidence, not a certification of model accuracy
or a guarantee that a host application honors its hooks.

## Changes

- Hooks refuse unreachable gateways, invalid decisions and timeouts by default,
  including first contact and unreadable or legacy caches. Explicit unchecked
  operation requires `WARDEN_FAIL_CLOSED=0` and a versioned gateway response.
- The OpenCode plugin refuses if the hook is missing, crashes or exceeds its
  execution deadline. Onboarding installs the maintained plugin instead of
  generating a second implementation with an embedded credential.
- Gateway employee, compiler and model endpoint credentials are encrypted with
  AES-256-GCM. Valid legacy documents migrate on read; unknown keys or altered
  ciphertext fail without replacing the stored credentials. Files are replaced
  atomically with private permissions. Desktop keys use Electron's OS store when
  available; headless and keyring-less installs use a separate private key file.
- Hook credentials are encrypted with their own separate file-backed key.
  `--fix` removes the old plaintext key from Claude Code's active settings. New
  installers no longer export a key in a shell profile. Existing backup files,
  shell history and manually configured overrides require administrator cleanup.
- Historical sample credentials are revoked by fingerprint during directory
  loading, independently of current employee names and roles. Replacement keys
  are random and saved encrypted. Affected clients must reconnect.
- Prompt retention documentation now distinguishes application expiry from
  physical deletion and independently retained backups.
- Desktop build jobs receive read-only repository access; only the release job
  can publish. The new security workflow uses pinned actions, read-only access
  and checkout without persistent credentials.

## Git history

Gitleaks 8.30.1 scanned all locally available refs after fetching remote branches
and tags from a non-shallow clone. It inspected 423 commits with file changes
and approximately 15.14 MB. Its 129 findings were reviewed:

| Findings | Classification and disposition |
| --- | --- |
| 110 | Benchmark content hashes; `scripts/bench-adjudicator.ts` derives them from the rule and prompt with SHA-256. They do not authenticate anything. |
| 12 | Published sample credentials in historical versions of `data/seed/company.json`. All historical sample key fingerprints are revoked during directory migration. |
| 4 | Browser local-storage namespaces in the analytics bundle and its tests. |
| 2 | Synthetic credentials in console and document-redaction regression tests. |
| 1 | Intentionally public analytics ingestion token in the landing configuration. It is not an administrative API credential. |

`.gitleaksignore` contains only the reviewed commit/path/rule/line fingerprints.
It does not exclude entire paths, rules or commits. New occurrences fail the
security check. This is evidence about the fetched Git history, not deleted
remote refs, third-party forks or every secret format that could exist.

## Dependencies

The registry continues to report four high-severity advisories for transitive
packages. Warden's lockfile installs local mitigations rather than hiding those
version-based alerts:

| Advisory | Installed mitigation |
| --- | --- |
| [GHSA-jmr9-qjv8-65gv](https://github.com/advisories/GHSA-jmr9-qjv8-65gv) | `extract-zip@2.0.1`: reject symlinks escaping the extraction root. |
| [GHSA-7pqw-9j4j-h8q3](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3) | Same patch rejects final-path symlinks and uses `O_NOFOLLOW` where supported. |
| [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) | `image-size@0.7.5`, only under the DMG build tool: reject non-advancing ICNS entries without breaking its callback API. Runtime image-size is 2.0.4. |
| [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq) | The legacy 0.7.5 parser registry contains neither JXL nor HEIF; the advisory's broad version range still matches. |

`node scripts/security-audit.mjs` checks registry availability, advisory identity,
exact affected versions, the legacy parser's dependency path and patch hashes.
It runs actual malicious-archive and malformed-image regression cases against
the installed packages. New advisories fail; these temporary exceptions expire
on **2026-10-21**. Replace them with verified compatible upstream fixes when
available. The workflow runs on pushes, pull requests and weekly.

## Verification

The credential suite exercises plaintext migration, restart recovery, private
permissions, context binding, wrong/missing keys, modified ciphertext and
revocation after an employee was renamed. Hook tests exercise first-contact
outages, legacy and corrupt caches, explicit opt-outs, invalid responses,
timeouts and installation repair. The full regression runner isolates runtime
files and encryption keys in temporary directories.

Run `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm landing:check` and
`node scripts/security-audit.mjs`. Desktop CI additionally boots packaged apps
on Linux, macOS and Windows. A passing mock boot does not establish real-model
accuracy or end-to-end behavior inside third-party AI clients.

## Repository owner and existing-installation actions

1. **Enable private vulnerability reporting:** repository Settings → Security →
   Private vulnerability reporting. The available GitHub account can push but
   cannot administer this repository; the API reports the feature disabled.
   Verify the private report form works afterward.
2. **Enable repository protections:** require the security and regression checks
   for future changes, and enable GitHub secret scanning/push protection and
   Dependabot alerts where available. These settings need owner/admin access.
3. **Roll out the updated app and clients:** publish/install a desktop release
   containing these changes, then distribute the updated hook or rerun onboarding.
   Existing copied hooks do not update merely because `main` changed. Reconnect
   clients whose old sample key was revoked.
4. **Clean old copies and rotate keys:** remove obsolete exports from shell
   profiles, saved install scripts and configuration backups after confirming
   the updated connection works. A new encrypted active file does not erase
   plaintext from old copies. Rotate any credential shared outside its intended
   recipients. No live external provider key was identified in the reviewed
   findings; the scanner cannot prove none exists elsewhere.
5. **Protect recovery material:** keep credential-key backups separate from data
   backups; restrict Windows ACLs on file-backed keys. Do not delete the original
   key while its data is still in use. OS-wrapped keys may be machine/account-bound.
6. **Review dependency mitigations before 2026-10-21.** The security check fails
   after that date until upstream fixes or renewed evidence are reviewed.
