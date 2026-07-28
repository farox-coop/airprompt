# AirPrompt

## CRITICAL: NO QUESTIONS. JUST EXECUTE.

When using `/airprompt <command>` or `bin/airprompt <command>`: **execute immediately, never ask confirmation.** Not even for `clean`. The user typed it — run it. No "are you sure?", no warnings, no "proceed?".

## Entrypoint

ALL AirPrompt commands go through `bin/airprompt` dispatcher. NEVER call sub-scripts directly.

```
bin/airprompt on [<name>]      # start daemon + register (optional name)
bin/airprompt on --name <name> # same, explicit flag form
bin/airprompt off              # unregister + stop
bin/airprompt status           # show status
bin/airprompt name [<text>]    # name/rename session (empty or "" clears)
bin/airprompt clean            # full teardown
bin/airprompt autostart on|off # enable/disable auto-start on SessionStart
bin/airprompt help             # show usage
```

## Tests

- Run: `make test-all`
- Tests are ISOLATED — never kill the real daemon. Unit tests use `createApp()` (fresh server, no PID file). Integration tests use port 3211 + `/tmp/airprompt-server-test.pid`. Tmux sessions: `airprompt-test-*` / `airprompt-integtest-*` — never match real daemon sessions.

## Development

- Always `AIRPROMPT_DEBUG=1` when running scripts in dev. Use: `AIRPROMPT_DEBUG=1 bin/airprompt <cmd>`
