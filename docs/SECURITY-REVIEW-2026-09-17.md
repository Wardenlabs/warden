# Console and security review, 2026-09-17

This review covered the browser-to-admin boundary, Electron navigation,
compiler errors, production dependencies and archive extraction used by desktop
build tools. It also exercised the revised console with synthetic data. It did
not measure model accuracy or verify every host integration with real accounts.

## Findings and changes

| Finding | Evidence | Change |
| --- | --- | --- |
| Cross-origin requests inherited loopback administration | A simple POST carrying an unrelated Origin reached a protected test handler with HTTP 200 before the fix | Local trust now requires a local Host and an acceptable browser origin. Requests with a real admin key keep their existing authentication path. |
| DNS rebinding could reuse local trust | The socket check alone did not constrain the Host header | Arbitrary hostnames cannot gain passwordless local administration. Tests send raw Host headers over HTTP, since fetch rewrites them. |
| Electron opened arbitrary URL schemes through the OS | The window-open handler passed its URL directly to shell.openExternal | Only HTTP and HTTPS links without embedded credentials may open externally; cross-origin navigation cannot replace the console. |
| Compiler failures exposed stderr or a command line | The CLI adapter interpolated stderr or err.message into its public failure | It now returns bounded messages for timeout, sign-in and connection failure. A fake CLI test emits a private path and token and verifies neither appears in the error. |
| Dependency advisories | pnpm audit --prod reported 18 advisories: 1 critical, 12 high and 5 moderate | Updated image-size to 2.0.4 and pinned transitive tar 7.5.22 and qs 6.16.0. |
| ZIP symlinks could escape the destination or redirect file writes | extract-zip 2.0.1 checked parent directories but allowed unsafe symlink targets and final-component links | A pnpm patch checks targets and existing ancestors before extraction, refuses writes through a final symlink and uses O_NOFOLLOW when available. Real ZIP fixtures exercise escape attempts and valid internal links. |

The console also sends a Content Security Policy that permits local script
modules but blocks inline scripts, objects and framing. Styles retain inline
support because existing components use computed widths.

## Dependency status

The registry has no extract-zip release newer than 2.0.1 at the time of this
review. The audit therefore still reports its two high-severity advisories;
the lockfile applies the checked-in patch rather than suppressing those reports.
The other 16 advisories no longer appear in the production audit. Replace the
patch with a verified upstream release when one becomes available.

Sources: [image-size ICNS parsing](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr),
[tar path recursion](https://github.com/advisories/GHSA-r292-9mhp-454m),
[qs denial of service](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g), and
[extract-zip symlink writes](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3).
Registry metadata and installed-version tests determined the upgrades; advisory
pages can lag the registry's patched-version data.

## Verification

`pnpm test` includes the new browser-boundary and archive-security suites.
Existing suites cover authentication, document extraction, policy isolation,
compiler setup and console behavior. `pnpm run typecheck` and `pnpm run build`
check the server and desktop shell.

Browser checks use the actual security headers and cover the rule composer,
Activity/Inbox/Rules/Team drawers, field preservation, unsaved-edit confirmation,
explicit device rule actions, settings pages, dark mode and 390px windows.
They use synthetic data; they do not change an installed gateway's rules.

## Remaining boundaries

API keys remain plaintext in private files. Local users who can edit the data
files remain trusted; this change only stops unrelated browser origins from
borrowing that trust. Hooks retain the documented fail-open default and host
coverage limits. Archive extraction assumes other local processes cannot mutate
the destination concurrently; use a private build directory. This is a scoped
code review with regression tests, not a claim that the product has no defects.
