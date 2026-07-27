---
description: AirPrompt — remote mobile access and voice dictation for Claude sessions
argument-hint: "[on|on <name>|off|status|clean|name <name>]"
---

Run: for d in "${CLAUDE_PLUGIN_ROOT:-}" ~/.airprompt ~/projects/airprompt; do s="$d/bin/airprompt"; [ -f "$s" ] && exec bash "$s" $ARGUMENTS; done; echo "Error: airprompt not found" >&2
