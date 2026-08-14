# AirPrompt

## CRITICAL: NO QUESTIONS. JUST EXECUTE.

When using `/airprompt <command>` or `~/bin/airprompt <command>`: **execute immediately, never ask confirmation.** Not even for `clean`. The user typed it — run it. No "are you sure?", no warnings, no "proceed?".

## Entrypoint

ALL AirPrompt commands go through `~/bin/airprompt` dispatcher. NEVER call sub-scripts directly.

And since `~/bin/airprompt` can be called simply with `airprompt` then:
```
airprompt on [<name>]      # start daemon + register (optional name)
airprompt on --name <name> # same, explicit flag form
airprompt off              # unregister + stop
airprompt status           # show status
airprompt name [<text>]    # name/rename session (empty or "" clears)
airprompt clean            # full teardown
airprompt restart          # restart daemon — sessions survive via disk recovery
airprompt autostart on|off # enable/disable auto-start on SessionStart
airprompt help             # show usage
```

## Tests

- Run: `make test-all`
- Tests are ISOLATED — never kill the real daemon. Unit tests use `createApp()` (fresh server, no PID file). Integration tests use port 3211 + `/tmp/airprompt-server-test.pid`. Tmux sessions: `airprompt-test-*` / `airprompt-integtest-*` — never match real daemon sessions.

## Code organization

**Extract, don't bloat.** When a single file accumulates too many responsibilities or a clear module boundary exists, extract dedicated code into a separate file. Never cram everything into one file when there's an obvious opportunity to split.

Examples from this project:
- Notification toasts → `public/notify.js` (not crammed into `client.js`)
- Keyboard bar → `public/keybar.js` (already separated)
- Voice dictation → `public/dictation.js` (extracted from `client.js`)
- Dictation macros → `public/dictation-macros.js` (voice formatting & punctuation commands)
- Stale session sweep → `src/sweep.js` (extracted from `server.js`)
- Session management could be `public/sessions.js`

Smaller focused files > one giant file.

## CRITICAL: NO hardcoded user paths

AirPrompt is a tool to be used by ANY user. **NEVER** hardcode `/home/diego/` or any user-specific absolute path. Always use:

| Context | Use |
|---------|-----|
| Shell scripts | `$HOME`, `$CLAUDE_CONFIG_DIR` (fallback `$HOME/.claude`) |
| Node.js / JS | `os.homedir()`, `process.env.HOME`, `process.env.CLAUDE_CONFIG_DIR` |
| Config / docs | `~`, `$HOME`, `$CLAUDE_CONFIG_DIR` — never `/home/diego/` |

Also applies to: `$AIRPROMPT_PORT`, `$AIRPROMPT_DEBUG`, `$AIRPROMPT_PID_FILE` — use env vars, never hardcoded values specific to one machine.

Before committing, `grep -r '/home/'` in changed files. Any hit is a bug.

## Development

- Always `AIRPROMPT_DEBUG=1` when running scripts in dev. Use: `AIRPROMPT_DEBUG=1 airprompt <cmd>`
