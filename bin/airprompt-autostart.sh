#!/bin/bash
# airprompt-autostart.sh — Toggle auto-start on Claude session start.
# /airprompt autostart on  → add SessionStart hook to ~/.claude/settings.json
# /airprompt autostart off → remove it
set -euo pipefail

ACTION="${1:-}"

# ── Help guard ─────────────────────────────────────────────────────────
if [ "${ACTION}" = "--help" ] || [ "${ACTION}" = "-h" ]; then
  echo "Usage: /airprompt autostart on|off"
  echo ""
  echo "  on   — Automatically start AirPrompt when Claude starts (SessionStart hook)"
  echo "  off  — Disable auto-start"
  echo ""
  echo "This is an internal script. Use 'bin/airprompt autostart <on|off>' directly."
  exit 0
fi

if [ "$ACTION" != "on" ] && [ "$ACTION" != "off" ]; then
  echo "Usage: /airprompt autostart on|off" >&2
  exit 1
fi

# ── Resolve install dir ───────────────────────────────────────────────
INSTALL_DIR=""
for d in "${CLAUDE_PLUGIN_ROOT:-}" ~/.airprompt ~/projects/airprompt; do
  [ -d "$d" ] || continue
  INSTALL_DIR="$d"
  break
done

if [ -z "$INSTALL_DIR" ]; then
  echo "AirPrompt: install directory not found" >&2
  exit 1
fi

CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SETTINGS="${AIRPROMPT_SETTINGS_FILE:-${CONFIG_DIR}/settings.json}"
ACTIVATE_SCRIPT="${INSTALL_DIR}/src/hooks/airprompt-activate.js"
SETTINGS_LIB="${INSTALL_DIR}/bin/lib/settings.js"

if [ ! -f "$ACTIVATE_SCRIPT" ]; then
  echo "AirPrompt: activate script not found at ${ACTIVATE_SCRIPT}" >&2
  exit 1
fi

# ── Add / remove SessionStart hook ────────────────────────────────────
case "$ACTION" in
  on)
    AIRPROMPT_SETTINGS_LIB="$SETTINGS_LIB" \
    AIRPROMPT_SETTINGS_PATH="$SETTINGS" \
    AIRPROMPT_ACTIVATE_SCRIPT="$ACTIVATE_SCRIPT" \
    node -e '
      "use strict";
      const { readSettings, writeSettings, addCommandHook } = require(process.env.AIRPROMPT_SETTINGS_LIB);
      const settingsPath = process.env.AIRPROMPT_SETTINGS_PATH;
      const activateScript = process.env.AIRPROMPT_ACTIVATE_SCRIPT;
      const s = readSettings(settingsPath);
      if (s === null) {
        process.stderr.write("AirPrompt autostart: settings.json is corrupted — cannot modify\n");
        process.exit(1);
      }
      const added = addCommandHook(s, "SessionStart", {
        command: "node " + JSON.stringify(activateScript),
        marker: "airprompt-activate.js",
        timeout: 10000,
        statusMessage: "Starting AirPrompt...",
      });
      if (added) {
        writeSettings(settingsPath, s);
        process.stdout.write("AirPrompt autostart: ON\n");
      } else {
        process.stdout.write("AirPrompt autostart: already ON\n");
      }
    '

    # Also register current session immediately (skip when testing autostart itself)
    if [ -x "$ACTIVATE_SCRIPT" ] && [ "${AIRPROMPT_AUTOSTART_SKIP_REGISTER:-}" != "1" ]; then
      AIRPROMPT_DEBUG="${AIRPROMPT_DEBUG:-1}" node "$ACTIVATE_SCRIPT" 2>&1 || true
    fi
    ;;
  off)
    AIRPROMPT_SETTINGS_LIB="$SETTINGS_LIB" \
    AIRPROMPT_SETTINGS_PATH="$SETTINGS" \
    node -e '
      "use strict";
      const path = require("path");
      const { readSettings, writeSettings, hasAirPromptHook, tokenizeCommand } = require(process.env.AIRPROMPT_SETTINGS_LIB);
      const settingsPath = process.env.AIRPROMPT_SETTINGS_PATH;
      const s = readSettings(settingsPath);
      if (s === null) {
        process.stderr.write("AirPrompt autostart: settings.json is corrupted — cannot modify\n");
        process.exit(1);
      }
      if (!hasAirPromptHook(s, "SessionStart", "airprompt-activate.js")) {
        process.stdout.write("AirPrompt autostart: already OFF\n");
        process.exit(0);
      }
      // Filter at hook level — only remove hooks whose command references
      // a managed script by basename, preserve others in same entry.
      var MANAGED = ["airprompt-activate.js", "airprompt-deactivate.js", "airprompt-statusline.sh"];
      // Guard: if SessionStart is not an array (malformed settings), nothing to remove
      if (!Array.isArray(s.hooks.SessionStart)) {
        s.hooks.SessionStart = [];
      }
      for (var ei = 0; ei < s.hooks.SessionStart.length; ei++) {
        var entry = s.hooks.SessionStart[ei];
        if (!entry || !Array.isArray(entry.hooks)) continue;
        entry.hooks = entry.hooks.filter(function(h) {
          if (!h || typeof h.command !== "string") return false;
          // Use proper shell-aware tokenizer (handles quoted arguments)
          var tokens = tokenizeCommand(h.command);
          return !tokens.some(function(t) {
            return MANAGED.indexOf(path.basename(t)) !== -1;
          });
        });
      }
      // Remove entries left with zero hooks after filtering
      s.hooks.SessionStart = s.hooks.SessionStart.filter(function(entry) {
        return entry && Array.isArray(entry.hooks) && entry.hooks.length > 0;
      });
      if (s.hooks.SessionStart.length === 0) delete s.hooks.SessionStart;
      if (Object.keys(s.hooks).length === 0) delete s.hooks;
      writeSettings(settingsPath, s);
      process.stdout.write("AirPrompt autostart: OFF\n");
    '
    ;;
esac
