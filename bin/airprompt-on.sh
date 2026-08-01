#!/bin/bash
set -euo pipefail

# ── Help guard ─────────────────────────────────────────────────────────
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  echo "Usage: bin/airprompt on [--name <name>]"
  echo ""
  echo "  Start AirPrompt daemon and register current Claude session."
  echo "  --name <name>  Optional display name shown in web UI session list."
  echo ""
  echo "This is an internal script. Use 'bin/airprompt on' directly."
  exit 0
fi

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
SESSIONS_DIR="${CONFIG_DIR}/.airprompt/sessions"

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
  CREATED_SESSION=false
  if [ -n "${AIRPROMPT_TMUX_SESSION:-}" ]; then
    TMUX_SESSION="$AIRPROMPT_TMUX_SESSION"
  else
    TMUX_SESSION="airprompt-$$-$(date +%s)"
    if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
      tmux new-session -d -s "$TMUX_SESSION" -c "$ORIG_PWD"
      CREATED_SESSION=true
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

# ── Helper: persist cwd→name mapping for autostart reuse ────────────
_persist_project_name() {
  local name_val="$1"
  local names_file="${CONFIG_DIR}/.airprompt/project-names.json"
  PWD_VAL="$ORIG_PWD" NAME_VAL="$name_val" FILE_VAL="$names_file" node -e '
    var fs = require("fs");
    var map = {};
    try { map = JSON.parse(fs.readFileSync(process.env.FILE_VAL, "utf8")); } catch (_) {}
    map[process.env.PWD_VAL] = process.env.NAME_VAL;
    fs.writeFileSync(process.env.FILE_VAL, JSON.stringify(map, null, 2) + "\n");
  ' 2>/dev/null || true
}

# ── Helper: update session name via daemon API ───────────────────────
# Used by idempotency path (active file exists) and already-registered
# paths (409 from daemon). Writes name to disk only after API confirms.
_name_update() {
  local sid="$1" name_val="$2" my_dir="$3"
  local esc
  esc=$(printf '%s' "$name_val" | sed 's/\\/\\\\/g; s/"/\\"/g')
  local put_resp
  put_resp=$(curl -s $CURL_OPTS -X PUT "${PROTO}://localhost:${DAEMON_PORT}/api/sessions/name" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${sid}\",\"name\":\"${esc}\"}" 2>/dev/null || echo "")
  if echo "$put_resp" | grep -q '"ok":true'; then
    printf '%s\n' "$name_val" > "${my_dir}/name"
    _persist_project_name "$name_val"
    echo "Session name: $name_val"
  else
    echo "Warning: failed to update session name (daemon unreachable)" >&2
  fi
}

# ── Idempotency: skip if already registered (same tmux session) ──────
# Daemon recovers state from on-disk markers on startup, so a simple
# file check is sufficient — no need to double-check with daemon API.
if [ -f "$ACTIVE_FILE" ]; then
  # Retroactive fix: add missing mirror marker for AirPrompt-created sessions.
  # Covers both: sessions created by on.sh outside tmux, and mirror sessions
  # created by the activate hook. Excludes daemon and web proxy sessions.
  if [ ! -f "${MY_DIR}/mirror" ]; then
    case "$TMUX_SESSION" in
      airprompt-daemon|airprompt-web-*) ;;
      airprompt-*) touch "${MY_DIR}/mirror" ;;
      *) [ -z "${TMUX:-}" ] && touch "${MY_DIR}/mirror" ;;  # on.sh outside tmux
    esac
  fi
  if [ -n "$SESSION_NAME" ]; then
    MY_SID=$(head -c 128 "${MY_DIR}/session" 2>/dev/null | tr -d '\n\r')
    if [ -n "$MY_SID" ]; then
      _name_update "$MY_SID" "$SESSION_NAME" "$MY_DIR"
    fi
  fi
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
  [ "${CREATED_SESSION:-}" = "true" ] && touch "${MY_DIR}/mirror"
  if [ -n "$SESSION_NAME" ]; then
    # Registration already stores name on daemon; just persist to disk
    echo "$SESSION_NAME" > "${MY_DIR}/name"
    _persist_project_name "$SESSION_NAME"
    echo "Session name: $SESSION_NAME"
  fi
  echo "AirPrompt session registered: $SESSION_ID"
  echo "Mobile URL: ${PROTO}://${LAN_IP}:${DAEMON_PORT}"
elif echo "$RESP" | grep -q '"Session already registered"'; then
  mkdir -p "$MY_DIR"
  echo "${PROTO}://${LAN_IP}:${DAEMON_PORT}" > "${MY_DIR}/url"
  echo "$SESSION_ID" > "${MY_DIR}/session"
  echo "$TMUX_SESSION" > "${MY_DIR}/tmux"
  touch "$ACTIVE_FILE"
  [ "${CREATED_SESSION:-}" = "true" ] && touch "${MY_DIR}/mirror"
  if [ -n "$SESSION_NAME" ]; then
    _name_update "$SESSION_ID" "$SESSION_NAME" "$MY_DIR"
  fi
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
    tmux has-session -t "$REAL_TMUX" 2>/dev/null && HAS_SESSION_RC=0 || HAS_SESSION_RC=$?
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
