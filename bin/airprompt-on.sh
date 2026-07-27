#!/bin/bash
set -euo pipefail

# ── Argument parsing ──────────────────────────────────────────────────
SESSION_NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --name) SESSION_NAME="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done

DAEMON_PORT="${PORT:-${AIRPROMPT_PORT:-3210}}"
DAEMON_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="/tmp/airprompt-server.pid"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SESSIONS_DIR="${CONFIG_DIR}/.airprompt-sessions"

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
if [ -n "${TMUX:-}" ]; then
  TMUX_SESSION=$(tmux display-message -p '#S' 2>/dev/null)
  if echo "$TMUX_SESSION" | grep -q '^airprompt-web-'; then
    # Resolve web proxy session to parent group — same logic as statusline script.
    PARENT_GROUP=$(tmux display-message -p '#{session_group}' 2>/dev/null | tr -d '\n\r')
    if [ -n "${PARENT_GROUP:-}" ]; then
      echo "Resolved web proxy session ($TMUX_SESSION) to parent group: $PARENT_GROUP" >&2
      TMUX_SESSION="$PARENT_GROUP"
    else
      echo "Warning: running inside web proxy session ($TMUX_SESSION), skipping" >&2
      TMUX_SESSION=""
    fi
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

# ── Per-session directory ────────────────────────────────────────────
# Sanitize tmux name to match statusline lookups (same as tr -cd 'a-zA-Z0-9_.-')
SAFE_TMUX=$(printf '%s' "$TMUX_SESSION" | tr -cd 'a-zA-Z0-9_.-')
MY_DIR="${SESSIONS_DIR}/${SAFE_TMUX}"
ACTIVE_FILE="${MY_DIR}/active"

# ── Idempotency: skip if already registered (same tmux session) ──────
# Daemon recovers state from on-disk markers on startup, so a simple
# file check is sufficient — no need to double-check with daemon API.
if [ -f "$ACTIVE_FILE" ]; then
  echo "AirPrompt already active for this session."
  echo "Mobile URL: ${PROTO}://${LAN_IP}:${DAEMON_PORT}"
  exit 0
fi

# ── Register with daemon ────────────────────────────────────────────
REG_PAYLOAD="{\"sessionId\":\"${SESSION_ID}\",\"cwd\":\"${ORIG_PWD}\",\"tmuxSession\":\"${TMUX_SESSION}\""
if [ -n "$SESSION_NAME" ]; then
  # Escape backslashes and double-quotes to prevent JSON injection
  ESCAPED_NAME=$(printf '%s' "$SESSION_NAME" | sed 's/\\/\\\\/g; s/"/\\"/g')
  REG_PAYLOAD="${REG_PAYLOAD},\"name\":\"${ESCAPED_NAME}\""
fi
REG_PAYLOAD="${REG_PAYLOAD}}"

RESP=$(curl -s $CURL_OPTS -X POST "${PROTO}://localhost:${DAEMON_PORT}/api/sessions/register" \
  -H "Content-Type: application/json" \
  -d "$REG_PAYLOAD")

if echo "$RESP" | grep -q '"ok":true'; then
  mkdir -p "$MY_DIR"
  echo "${PROTO}://${LAN_IP}:${DAEMON_PORT}" > "${MY_DIR}/url"
  echo "$SESSION_ID" > "${MY_DIR}/session"
  echo "$TMUX_SESSION" > "${MY_DIR}/tmux"
  touch "$ACTIVE_FILE"
  if [ -n "$SESSION_NAME" ]; then
    echo "$SESSION_NAME" > "${MY_DIR}/name"
    echo "Session name: $SESSION_NAME"
  fi
  echo "AirPrompt session registered: $SESSION_ID"
  echo "Mobile URL: ${PROTO}://${LAN_IP}:${DAEMON_PORT}"
elif echo "$RESP" | grep -q '"already registered"'; then
  mkdir -p "$MY_DIR"
  echo "${PROTO}://${LAN_IP}:${DAEMON_PORT}" > "${MY_DIR}/url"
  echo "$SESSION_ID" > "${MY_DIR}/session"
  echo "$TMUX_SESSION" > "${MY_DIR}/tmux"
  touch "$ACTIVE_FILE"
  [ -n "$SESSION_NAME" ] && echo "$SESSION_NAME" > "${MY_DIR}/name"
  echo "AirPrompt already registered for this session."
elif echo "$RESP" | grep -q '"Session already registered"'; then
  mkdir -p "$MY_DIR"
  echo "${PROTO}://${LAN_IP}:${DAEMON_PORT}" > "${MY_DIR}/url"
  echo "$SESSION_ID" > "${MY_DIR}/session"
  echo "$TMUX_SESSION" > "${MY_DIR}/tmux"
  touch "$ACTIVE_FILE"
  [ -n "$SESSION_NAME" ] && echo "$SESSION_NAME" > "${MY_DIR}/name"
  echo "AirPrompt already registered for this session."
else
  echo "Registration failed: $RESP" >&2
  exit 1
fi

# ── Cleanup: sweep dead session dirs ─────────────────────────────────
if [ -d "$SESSIONS_DIR" ]; then
  for d in "$SESSIONS_DIR"/*/; do
    [ -d "$d" ] || continue
    DN=$(basename "$d")
    [ "$DN" = "$SAFE_TMUX" ] && continue
    # Read real tmux name from dir — dir name is sanitized,
    # real name may differ (e.g. "My Session!" vs "MySession").
    REAL_TMUX=$(head -c 128 "${d}/tmux" 2>/dev/null | tr -d '\n\r')
    [ -z "$REAL_TMUX" ] && REAL_TMUX="$DN"
    tmux has-session -t "$REAL_TMUX" 2>/dev/null; HAS_SESSION_RC=$?
    if [ $HAS_SESSION_RC -eq 0 ]; then
      : # session alive — skip
    elif [ $HAS_SESSION_RC -eq 1 ]; then
      # Only delete if tmux explicitly says "no session" (exit code 1).
      # Other non-zero codes = tmux error/timeout — don't touch (safe).
      echo "Cleaning up dead session dir: $DN" >&2
      # Read session ID from the session file (not from dir name)
      SID=$(head -c 128 "${d}/session" 2>/dev/null | tr -d '\n\r')
      [ -z "$SID" ] && SID=$(echo "$DN" | tr -cd 'a-zA-Z0-9_-')
      curl -s $CURL_OPTS -X POST "${PROTO}://localhost:${DAEMON_PORT}/api/sessions/unregister" \
        -H "Content-Type: application/json" \
        -d "{\"sessionId\":\"${SID}\"}" > /dev/null 2>&1 || true
      rm -rf "$d"
    fi
  done
fi
