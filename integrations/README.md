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

## 1. Install the hook

One file, no dependencies, nothing else to install:

```bash
curl -o ~/.warden-hook.mjs \
  https://raw.githubusercontent.com/MartinPuli/operations-aleph/main/integrations/warden-hook.mjs
chmod +x ~/.warden-hook.mjs
```

Check it:

```bash
echo '{"user_input":"hello"}' | node ~/.warden-hook.mjs   # exit 0, silent
```

Employees never clone the repo or download a model — only the machine running
the gateway does. From inside the repo, `npm link` gives you the same thing as
`warden-hook` on your PATH.

## 2. Point it at the gateway

The hook talks to the machine running Warden. On that machine, `npm run dev`
prints the address to use:

```
Warden  (adapter=real)
  local     http://localhost:8080
  network   http://192.168.1.42:8080   <- teammates point here
```

Each employee sets these (in `~/.zshrc`, `~/.bashrc`, or their shell profile):

```bash
export WARDEN_URL=http://192.168.1.42:8080   # omit if Warden runs locally
export WARDEN_USER=fede
export WARDEN_ROLE=analyst                   # fallback only, see below
```

`WARDEN_USER` is the field that matters. The gateway looks it up in the
directory the admin manages in the console's People tab, and the role recorded
there decides which rules and which quota apply — including any rule written for
that person by name.

`WARDEN_ROLE` is only consulted for someone the directory has never seen. It is
deliberately not authoritative: a role an employee can edit in their own shell
profile is a role they could use to pick which rules judge them.

## 3. Claude Code

Merge `claude-code/settings.json` into `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node ~/.warden-hook.mjs" }] }
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
command = "node ~/.warden-hook.mjs"
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

---

## The console generates all of this per person

Everything below is the manual version. The admin console does it for you with
the employee's id, key and this gateway's address already substituted:

**People → pick a person → Onboarding.** Tabs per tool, a copy button on every
block, and one button that copies the whole setup as a message you can paste
into a chat.

That matters because every value an admin retypes is a value they can get wrong,
and the wrong ones fail silently — a mistyped `WARDEN_USER` does not error, it
just gets that person judged as a stranger under whatever role they claim.

## Which tools, and how each one is governed

| Tool | How | Subscription | Verified |
|---|---|---|---|
| Claude Code | `UserPromptSubmit` hook | ✅ | not yet |
| Codex | `UserPromptSubmit` hook | ✅ | not yet |
| OpenCode | `chat.message` plugin | ✅ | **no — see below** |
| Cursor | base URL + per-employee key | ❌ needs an API key | not yet |
| Aider, Continue, Open WebUI, scripts | `OPENAI_BASE_URL` + key | ❌ needs an API key | not yet |
| A terminal | the hook, run directly | ✅ | ✅ |

"Verified" means somebody watched that tool refuse a prompt because of Warden.
Only the last row has been. Everything else is wired from the tools' own
documentation and tested at the hook boundary, which is not the same thing —
[OPE-19](https://linear.app/operations-aleph/issue/OPE-19) is the card for
closing that gap.

**Hook or proxy** is the distinction that decides whether a tool can be governed
on a subscription at all. A hook runs on the employee's machine before the
prompt leaves it, so it does not care what the tool authenticates against. The
proxy path needs a settable base URL, which needs an API key — that is why the
hook exists, and why Cursor cannot be governed on a Cursor subscription.

## OpenCode

[`opencode/warden.js`](opencode/warden.js) → `~/.config/opencode/plugin/warden.js`

The plugin shells out to the same hook every other integration uses and throws
when it exits non-zero. Whether throwing from `chat.message` actually aborts the
message has **not been observed here**, and there are open upstream issues about
hooks not firing. If it silently does nothing, that is the failure to report.

## Anything else

The hook reads the prompt from whichever of these the payload carries:
`user_input`, `prompt`, `message`, `text`, `input`, or the last user turn of an
OpenAI-shaped `messages` array. A wrapper for a tool not listed here only has to
put JSON on stdin and check the exit code — `2` means refused, and the reason is
on stderr. Pass `source` to have the tool named in the console's connected
badges.
