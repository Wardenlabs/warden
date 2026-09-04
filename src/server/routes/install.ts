/**
 * Employee install: three manual steps become one command. Every value an
 * employee retypes is a value they can get wrong, and an API key is the least
 * forgiving of them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Router } from 'express';
import { findByInstallToken, findEmployee, type Employee } from '../../policy/people.js';
import { ASSETS } from '../config.js';
import { gatewayUrl } from '../http.js';

export const installRoutes = Router();

/**
 * The hook, served by the gateway itself.
 *
 * Until now the onboarding pack told employees to curl it from GitHub, which
 * quietly made a public-internet round trip a prerequisite for a product whose
 * entire claim is that nothing leaves the network. On conference wifi behind a
 * captive portal, or in a demo with egress blocked, that step is where the
 * setup dies. The gateway already has the file.
 */
installRoutes.get('/warden-hook.mjs', (_req, res) => {
  try {
    res.type('application/javascript').send(readFileSync(join(ASSETS, 'integrations', 'warden-hook.mjs'), 'utf8'));
  } catch {
    res.status(404).json({ error: 'hook file not found next to the server' });
  }
});

/**
 * The OpenCode plugin, served like the hook is.
 *
 * `warden-hook --fix` fetches this rather than carrying a copy of it: two
 * sources of the same file disagree within a release, which is the reason the
 * install script curls the hook instead of vendoring it too.
 */
installRoutes.get('/integrations/opencode/warden.js', (_req, res) => {
  try {
    res.type('application/javascript').send(
      readFileSync(join(ASSETS, 'integrations', 'opencode', 'warden.js'), 'utf8')
    );
  } catch {
    res.status(404).type('text/plain').send('// not bundled in this build\n');
  }
});

installRoutes.get('/install/:credential', (req, res) => {
  const id = String(req.params['credential']);
  // Resolved against the directory rather than echoed back. A made-up id must
  // not produce a script that configures somebody the gateway has never heard
  // of — that account would be judged as a stranger, which is the exact failure
  // this route exists to prevent. The id is also never interpolated unless it
  // matches the shape `uniqueId` generates: this response is piped into `sh`,
  // so anything echoed back verbatim is one URL-encoded newline away from
  // being executed on an employee's laptop.
  // Token first: that is the form employees are given, and the only form that
  // reaches here without an administrator behind it. The id form still works
  // for the admin's own console and the quickstart, and `needsAdmin` is what
  // keeps it to them.
  const person =
    findByInstallToken(id) ?? (/^[a-z0-9][a-z0-9-]*$/.test(id) ? findEmployee(id) : null);
  if (!person) {
    return res
      .status(404)
      .type('text/plain')
      .send('# No such employee in the directory. Ask your admin for the right link.\nexit 1\n');
  }

  res.type('text/plain').send(buildInstallScript(person, gatewayUrl(req)));
});

/**
 * The install script as a string, shared with `/api/solo/protect` so that
 * route runs the exact same thing in-process instead of reimplementing it —
 * see docs/specs/solo-mode.md §6. Nothing about the script changes depending
 * on who calls this; only how the result reaches a shell does.
 */
export function buildInstallScript(person: Employee, url: string): string {
  // The key is the identity, so it has to be here. That makes this URL a
  // credential: it is only ever shown to the admin, inside the console, for a
  // person who already exists. The alternative — the employee pasting a key by
  // hand — is the step that gets mistyped.
  //
  // The name appears in a script comment and an echo, and this whole response
  // is piped into `sh`. It is admin-authored, but "admin-authored" reaches here
  // through an API, so anything that could close the comment or open a command
  // substitution is stripped rather than trusted.
  const safeName = person.name.replace(/[^\p{L}\p{N} .,()-]/gu, '');
  return `#!/bin/sh
# Warden setup for ${safeName} (${person.role})
set -e

HOOK="$HOME/.warden-hook.mjs"
echo "Downloading the Warden hook…"
curl -fsSL "${url}/warden-hook.mjs" -o "$HOOK"
chmod +x "$HOOK"

PROFILE="$HOME/.zshrc"
[ -n "$BASH_VERSION" ] && PROFILE="$HOME/.bashrc"
[ -f "$PROFILE" ] || PROFILE="$HOME/.profile"

# Idempotent: re-running after a role change or a new gateway address replaces
# the old block instead of stacking a second, contradictory one.
if grep -q "# >>> warden >>>" "$PROFILE" 2>/dev/null; then
  echo "Updating the existing Warden block in $PROFILE"
  sed -i.warden-bak '/# >>> warden >>>/,/# <<< warden <<</d' "$PROFILE"
fi

cat >> "$PROFILE" <<'WARDEN_BLOCK'
# >>> warden >>>
export WARDEN_URL=${url}
export WARDEN_API_KEY=${person.apiKey}
# <<< warden <<<
WARDEN_BLOCK

echo ""
echo "Done. Hook at $HOOK, environment in $PROFILE."
echo "Open a new terminal (or: source $PROFILE)."

# What is on this machine, and then wiring it. --fix adds the hook to the tools
# it finds, backs up every file it touches to <file>.warden-bak first, leaves
# anything already wired alone, and prints each thing it did — so the install
# ends on an inventory that says "governed" instead of on a sentence telling
# them to go and configure three programs by hand.
#
# \`|| true\` covers a machine with no node, which would be a strange place to
# be installing a node hook but is not a reason for the install to end red.
node "$HOOK" --fix || true

echo "Anything it could not wire: ${url}  ->  People  ->  ${safeName}  ->  Onboarding"
`;
}
