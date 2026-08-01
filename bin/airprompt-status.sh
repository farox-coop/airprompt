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

DAEMON_PORT="${PORT:-${AIRPROMPT_PORT:-3210}}"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
PID_FILE="${AIRPROMPT_PID_FILE:-/tmp/airprompt-server.pid}"

# Resolve formatter — same priority as dispatcher: plugin → ~/.airprompt → dev
FORMATTER=""
for d in "${CLAUDE_PLUGIN_ROOT:-}" "$HOME/.airprompt" "$HOME/projects/airprompt"; do
  if [ -f "$d/src/status-formatter.js" ]; then FORMATTER="$d/src/status-formatter.js"; break; fi
done
[ -z "$FORMATTER" ] && { echo "Error: status-formatter.js not found" >&2; exit 1; }

# ── Detect protocol: daemon.json SSOT → cert fallback → http ──────────
AIRPROMPT_CONF="${CONFIG_DIR}/.airprompt/daemon.json"
PROTO="http"
CURL_OPTS=""
if [ -f "$AIRPROMPT_CONF" ] && command -v jq >/dev/null 2>&1; then
  PROTO=$(jq -r '.protocol // "http"' "$AIRPROMPT_CONF" 2>/dev/null || echo "http")
  DAEMON_PORT=$(jq -r '.port // 3210' "$AIRPROMPT_CONF" 2>/dev/null || echo "$DAEMON_PORT")
elif [ "${AIRPROMPT_NO_TLS:-}" != "1" ] && [ -f "${CONFIG_DIR}/.airprompt/airprompt-cert.pem" ] && [ -f "${CONFIG_DIR}/.airprompt/airprompt-key.pem" ]; then
  PROTO="https"
fi
[ "$PROTO" = "https" ] && CURL_OPTS="-k"

LAN_IP=""
if command -v hostname &>/dev/null; then
  LAN_IP=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^172\.' | grep -v '^10\.' | head -1)
fi
[ -z "$LAN_IP" ] && LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$LAN_IP" ] && LAN_IP="localhost"

API_URL="${PROTO}://localhost:${DAEMON_PORT}"

echo "=== AirPrompt Status ==="
echo ""

# ── Daemon status ────────────────────────────────────────────────────
DAEMON_RUNNING=false
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    DAEMON_RUNNING=true
  else
    rm -f "$PID_FILE"
  fi
fi

if $DAEMON_RUNNING; then
  echo "Daemon:    RUNNING (PID $PID)"
  echo "URL:       ${PROTO}://${LAN_IP}:${DAEMON_PORT}"
  echo ""
else
  echo "Daemon:    NOT RUNNING"
  echo "URL:       ${PROTO}://${LAN_IP}:${DAEMON_PORT} (inactive)"
  echo ""
  echo "No active sessions — daemon stopped to save resources."
  echo "Start with: /airprompt on"
  exit 0
fi

# ── Sessions from daemon → format with Node.js ────────────────────────
curl -s $CURL_OPTS "${API_URL}/api/sessions" 2>/dev/null | node "$FORMATTER"
