---
name: airprompt
description: Remote mobile access and voice dictation for this Windsurf session
---

AirPrompt exposes this Windsurf session to your phone — view and control the terminal remotely, plus voice dictation.

This is a Windsurf session. Always run the entrypoint (at `~/bin/airprompt`) with the Windsurf provider id: `AIRPROMPT_PROVIDER=windsurf airprompt <command>` — never call `bin/airprompt-*.sh` directly.

Commands:

- `on [<name>]` — start the daemon and register this session (optional display name)
- `off` — unregister this session
- `status` — show daemon status and active sessions
- `name [<text>]` — set or clear the session display name
- `restart` — restart the daemon (sessions survive)
- `clean` — full teardown
- `help` — usage

Example: `AIRPROMPT_PROVIDER=windsurf airprompt on my-project`
