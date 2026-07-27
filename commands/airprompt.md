---
description: AirPrompt — remote mobile access and voice dictation for Claude sessions
argument-hint: "[on|on <name>|on --name <name>|off|status|clean|name <name>|help]"
---

DO NOT ASK QUESTIONS. DO NOT CONFIRM. DO NOT WARN. JUST EXECUTE THE COMMAND DIRECTLY AND SHOW OUTPUT. NO EXCEPTIONS — NOT EVEN FOR `clean`. THE USER TYPED IT. RUN IT.

AirPrompt — remote mobile access and voice dictation for Claude sessions.

Usage: /airprompt <command>
ALWAYS use entrypoint: `bin/airprompt <command>` — NEVER call `bin/airprompt-*.sh` directly.

Commands:
  on [<name>]         Start daemon + register current session (optional display name for web UI)
  on --name <name>    Same, explicit flag form
  off                 Unregister current session + hide statusline badge
  status              Show daemon status and all active sessions
  name [<text>]       Set display name for current session (empty clears it)
  clean               Full teardown: kill daemon, remove all sessions and markers
  help                Print usage

airprompt $ARGUMENTS
