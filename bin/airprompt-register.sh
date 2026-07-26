#!/bin/bash
set -euo pipefail

DAEMON_PORT="${PORT:-${AIRPROMPT_PORT:-3210}}"
DAEMON_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="/tmp/airprompt-server.pid"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
MARKER="${CONFIG_DIR}/.airprompt-active"
URL_FILE="${CONFIG_DIR}/.airprompt-url"
SESSION_FILE="${CONFIG_DIR}/.airprompt-session"

# ── Dependency checks ───────────────────────────────────────────────
for cmd in tmux node curl; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: '$cmd' is required but not installed." >&2
    exit 1
  fi
done

# ── Save original PWD before any cd ─────────────────────────────────
ORIG_PWD="$PWD"

# ── Generate session ID ─────────────────────────────────────────────
SESSION_ID="$(date +%s)-$$-$(basename "$ORIG_PWD" | tr -cd 'a-zA-Z0-9-_')"

# Detect if we are already inside a tmux session (Claude running in tmux).
# If yes, use THAT session so the phone mirrors the real Claude session.
# If no, create a new tmux session (bare shell — user should start Claude in tmux).
if [ -n "${TMUX:-}" ]; then
  TMUX_SESSION=$(tmux display-message -p '#S' 2>/dev/null)
  echo "Detected existing tmux session: $TMUX_SESSION (mirroring this Claude session)"
else
  TMUX_SESSION="airprompt-${SESSION_ID}"
  if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    tmux new-session -d -s "$TMUX_SESSION" -c "$ORIG_PWD"
    echo "Created new tmux session: $TMUX_SESSION"
    echo "Start Claude inside it to mirror real session: tmux attach -t $TMUX_SESSION"
  fi
fi
LAN_IP=""
if command -v hostname &>/dev/null; then
  LAN_IP=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^172\.' | grep -v '^10\.' | head -1)
fi
# Fallback to first IP if filtering removed all
[ -z "$LAN_IP" ] && LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$LAN_IP" ] && LAN_IP="localhost"

# ── Ensure daemon is running ─────────────────────────────────────────
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$PID_FILE"
  fi
fi

if [ ! -f "$PID_FILE" ]; then
  cd "$DAEMON_DIR"
  node server.js > /tmp/airprompt.log 2>&1 &
  for i in $(seq 1 20); do
    if curl -s "http://localhost:${DAEMON_PORT}/api/sessions" > /dev/null 2>&1; then
      break
    fi
    if ! kill -0 $! 2>/dev/null; then
      echo "Error: server process died. Check /tmp/airprompt.log" >&2
      cd "$ORIG_PWD"
      exit 1
    fi
    sleep 0.5
  done
  cd "$ORIG_PWD"
fi

# ── Register with daemon ────────────────────────────────────────────
RESP=$(curl -s -X POST "http://localhost:${DAEMON_PORT}/api/sessions/register" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"${SESSION_ID}\",\"cwd\":\"${ORIG_PWD}\"}")

if echo "$RESP" | grep -q '"ok":true'; then
  mkdir -p "$CONFIG_DIR"
  echo "http://${LAN_IP}:${DAEMON_PORT}" > "$URL_FILE"
  echo "$SESSION_ID" > "$SESSION_FILE"
  touch "$MARKER"
  echo "AirPrompt session registered: $SESSION_ID"
  echo "Mobile URL: http://${LAN_IP}:${DAEMON_PORT}"
else
  echo "Registration failed: $RESP" >&2
  exit 1
fi
