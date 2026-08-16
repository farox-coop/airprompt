#!/bin/bash
# airprompt-autostart.sh — Toggle auto-start on IDE session start.
# /airprompt autostart on  → add SessionStart hook to IDE settings
# /airprompt autostart off → remove it
set -euo pipefail

ACTION="${1:-}"

# ── Help guard ─────────────────────────────────────────────────────────
if [ "${ACTION}" = "--help" ] || [ "${ACTION}" = "-h" ]; then
  echo "Usage: /airprompt autostart on|off"
  echo ""
  echo "  on   — Automatically start AirPrompt when IDE starts (SessionStart hook)"
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
# Derive from script location (more reliable than probing PATH/env).
INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -d "$INSTALL_DIR" ]; then
  echo "AirPrompt: install directory not found" >&2
  exit 1
fi

# Resolve settings path. When AIRPROMPT_SETTINGS_FILE is provided, use it
# directly — no provider detection needed (a fresh machine/CI has none).
if [ -n "${AIRPROMPT_SETTINGS_FILE:-}" ]; then
  SETTINGS="$AIRPROMPT_SETTINGS_FILE"
else
  CONFIG_DIR=$(AIRPROMPT_INSTALL_DIR="$INSTALL_DIR" node "${INSTALL_DIR}/bin/lib/resolve-config-dir.js" "${AIRPROMPT_PROVIDER:-}" 2>/dev/null) || { echo "AirPrompt autostart: cannot resolve IDE config dir" >&2; exit 1; }
  SETTINGS="${CONFIG_DIR}/settings.json"
fi
ACTIVATE_SCRIPT="${INSTALL_DIR}/src/hooks/airprompt-activate.js"
SETTINGS_LIB="${INSTALL_DIR}/bin/lib/settings.js"

if [ ! -f "$ACTIVATE_SCRIPT" ]; then
  echo "AirPrompt: activate script not found at ${ACTIVATE_SCRIPT}" >&2
  exit 1
fi

# ── Add / remove SessionStart hook ────────────────────────────────────
AUTOSTART_LIB="${INSTALL_DIR}/bin/lib/autostart.js"
case "$ACTION" in
  on)
    node "$AUTOSTART_LIB" on "$SETTINGS" "$ACTIVATE_SCRIPT" "$SETTINGS_LIB"

    # Also register current session immediately (skip when testing autostart itself)
    if [ -x "$ACTIVATE_SCRIPT" ] && [ "${AIRPROMPT_AUTOSTART_SKIP_REGISTER:-}" != "1" ]; then
      AIRPROMPT_DEBUG="${AIRPROMPT_DEBUG:-0}" node "$ACTIVATE_SCRIPT" 2>&1 || true
    fi
    ;;
  off)
    node "$AUTOSTART_LIB" off "$SETTINGS" "$SETTINGS_LIB"
    ;;
esac
