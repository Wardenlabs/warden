# Kool download events

The landing records an installer download request in the Warden connection, after its server confirms that the selected GitHub installer is available. The event does not establish that the file finished downloading, that Warden was installed or opened, or that each request represents a different person.

| Field | Value |
| --- | --- |
| Connection | Warden · `cmtw01b6w0001jr04yf76gadx` |
| Event key | `warden_download_started` |
| Catalog name | Descarga iniciada de Warden |
| Source | `BROWSER`, validated and delivered by the server |
| Condition | A visitor activates an exact macOS or Windows installer link, and the server validates the request and confirms an available installer before redirecting to GitHub. |

**Status on September 10, 2026:** the event is registered as `ENABLED`, confirmed through the paired Kool CLI, and a real browser interaction has produced a confirmed test delivery. The integration has not been deployed. Production configuration and deployment remain pending before the live application can send campaign events.

## How a download is measured

[`landing/kool-download.js`](../landing/kool-download.js) enhances trusted activations of the existing macOS Apple Silicon and Windows installer links. It submits a native same-origin form to `POST /api/download`, preserving normal and new-tab navigation. Opening GitHub Releases for Linux or other builds does not emit this event.

[`api/download.mjs`](../api/download.mjs) delegates to [`integrations/kool/download-handler.mjs`](../integrations/kool/download-handler.mjs). The handler validates the origin, content type, bounded request body, platform, UUID and optional attribution reference. It checks the fixed installer URL and each allowed redirect with `HEAD`, then sends the event through the official server SDK and returns a `303` redirect to the installer. A missing token, failed installer availability check or unconfirmed Kool delivery still redirects a valid request to the original installer URL. Malformed requests are rejected without an event.

The browser assigns a fresh opaque UUID to each download request. That UUID and its attribution reference are frozen for server retries; a retry keeps the same event ID. This deduplicates delivery retries, not separate download requests by the same visitor. Availability and delivery have bounded deadlines, and the handler makes at most one delivery retry.

The existing PostHog integration remains unchanged. Its capture-phase listener sees the original installer anchor, while Kool handles its own submission separately. PostHog clicks, this validated download-request event and GitHub's aggregate asset-download counters measure different things; see [launch measurement](../landing/ANALYTICS.md).

## Attribution and event data

The official `@joinkool/sdk/browser` helper captures the last valid `kool_cid` when the page loads and retains it for up to 90 days. The download reads the saved reference without renewing its age and associates it with that request. Only the opaque click reference and its timestamp are stored; the full link and other query parameters are not stored by this helper. Kool validates attribution against its own connection and campaign records.

If browser storage is blocked, the helper retains the reference for the current page only. An absent or expired reference is omitted from the event. Do Not Track disables the Kool enhancement and attribution capture. Without JavaScript, when the module cannot initialize or when an interaction is not eligible for enhancement, the original GitHub anchor remains usable.

The event payload contains only `event`, `eventId`, optional `clickId` and the server-selected `test` flag. Platform is used to choose and validate the installer but is not forwarded as a free-form property. No names, email addresses, phone numbers, addresses, profiles, form contents or user identity are included. Server diagnostics contain delivery and operation IDs and bounded status fields, without the attribution reference or raw request body.

## Local setup

Use Node 22.17 or later and run these commands from the repository root:

```bash
npm ci --prefix integrations/kool --ignore-scripts --no-audit --no-fund
node scripts/build-kool-browser.mjs
```

The SDK is installed in its own [`integrations/kool/package.json`](../integrations/kool/package.json), with its download pinned by the lockfile. This keeps affiliate telemetry dependencies out of the desktop application's dependency graph. The build copies only the official browser helper into `landing/vendor/kool/browser.mjs`; the server SDK and private configuration are not copied into the public output.

The application needs one private Kool variable: `KOOL_INGEST_TOKEN`. If the local environment file does not already exist, use the paired CLI path recorded in `.kool/mcp.json` to export it without displaying its contents:

```bash
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const config = JSON.parse(readFileSync('.kool/mcp.json', 'utf8'));
const result = spawnSync(config.command, [config.args[0], 'env', '--project', '.',
  '--output', '.env.kool.local'], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
NODE
```

The CLI reads this project's connection configuration and writes the private environment file with `0600` permissions. The file is excluded from Git and Vercel uploads. Do not copy its contents into browser code or command arguments.

Start the landing and its download endpoint together:

```bash
node --env-file=.env.kool.local scripts/serve-kool-landing.mjs
```

Open `http://127.0.0.1:4174/`. This server forces `VERCEL_ENV=development` for the handler, even if the shell carries a production value. For a visual preview, the same server can run without `--env-file`. When no token is present, valid download requests still redirect to GitHub without sending an event. A plain static-file server does not implement `/api/download` and cannot verify the enhanced download flow.

The backend sets `test: true` whenever `VERCEL_ENV` is not exactly `production`. Vercel previews and local runs therefore remain tests; the browser cannot select the mode. No extra Kool URL, connection or test-mode environment variable is required.

## Verification evidence

On September 10, 2026, opening the local application left the catalog's `lastTestAt` at `null`. A trusted click on the macOS hero download link then exercised the application's native form and server handler. Kool inspection confirmed:

| Evidence | Value |
| --- | --- |
| Delivery status | `TEST` |
| Delivery ID | `cmtw35mcp0005l504uj6rlhsy` |
| Event ID | `263ac208-3a8b-46db-835b-66402745d1d0` |
| `lastTestAt` | `2026-09-10T22:15:16.511Z` |

This was an application interaction, not the CLI's synthetic transport test. No real attributed campaign link was available for this verification, so live campaign attribution was not exercised. Attribution capture, expiry, blocked storage and propagation are covered by isolated fixtures.

The 58 focused Kool browser/server, PostHog and release-reporter tests passed. Run them with:

```bash
node --test scripts/kool-download.test.mjs scripts/kool-browser.test.mjs scripts/landing-analytics.test.mjs scripts/release-downloads.test.mjs
```

## Before a live campaign

The production check on September 11 found that `/api/download` returned 404 and the live HTML did not load `kool-entry.js`. Setting a token cannot instrument a deployment that lacks this code. Deploy the function and browser module together. On a valid download request, the redirect includes `X-Warden-Kool-Mode` (`test` or `production`) and a bounded `X-Warden-Kool-Status`: `test`, `attributed`, `unattributed`, `unconfigured`, `installer-unavailable`, `unconfirmed`, or `rejected-<HTTP status>`. These headers contain no credentials, attribution IDs or request body. An invalid request or ordinary GET never sends an event.

1. Configure `KOOL_INGEST_TOKEN` as a private variable for the intended Vercel deployment environments. The source tree and static output contain no runtime token.
2. Deploy the landing and `/api/download` together using [`vercel.json`](../vercel.json). Its install command installs the isolated SDK package; its build command copies the public browser helper. A production deployment selects real events through Vercel's existing `VERCEL_ENV` value.
3. In Kool's Warden connection, **Descarga iniciada de Warden** is enabled and available to select when preparing the campaign link. Configure the campaign's terms in Kool; event enablement does not publish a campaign automatically.

Campaign selection, a published link and a production deployment are separate steps. This local test did not publish a campaign or establish a completed installer download.
