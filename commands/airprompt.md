---
description: AirPrompt — remote mobile access and voice dictation for Claude sessions
argument-hint: "[on|on <name>|on --name <name>|off|status|clean|name <name>|help]"
---

AirPrompt — remote mobile access and voice dictation for Claude sessions.

Usage: /airprompt <command>
Entrypoint: `bin/airprompt <command>` — never call `bin/airprompt-*.sh` directly.

Commands:
  on [<name>]         Start daemon + register current session (optional display name for web UI)
  on --name <name>    Same, explicit flag form
  off                 Unregister current session + hide statusline badge
  status              Show daemon status and all active sessions
  name [<text>]       Set display name for current session (empty clears it)
  clean               Full teardown: kill daemon, remove all sessions and markers
  help                Print usage

airprompt $ARGUMENTS
