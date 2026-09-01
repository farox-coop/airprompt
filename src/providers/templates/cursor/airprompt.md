# AirPrompt — remote mobile access

This is a Cursor session. Always run the entrypoint (at `~/bin/airprompt`) with the Cursor provider id: `AIRPROMPT_PROVIDER=cursor airprompt <command>` — never call `bin/airprompt-*.sh` directly.

- `on [<name>]` — start the daemon and register this Cursor session
- `off` — unregister this session
- `status` — show daemon status and active sessions
- `name [<text>]` — set or clear the session display name
- `restart` — restart the daemon
- `clean` — full teardown
- `help` — usage

Execute the requested command directly and show its output.
