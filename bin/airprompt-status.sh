#!/bin/bash
set -euo pipefail

# ── Help guard ─────────────────────────────────────────────────────────
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  echo "Usage: bin/airprompt status"
  echo ""
  echo "  Show daemon status, registered sessions, and current session info."
  echo ""
  echo "This is an internal script. Use 'bin/airprompt status' directly."
  exit 0
fi

DAEMON_PORT="${PORT:-${AIRPROMPT_PORT:-3210}}"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SESSIONS_DIR="${CONFIG_DIR}/.airprompt-sessions"
PID_FILE="/tmp/airprompt-server.pid"

# ── Detect protocol: daemon.json SSOT → cert fallback → http ──────────
AIRPROMPT_CONF="${CONFIG_DIR}/.airprompt/daemon.json"
PROTO="http"
CURL_OPTS=""
if [ -f "$AIRPROMPT_CONF" ] && command -v jq >/dev/null 2>&1; then
  PROTO=$(jq -r '.protocol // "http"' "$AIRPROMPT_CONF" 2>/dev/null || echo "http")
  DAEMON_PORT=$(jq -r '.port // 3210' "$AIRPROMPT_CONF" 2>/dev/null || echo "$DAEMON_PORT")
elif [ "${AIRPROMPT_NO_TLS:-}" != "1" ] && [ -f "${CONFIG_DIR}/airprompt-cert.pem" ] && [ -f "${CONFIG_DIR}/airprompt-key.pem" ]; then
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

# ── Resolve current tmux session ─────────────────────────────────────
CURRENT_TMUX=""
if [ -n "${TMUX:-}" ]; then
  CURRENT_TMUX=$(tmux display-message -p '#S' 2>/dev/null || true)
  if echo "$CURRENT_TMUX" | grep -q '^airprompt-web-'; then
    CURRENT_TMUX=$(tmux display-message -p '#{session_group}' 2>/dev/null | tr -d '\n\r')
  fi
fi

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
    label = s.get('name') or s['cwd']
    print(f\"  \033[36m{label}\033[0m\")
    print(f\"    id: {s['id']}\")
    print(f\"    cwd: {s['cwd']}\")
    print(f\"    created: {s['createdAt']}\")
except: print('  (parse error)')
"
  else
    echo "Sessions: (none registered)"
  fi
  echo ""

  # ── Local status ──────────────────────────────────────────────────
  # Sanitize to match dir name created by airprompt-on / activate (same: tr -cd 'a-zA-Z0-9_.-')
  SAFE_NAME=$(printf '%s' "$CURRENT_TMUX" | tr -cd 'a-zA-Z0-9_.-')
  if [ -n "$SAFE_NAME" ] && [ -d "${SESSIONS_DIR}/${SAFE_NAME}" ]; then
    MY_DIR="${SESSIONS_DIR}/${SAFE_NAME}"
    LOCAL_SESSION=$(head -c 128 "${MY_DIR}/session" 2>/dev/null | tr -d '\n\r')
    echo "This session: $LOCAL_SESSION"
    if [ -f "${MY_DIR}/active" ]; then
      echo "Status:      ACTIVE (badge shown in statusline)"
    else
      echo "Status:      INACTIVE (no statusline badge)"
    fi
    if [ -f "${MY_DIR}/name" ]; then
      echo "Name:        $(cat "${MY_DIR}/name")"
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
