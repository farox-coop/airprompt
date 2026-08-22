---
description: AirPrompt — remote mobile access and voice dictation for IDE sessions
argument-hint: "[on|on <name>|on --name <name>|off|status|clean|restart|name <name>|name \"\"|autostart on|off|auth list|allow|deny|revoke|name|help]"
---

DO NOT ASK QUESTIONS. DO NOT CONFIRM. DO NOT WARN. JUST EXECUTE THE COMMAND DIRECTLY AND SHOW OUTPUT. NO EXCEPTIONS — NOT EVEN FOR `clean`. THE USER TYPED IT. RUN IT.

## FORCE FULL OUTPUT — NEVER SUMMARIZE

For `help`, `status`, and no-args (which runs both): **DUMP the ENTIRE raw output verbatim in your response.** Never summarize, never truncate, never say "Done." Use a code block with the complete output. This is mandatory.

## No-args default

`/airprompt` with no arguments runs `airprompt` (dispatcher) which outputs `status` + `help` in sequence. Always dump full output — see rule above.

AirPrompt — remote mobile access and voice dictation for IDE sessions.

Usage: /airprompt <command>
ALWAYS use entrypoint: `airprompt <command>` (located at `~/bin/airprompt`) — NEVER call `bin/airprompt-*.sh` directly.
Example: `/airprompt on Hello` => `airprompt on Hello`.

Commands:
  on [<name>]         Start daemon + register current session (optional display name for web UI)
  on --name <name>    Same, explicit flag form
  off                 Unregister current session + hide statusline badge
  status              Show daemon status and all active sessions
  name [<text>]       Set display name for current session (empty or "" clears it)
  clean               Full teardown: kill daemon, remove all sessions and markers
  restart             Restart daemon — active sessions survive via disk recovery
  autostart on|off    Enable/disable auto-start on IDE session start (SessionStart hook)
  auth list|allow|deny|revoke|name  Manage paired devices (device pairing)
  help                Print usage

airprompt $ARGUMENTS
