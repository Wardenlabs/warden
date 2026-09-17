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
/**
 * Which tools a wiring run touches.
 *
 * Absent means all of them, which is what an install has always done and what
 * the onboarding link still does: somebody setting up a machine for the first
 * time wants every tool on it governed. One tool is the console's case — a row
 * in "This device" with its own Connect button — and there the button has to
 * mean what it says. `--only` is refused by the hook for an id it does not
 * know rather than widened to everything, so a typo here wires nothing.
 */
function onlyFlag(tool?: string): string {
  // The id reaches the hook inside a shell command. It is chosen from a fixed
  // list by the console, but "chosen from a list" arrives here through an API,
  // so anything that is not a plain tool id is dropped rather than quoted.
  const safe = (tool ?? '').replace(/[^a-z0-9-]/g, '');
  return safe ? ` --only ${safe}` : '';
}

export function buildInstallScript(person: Employee, url: string, tool?: string): string {
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

# The source of truth, written before anything that copies from it.
#
# The profile block below and the \`env\` block --fix writes into Claude Code's
# settings both still exist — a Claude Code opened from the Dock never sourced
# a profile, and its env block is static JSON that cannot point at a file — but
# since this file exists they are copies rather than three separate opinions,
# and \`--status\` says which one has drifted. See docs/specs/wiring-and-unwiring.md §7.
#
# umask before the write, not chmod after: a chmod leaves an instant where the
# file exists and anybody on the machine can read the key out of it.
mkdir -p "$HOME/.warden"
chmod 700 "$HOME/.warden" 2>/dev/null || true
(
  umask 077
  cat > "$HOME/.warden/credentials.json" <<'WARDEN_CREDENTIALS'
{
  "url": "${url}",
  "apiKey": "${person.apiKey}"
}
WARDEN_CREDENTIALS
)

# $BASH_VERSION is not "the shell chose bash": on macOS /bin/sh is bash
# under the hood, so it is set here even though this ran as sh, and every
# install used to land in ~/.bashrc — a file zsh (the default shell since
# Catalina) never sources, so the export was invisible to the very terminal
# it was written for. $SHELL is the login shell the OS actually launches,
# which is what a person's next terminal will be.
case "$SHELL" in
  */zsh) PROFILE="$HOME/.zshrc" ;;
  */bash) PROFILE="$HOME/.bashrc"; [ -f "$PROFILE" ] || PROFILE="$HOME/.bash_profile" ;;
  *) PROFILE="$HOME/.profile" ;;
esac

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
echo "Done. Hook at $HOOK, key at $HOME/.warden/credentials.json, environment in $PROFILE."
echo "Open a new terminal (or: source $PROFILE)."

# What is on this machine, and then wiring it. --fix adds the hook to the tools
# it finds, backs up every file it touches to <file>.warden-bak first, leaves
# anything already wired alone, and prints each thing it did — so the install
# ends on an inventory that says "governed" instead of on a sentence telling
# them to go and configure three programs by hand.
#
# This has to find node itself rather than trust PATH. Run from a terminal,
# \`node\` resolves through the profile's own PATH — but the desktop app runs
# this same script from a spawned /bin/sh that inherits launchd's minimal
# PATH, not the shell's, so a node installed via Homebrew or nvm is invisible
# to it even though every terminal on the machine can see it. That failure was
# silent before this comment existed: \`node\` exited "command not found",
# \`--fix\` never ran, and \`|| true\` swallowed it — the install reported
# success while Claude Code stayed unwired. Checked in order: PATH first (so a
# terminal-launched install costs nothing extra), then the install locations
# that actually exist on this machine (\`which node\` above resolved to
# /opt/homebrew/bin/node here).
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/local/opt/node/bin/node "$HOME/.volta/bin/node" "$HOME/.local/bin/node" "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
  done
fi

# The two values just written to the profile go to --fix on its own line,
# because this shell never sourced that profile and --fix copies them into
# Claude Code's settings.json \`env\` block too: a Claude Code opened from the
# desktop app never sourced the profile either, and without them its hook
# fails open.
if [ -n "$NODE_BIN" ]; then
  WARDEN_URL="${url}" WARDEN_API_KEY="${person.apiKey}" "$NODE_BIN" "$HOOK" --fix${onlyFlag(tool)} || true
else
  echo ""
  echo "Could not find Node on this machine, so Claude Code / Codex were not wired automatically."
  echo "Install Node, then run this once:"
  echo "  WARDEN_URL=${url} WARDEN_API_KEY=${person.apiKey} node \"$HOOK\" --fix${onlyFlag(tool)}"
fi

echo "Anything it could not wire: ${url}  ->  People  ->  ${safeName}  ->  Onboarding"
`;
}

/**
 * Take one tool's hook back out. The counterpart of the `--fix` line above,
 * and deliberately much smaller.
 *
 * Nothing is downloaded, no credentials are written and no profile is touched:
 * unwiring a tool is not a reason to forget the key, and somebody who presses
 * Unwire on one row usually presses Connect on another a minute later. The
 * hook has to already be on disk, which it is — it could not have been wired
 * without it — and if it is not, there is nothing to unwire and saying so is
 * the right answer.
 *
 * This only ever runs against the machine the gateway is on. A hook in an
 * employee's home directory on their own laptop is not ours to remove, and the
 * console does not offer it there; see docs/specs/first-run-and-theme.md §7.3.
 */
export function buildUnwireScript(url: string, apiKey: string, tool: string): string {
  return `#!/bin/sh
set -e

HOOK="$HOME/.warden-hook.mjs"
if [ ! -f "$HOOK" ]; then
  echo "No Warden hook on this machine, so there is nothing to unwire."
  exit 0
fi

# Same lookup as the install script, and for the same reason: run from the
# desktop app this shell inherits launchd's PATH, where a Homebrew or nvm node
# is invisible.
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/local/opt/node/bin/node "$HOME/.volta/bin/node" "$HOME/.local/bin/node" "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$candidate" ]; then NODE_BIN="$candidate"; break; fi
  done
fi

if [ -z "$NODE_BIN" ]; then
  echo "Could not find Node on this machine, so nothing was unwired."
  exit 1
fi

# The key goes on the line because --unfix reports the new wiring to the
# gateway when it finishes, and that report is what moves the row on screen.
WARDEN_URL="${url}" WARDEN_API_KEY="${apiKey}" "$NODE_BIN" "$HOOK" --unfix${onlyFlag(tool)}
`;
}
