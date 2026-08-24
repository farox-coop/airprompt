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


LAN_IP=""
if command -v hostname &>/dev/null; then
  LAN_IP=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^172\.' | grep -v '^10\.' | head -1)
fi
[ -z "$LAN_IP" ] && LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$LAN_IP" ] && LAN_IP="localhost"

API_URL="${AP_PROTO}://localhost:${DAEMON_PORT}"

echo "=== AirPrompt Status ==="
echo ""

# ── Daemon status ────────────────────────────────────────────────────
DAEMON_RUNNING=false
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    # PID reuse guard — same /proc/cmdline pattern as off.sh/clean.sh but
    # opposite fallback: if /proc is unreadable (non-Linux), assume RUNNING
    # (show status). off.sh assumes NOT-airprompt (safer default for kill).
    if [ -r "/proc/$PID/cmdline" ]; then
      if tr '\0' ' ' < "/proc/$PID/cmdline" | grep -q 'server\.js'; then
        DAEMON_RUNNING=true
      fi
    else
      DAEMON_RUNNING=true  # non-Linux — fall back to kill -0 only
    fi
  fi
  if ! $DAEMON_RUNNING; then
    rm -f "$PID_FILE"
  fi
fi

if $DAEMON_RUNNING; then
  echo "Daemon:    RUNNING (PID $PID)"
  echo "URL:       ${AP_PROTO}://${LAN_IP}:${DAEMON_PORT}"
  echo ""
else
  echo "Daemon:    NOT RUNNING"
  echo "URL:       ${AP_PROTO}://${LAN_IP}:${DAEMON_PORT} (inactive)"
  echo ""
  echo "No active sessions — daemon stopped to save resources."
  echo "Start with: /airprompt on"
  exit 0
fi

# ── Sessions from daemon → format with Node.js ────────────────────────
curl -s "${AP_CURL_OPTS[@]}" "${API_URL}/api/sessions" 2>/dev/null | node "$FORMATTER"
