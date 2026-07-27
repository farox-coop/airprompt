#!/bin/bash
set -euo pipefail

DAEMON_PORT="${PORT:-${AIRPROMPT_PORT:-3210}}"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
PID_FILE="/tmp/airprompt-server.pid"
MARKER="${CONFIG_DIR}/.airprompt-active"
URL_FILE="${CONFIG_DIR}/.airprompt-url"
SESSION_FILE="${CONFIG_DIR}/.airprompt-session"

# ── Detect protocol ──────────────────────────────────────────────────
CERT_FILE="${CONFIG_DIR}/airprompt-cert.pem"
KEY_FILE="${CONFIG_DIR}/airprompt-key.pem"
PROTO="http"
CURL_OPTS=""
if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
  PROTO="https"
  CURL_OPTS="-k"
fi

LAN_IP=""
if command -v hostname &>/dev/null; then
  LAN_IP=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^172\.' | grep -v '^10\.' | head -1)
fi
[ -z "$LAN_IP" ] && LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$LAN_IP" ] && LAN_IP="localhost"

API_URL="${PROTO}://localhost:${DAEMON_PORT}"

# ── Status output ────────────────────────────────────────────────────
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
  echo "Daemon:  RUNNING (PID $PID)"
  echo "URL:     ${PROTO}://${LAN_IP}:${DAEMON_PORT}"
  echo ""

  # ── Registered sessions ────────────────────────────────────────────
  SESSIONS=$(curl -s $CURL_OPTS "${API_URL}/api/sessions" 2>/dev/null || echo "[]")
  if echo "$SESSIONS" | python3 -c "import sys,json; sys.exit(0 if len(json.load(sys.stdin)) > 0 else 1)" 2>/dev/null; then
    echo "Sessions:"
    echo "$SESSIONS" | python3 -c "
import sys, json
try:
  data = json.load(sys.stdin)
  for s in data:
    print(f\"  \033[36m{s['id']}\033[0m\")
    print(f\"    cwd: {s['cwd']}\")
    print(f\"    created: {s['createdAt']}\")
except: print('  (parse error)')
"
  else
    echo "Sessions: (none registered)"
  fi
  echo ""

  # ── Local markers ──────────────────────────────────────────────────
  if [ -f "$SESSION_FILE" ]; then
    LOCAL_SESSION=$(head -c 128 "$SESSION_FILE" 2>/dev/null | tr -d '\n\r')
    echo "This session: $LOCAL_SESSION"
    if [ -f "$MARKER" ]; then
      echo "Status:      ACTIVE (badge shown in statusline)"
    else
      echo "Status:      INACTIVE (no statusline badge)"
    fi
  else
    echo "This session: NOT REGISTERED"
    echo "Register with: /airprompt on"
  fi
else
  echo "Daemon:  NOT RUNNING"
  echo "URL:     ${PROTO}://${LAN_IP}:${DAEMON_PORT} (inactive)"
  echo ""
  echo "No active sessions — daemon stopped to save resources."
  echo "Start with: /airprompt on"
fi
