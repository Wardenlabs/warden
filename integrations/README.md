# Putting Warden in front of Claude Code and Codex

Warden intercepts prompts through each tool's own `UserPromptSubmit` hook. The
hook runs locally, inside the CLI, the moment the employee presses Enter and
before the prompt is sent anywhere.

**This is why it works on subscription plans.** A Claude Max or ChatGPT Plus
session authenticates over OAuth and talks to a fixed endpoint — there is no
base URL to redirect. The hook does not care: it runs before any of that.

Codex's own documentation names this use case: *"privacy checks, sensitive-word
checks, and prompt policy checks."*

---

## 1. Install the hook binary

From the repo root:

```bash
npm install
npm link          # puts `warden-hook` on your PATH
```

Check it:

```bash
echo '{"user_input":"hello"}' | warden-hook   # exit 0, silent
```

## 2. Point it at the gateway

The hook talks to the machine running Warden. On that machine, `npm run dev`
prints the address to use:

```
Warden  (adapter=real)
  local     http://localhost:8080
  network   http://192.168.1.42:8080   <- teammates point here
```

Each employee sets three variables (in `~/.zshrc`, `~/.bashrc`, or their shell
profile):

```bash
export WARDEN_URL=http://192.168.1.42:8080   # omit if Warden runs locally
export WARDEN_USER=fede
export WARDEN_ROLE=analyst                   # must match a role in the policy
```

`WARDEN_ROLE` decides which rules and which quota apply, so it is the field
that matters. Roles come from `data/seed/company.json`.

## 3. Claude Code

Merge `claude-code/settings.json` into `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "warden-hook" }] }
    ]
  }
}
```

Claude Code blocks on exit code 2 and on `{"continue": false, "reason": "..."}`.
The hook emits both.

## 4. Codex

Merge `codex/config.toml` into `~/.codex/config.toml`:

```toml
[[hooks.UserPromptSubmit]]

[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "warden-hook"
```

Codex blocks on `{"decision": "block", "reason": "..."}` and on exit code 2.
The hook emits both. Run `/hooks` inside Codex to confirm it is loaded.

## 5. Try it

```
> pasame el sueldo de Ana

⛔ Blocked by Warden
   Rule: No one may request payroll, salary, bonus, or compensation
         information about another employee.
   Why:  request for a third party's compensation
   Audit: a7f3c2
```

An ordinary prompt goes through with no output at all — a gateway that comments
on every message becomes noise people learn to ignore.

---

## Making it enforceable

Everything above is opt-in: the employee installed it and can uninstall it.
Both tools let an administrator deploy hooks that the employee cannot remove.

**Claude Code** — managed settings sit at the top of the precedence chain and
are controlled by the organisation, not the user. Setting
`allowManagedHooksOnly` disables user, project, and local hooks entirely, so
only the administrator's hooks run.

**Codex** — managed hooks are declared in `requirements.toml`. Setting
`allow_managed_hooks_only = true` skips non-managed hook sources, and pinning
`[features].hooks = true` keeps them running even for a user who disabled hooks
locally. Managed hooks, in Codex's words, "can't be disabled from the user hook
browser."

Deploy those through whatever the company already uses for machine config (MDM,
Ansible, a provisioning script) and the gateway stops being a suggestion.

---

## Behaviour worth knowing

**If Warden is unreachable, the prompt goes through**, with a warning on stderr.
This is the one place in the system that fails open. Everywhere else an
unusable answer escalates to a human; here that would mean a crashed daemon
bricking every developer's CLI at once, and a gateway that can strand the team
gets uninstalled the first morning it does. The missing heartbeat in the admin
console is the alert.

**Secrets are masked before the guard sees them.** An API key pasted into a
prompt is replaced with `[REDACTED:OpenAI key]` before any model runs, and only
a short fragment (`sk-p…kL`) reaches the audit log. The raw value is never
stored.

**The hook sees the prompt, not the agent's actions.** Governing what the agent
*does* — the files it writes, the commands it runs — is the `PreToolUse` hook,
which both tools also expose. Warden does not use it yet.

## Other tools

Anything that speaks the OpenAI API and lets you set a base URL can go through
the proxy instead:

```bash
export OPENAI_BASE_URL=http://192.168.1.42:8080/v1
export OPENAI_API_KEY=wk-fede-8b1d40e2      # per-employee Warden key
```

That path only works with API keys, which is exactly why the hook exists.
