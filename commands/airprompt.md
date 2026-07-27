---
description: AirPrompt — remote mobile access and voice dictation for Claude sessions
argument-hint: "[on|off|status|clean]"
---

Run: for d in "${CLAUDE_PLUGIN_ROOT:-}" ~/.airprompt ~/projects/airprompt; do s="$d/bin/airprompt-$ARGUMENTS.sh"; [ -f "$s" ] && exec bash "$s"; done; echo "Error: airprompt-$ARGUMENTS.sh not found" >&2
