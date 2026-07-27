#!/bin/bash
set -euo pipefail

DAEMON_PORT="${PORT:-${AIRPROMPT_PORT:-3210}}"
DAEMON_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="/tmp/airprompt-server.pid"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
MARKER="${CONFIG_DIR}/.airprompt-active"
URL_FILE="${CONFIG_DIR}/.airprompt-url"
SESSION_FILE="${CONFIG_DIR}/.airprompt-session"
TMUX_ACTIVE_FILE="${CONFIG_DIR}/.airprompt-tmux-active"
DEBUG="${AIRPROMPT_DEBUG:-1}"  # always debug during development

# ── Dependency checks ───────────────────────────────────────────────
for cmd in tmux node curl; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: '$cmd' is required but not installed." >&2
    exit 1
  fi
done

# ── Save original PWD before any cd ─────────────────────────────────
ORIG_PWD="$PWD"

# ── Generate stable session ID (based on tmux, not shell PID) ────────
TMUX_MARKER="${CONFIG_DIR}/.airprompt-tmux-session"

if [ -n "${TMUX:-}" ]; then
  TMUX_SESSION=$(tmux display-message -p '#S' 2>/dev/null)
  if echo "$TMUX_SESSION" | grep -q '^airprompt-web-'; then
    echo "Warning: running inside web proxy session ($TMUX_SESSION), skipping" >&2
    TMUX_SESSION=""
  fi
fi
if [ -z "${TMUX_SESSION:-}" ] && [ -f "$TMUX_MARKER" ]; then
  TMUX_SESSION=$(head -c 128 "$TMUX_MARKER" 2>/dev/null | tr -d '\n\r')
  if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    echo "Warning: tmux session from marker ($TMUX_SESSION) not found" >&2
    TMUX_SESSION=""
  fi
fi

if [ -z "${TMUX_SESSION:-}" ]; then
  if [ -n "${AIRPROMPT_TMUX_SESSION:-}" ]; then
    TMUX_SESSION="$AIRPROMPT_TMUX_SESSION"
  else
    TMUX_SESSION="airprompt-$$-$(date +%s)"
    if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
      tmux new-session -d -s "$TMUX_SESSION" -c "$ORIG_PWD"
    fi
  fi
fi

SESSION_ID="$(echo "$TMUX_SESSION" | tr -cd 'a-zA-Z0-9_-')"

LAN_IP=""
if command -v hostname &>/dev/null; then
  LAN_IP=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^172\.' | grep -v '^10\.' | head -1)
fi
[ -z "$LAN_IP" ] && LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$LAN_IP" ] && LAN_IP="localhost"

# ── Detect protocol ──────────────────────────────────────────────────
CERT_FILE="${CONFIG_DIR}/airprompt-cert.pem"
KEY_FILE="${CONFIG_DIR}/airprompt-key.pem"
PROTO="http"
CURL_OPTS=""
if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
  PROTO="https"
  CURL_OPTS="-k"
fi

# ── Ensure daemon is running ─────────────────────────────────────────
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$PID_FILE"
  fi
fi

if [ ! -f "$PID_FILE" ]; then
  echo "Starting daemon..."
  cd "$DAEMON_DIR"
  # tmux: daemon owned by tmux server (immortal process), not this shell.
  # Avoids process-group death when the Bash tool/script shell exits.
  if ! tmux has-session -t airprompt-daemon 2>/dev/null; then
    tmux new-session -d -s airprompt-daemon "AIRPROMPT_DEBUG=$DEBUG node server.js 2>&1 | tee /tmp/airprompt.log"
  else
    tmux respawn-pane -k -t airprompt-daemon "AIRPROMPT_DEBUG=$DEBUG node server.js 2>&1 | tee /tmp/airprompt.log" 2>/dev/null || true
  fi
  for i in $(seq 1 20); do
    if curl -s $CURL_OPTS "${PROTO}://localhost:${DAEMON_PORT}/api/sessions" > /dev/null 2>&1; then
      break
    fi
    if ! tmux has-session -t airprompt-daemon 2>/dev/null; then
      echo "Error: daemon died. Check /tmp/airprompt.log" >&2
      cd "$ORIG_PWD"
      exit 1
    fi
    sleep 0.5
  done
  cd "$ORIG_PWD"
fi

# ── Idempotency: skip if already registered (same tmux session) ──────
if [ -f "$MARKER" ] && [ -f "$SESSION_FILE" ] && [ -f "$TMUX_ACTIVE_FILE" ]; then
  ACTIVE_TMUX=$(head -c 128 "$TMUX_ACTIVE_FILE" 2>/dev/null | tr -d '\n\r')
  if [ "$ACTIVE_TMUX" = "$TMUX_SESSION" ]; then
    echo "AirPrompt already active for this session."
    echo "Mobile URL: ${PROTO}://${LAN_IP}:${DAEMON_PORT}"
    exit 0
  fi
fi

# ── Register with daemon ────────────────────────────────────────────
RESP=$(curl -s $CURL_OPTS -X POST "${PROTO}://localhost:${DAEMON_PORT}/api/sessions/register" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"${SESSION_ID}\",\"cwd\":\"${ORIG_PWD}\",\"tmuxSession\":\"${TMUX_SESSION}\"}")

if echo "$RESP" | grep -q '"ok":true'; then
  mkdir -p "$CONFIG_DIR"
  echo "${PROTO}://${LAN_IP}:${DAEMON_PORT}" > "$URL_FILE"
  echo "$SESSION_ID" > "$SESSION_FILE"
  echo "$TMUX_SESSION" > "$TMUX_ACTIVE_FILE"
  touch "$MARKER"
  echo "AirPrompt session registered: $SESSION_ID"
  echo "Mobile URL: ${PROTO}://${LAN_IP}:${DAEMON_PORT}"
elif echo "$RESP" | grep -q '"already registered"'; then
  mkdir -p "$CONFIG_DIR"
  echo "${PROTO}://${LAN_IP}:${DAEMON_PORT}" > "$URL_FILE"
  echo "$SESSION_ID" > "$SESSION_FILE"
  echo "$TMUX_SESSION" > "$TMUX_ACTIVE_FILE"
  touch "$MARKER"
  echo "AirPrompt already registered for this session."
elif echo "$RESP" | grep -q '"Session already registered"'; then
  mkdir -p "$CONFIG_DIR"
  echo "${PROTO}://${LAN_IP}:${DAEMON_PORT}" > "$URL_FILE"
  echo "$SESSION_ID" > "$SESSION_FILE"
  echo "$TMUX_SESSION" > "$TMUX_ACTIVE_FILE"
  touch "$MARKER"
  echo "AirPrompt already registered for this session."
else
  echo "Registration failed: $RESP" >&2
  exit 1
fi
