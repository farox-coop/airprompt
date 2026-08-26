#!/bin/bash
# airprompt-status.sh — Show daemon status and ALL session details.
# Deterministic output — same regardless of where it runs.
set -euo pipefail

# ── Help guard ─────────────────────────────────────────────────────────
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  echo "Usage: bin/airprompt status"
  echo ""
  echo "  Show daemon status and detailed info for every registered session."
  echo ""
  echo "This is an internal script. Use 'bin/airprompt status' directly."
  exit 0
fi

DAEMON_PORT="${AIRPROMPT_PORT:-3210}"
PID_FILE="${AIRPROMPT_PID_FILE:-/tmp/airprompt-server.pid}"

# ── Protocol detection (shared lib) ────────────────────────────────────
source "$(dirname "$0")/lib/protocol.sh"
detect_protocol
DAEMON_PORT="$AP_PORT"

# Resolve formatter — derive from script location (avoids stale ~/.airprompt)
FORMATTER="$(cd "$(dirname "$0")/.." && pwd)/src/status-formatter.js"
[ -f "$FORMATTER" ] || { echo "Error: status-formatter.js not found" >&2; exit 1; }


LAN_IP="$(_lan_ip)"

API_URL="${AP_PROTO}://localhost:${DAEMON_PORT}"

echo "=== AirPrompt Status ==="
echo ""

# ── Daemon status ────────────────────────────────────────────────────
DAEMON_RUNNING=false
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  # PID reuse guard — portable `ps` check (no /proc dependency), same as
  # off.sh/clean.sh/restart.sh. Reused or dead PID → stale pidfile.
  if kill -0 "$PID" 2>/dev/null && _is_airprompt_pid "$PID"; then
    DAEMON_RUNNING=true
  else
    rm -f "$PID_FILE"
  fi
fi

if $DAEMON_RUNNING; then
  _webui_info "$AP_PROTO" "$DAEMON_PORT" "$LAN_IP"
  echo "Daemon:    RUNNING (PID $PID)"
  # shellcheck disable=SC2153  # AP_URL is set by _webui_info (sourced from protocol.sh)
  echo "URL:       $AP_URL"
  echo ""
  if [ "$AP_PAIRED" != "1" ]; then
    _print_qr "$AP_URL"
    echo ""
  fi
else
  _webui_info "$AP_PROTO" "$DAEMON_PORT" "$LAN_IP"
  echo "Daemon:    NOT RUNNING"
  # shellcheck disable=SC2153  # AP_URL is set by _webui_info (sourced from protocol.sh)
  echo "URL:       $AP_URL (inactive)"
  echo ""
  echo "No active sessions — daemon stopped to save resources."
  echo "Start with: /airprompt on"
  exit 0
fi

# ── Sessions from daemon → format with Node.js ────────────────────────
curl -s "${AP_CURL_OPTS[@]}" "${API_URL}/api/sessions" 2>/dev/null | node "$FORMATTER"
