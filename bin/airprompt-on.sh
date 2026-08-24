#!/bin/bash
set -euo pipefail

# ── Help guard ─────────────────────────────────────────────────────────
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  echo "Usage: bin/airprompt on [--name <name>]"
  echo ""
  echo "  Start AirPrompt daemon and register current IDE session."
  echo "  --name <name>  Optional display name shown in web UI session list."
  echo ""
  echo "This is an internal script. Use 'bin/airprompt on' directly."
  exit 0
fi

# ── Argument parsing ──────────────────────────────────────────────────
SESSION_NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --name) SESSION_NAME="${2:-}"; [ $# -ge 2 ] && shift 2 || shift ;;
    *) shift ;;
  esac
done

DAEMON_PORT="${AIRPROMPT_PORT:-3210}"
DAEMON_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="${AIRPROMPT_PID_FILE:-/tmp/airprompt-server.pid}"
SESSIONS_DIR="${AIRPROMPT_SESSIONS_DIR:-$HOME/.airprompt/sessions}"
PROVIDER="${AIRPROMPT_PROVIDER:?}"

# ── Protocol detection (shared lib) ────────────────────────────────────
source "$(dirname "$0")/lib/protocol.sh"
detect_protocol
DAEMON_PORT="$AP_PORT"

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
      echo "Warning: web proxy session ($TMUX_SESSION) has no parent group — will create new session" >&2
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

SESSION_ID="$(echo "$TMUX_SESSION" | tr -cd 'a-zA-Z0-9_-' | head -c 64)"

LAN_IP=""
if command -v hostname &>/dev/null; then
  LAN_IP=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^172\.' | grep -v '^10\.' | head -1 || true)
fi
[ -z "$LAN_IP" ] && LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$LAN_IP" ] && LAN_IP="localhost"

# ── Ensure daemon is running ─────────────────────────────────────────
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    # PID reuse guard — verify cmdline matches
    if [ -r "/proc/$PID/cmdline" ]; then
      tr '\0' ' ' < "/proc/$PID/cmdline" | grep -q 'server\.js' || rm -f "$PID_FILE"
    fi
  else
    rm -f "$PID_FILE"
  fi
fi

# ── Auto-generate TLS certs if missing ─────────────────────────────
CERT_DIR="${AIRPROMPT_STATE_DIR:-$HOME/.airprompt/state}"
CERT_FILE="${CERT_DIR}/airprompt-cert.pem"
KEY_FILE="${CERT_DIR}/airprompt-key.pem"
if [ "${AIRPROMPT_NO_TLS:-}" != "1" ] && { [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; }; then
  GEN_CERT_SCRIPT="$(dirname "$0")/generate-cert.sh"
  if [ -x "$GEN_CERT_SCRIPT" ]; then
    bash "$GEN_CERT_SCRIPT" || true  # non-fatal: HTTP fallback if openssl missing
    # Re-detect protocol after cert generation
    detect_protocol
    DAEMON_PORT="$AP_PORT"
  fi
fi

DAEMON_ENV="$(daemon_env)"

if [ ! -f "$PID_FILE" ]; then
  echo "Starting daemon..."
  cd "$DAEMON_DIR"
  # tmux: daemon owned by tmux server (immortal process), not this shell.
  # Avoids process-group death when the Bash tool/script shell exits.
  if ! tmux has-session -t airprompt-daemon 2>/dev/null; then
    tmux new-session -d -s airprompt-daemon "$DAEMON_ENV node server.js 2>&1 | tee /tmp/airprompt.log"
  else
    tmux respawn-pane -k -t airprompt-daemon "$DAEMON_ENV node server.js 2>&1 | tee /tmp/airprompt.log" 2>/dev/null || true
  fi
  for i in $(seq 1 20); do
    if curl -s "${AP_CURL_OPTS[@]}" "${AP_PROTO}://localhost:${DAEMON_PORT}/api/sessions" > /dev/null 2>&1; then
      break
    fi
    if ! tmux has-session -t airprompt-daemon 2>/dev/null; then
      echo "Error: daemon died after $i attempts. Check /tmp/airprompt.log" >&2
      cd "$ORIG_PWD"
      exit 1
    fi
    sleep 0.5
  done
  # Verify daemon actually responded — not just timeout
  if ! curl -s "${AP_CURL_OPTS[@]}" "${AP_PROTO}://localhost:${DAEMON_PORT}/api/sessions" > /dev/null 2>&1; then
    echo "Error: daemon not responding after 10s. Check /tmp/airprompt.log" >&2
    cd "$ORIG_PWD"
    exit 1
  fi
  cd "$ORIG_PWD"
fi

# ── First-run splash: banner + QR code — shown ONCE ever ───────────
# Runs whenever the daemon is running (regardless of who started it).
# The marker survives until clean.sh tears down the state dir.
FIRST_RUN_MARKER="${AIRPROMPT_STATE_DIR:-$HOME/.airprompt/state}/.first-run-done"
if [ -f "$PID_FILE" ] && [ ! -f "$FIRST_RUN_MARKER" ]; then
  DAEMON_PID=$(cat "$PID_FILE" 2>/dev/null || echo "?")
  echo ""
  echo "=================================================="
  echo "AirPrompt Server running at: ${AP_PROTO}://${LAN_IP}:${DAEMON_PORT}"
  echo "=================================================="
  echo ""
  cd "$DAEMON_DIR"
  node -e "
    try {
      const qr = require('qrcode-terminal');
      qr.generate(process.argv[1], {small: true});
    } catch(_) {}
  " "${AP_PROTO}://${LAN_IP}:${DAEMON_PORT}" 2>/dev/null || true
  cd "$ORIG_PWD"
  echo "Server running (PID $DAEMON_PID)"
  mkdir -p "${FIRST_RUN_MARKER%/*}" 2>/dev/null || true
  touch "$FIRST_RUN_MARKER" 2>/dev/null || true
fi

# ── Per-session directory ────────────────────────────────────────────
# Sanitize tmux name to match statusline lookups (same as tr -cd 'a-zA-Z0-9_.-')
SAFE_TMUX=$(printf '%s' "$TMUX_SESSION" | tr -cd 'a-zA-Z0-9_.-')
MY_DIR="${SESSIONS_DIR}/${PROVIDER}-${SAFE_TMUX}"
ACTIVE_FILE="${MY_DIR}/active"

# ── Helper: persist cwd→name mapping for autostart reuse ────────────
_persist_project_name() {
  local name_val="$1"
  local names_file="${AIRPROMPT_STATE_DIR:-$HOME/.airprompt/state}/project-names.json"
  node "${DAEMON_DIR}/bin/lib/project-names.js" set "$names_file" "$ORIG_PWD" "$name_val" 2>/dev/null || true
}

# ── Helper: update session name via daemon API ───────────────────────
# Used by idempotency path (active file exists) and already-registered
# paths (409 from daemon). Writes name to disk only after API confirms.
_name_update() {
  local sid="$1" name_val="$2" my_dir="$3"
  local esc
  esc=$(printf '%s' "$name_val" | sed 's/\\/\\\\/g; s/"/\\"/g')
  local put_resp
  put_resp=$(curl -s "${AP_CURL_OPTS[@]}" -X PUT "${AP_PROTO}://localhost:${DAEMON_PORT}/api/sessions/name" \
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
if [ -f "$ACTIVE_FILE" ]; then
  # Verify tmux session still exists — stale active marker + dead tmux
  # would falsely report "already active" forever, blocking re-registration.
  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    HAS_RC=0
  else
    HAS_RC=$?
  fi
  if [ "${HAS_RC:-0}" -eq 1 ]; then
    # Tmux dead — clean up stale markers and proceed to register
    rm -f "$ACTIVE_FILE"
  else
    # Verify daemon actually holds this session. Sweep force-unregister
    # can nuke it when a stale dir shares the same sessionId (reopened
    # Claude session gets same session_id, different tmux).
    DAEMON_SESSIONS=$(curl -s "${AP_CURL_OPTS[@]}" "${AP_PROTO}://localhost:${DAEMON_PORT}/api/sessions" 2>/dev/null || echo "[]")
    if ! echo "$DAEMON_SESSIONS" | grep -Fq "\"tmuxSession\":\"$TMUX_SESSION\""; then
      echo "Re-registering — daemon lost session (stale sweep)" >&2
      rm -f "$ACTIVE_FILE"
      # fall through to registration below
    else
      if [ -n "$SESSION_NAME" ]; then
        MY_SID=$(head -c 128 "${MY_DIR}/session" 2>/dev/null | tr -d '\n\r' || true)
        if [ -n "$MY_SID" ]; then
          _name_update "$MY_SID" "$SESSION_NAME" "$MY_DIR"
        fi
      fi
      echo "AirPrompt already active for this session."
      echo "Mobile URL: ${AP_PROTO}://${LAN_IP}:${DAEMON_PORT}"
      exit 0
    fi
  fi
fi

# ── Register with daemon ────────────────────────────────────────────
# JSON-escape all string fields to prevent injection from special chars in paths
_json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
ESC_CWD=$(_json_escape "$ORIG_PWD")
ESC_SESSION=$(_json_escape "$TMUX_SESSION")
REG_PAYLOAD="{\"sessionId\":\"${SESSION_ID}\",\"cwd\":\"${ESC_CWD}\",\"tmuxSession\":\"${ESC_SESSION}\",\"providerId\":\"${PROVIDER}\""
if [ -n "$SESSION_NAME" ]; then
  SESSION_NAME=$(echo "$SESSION_NAME" | tr -cd 'a-zA-Z0-9 _-' | head -c 64)
  [ -n "$SESSION_NAME" ] || SESSION_NAME=""
  ESCAPED_NAME=$(_json_escape "$SESSION_NAME")
  REG_PAYLOAD="${REG_PAYLOAD},\"name\":\"${ESCAPED_NAME}\""
fi
REG_PAYLOAD="${REG_PAYLOAD}}"

RESP=$(curl -s "${AP_CURL_OPTS[@]}" -X POST "${AP_PROTO}://localhost:${DAEMON_PORT}/api/sessions/register" \
  -H "Content-Type: application/json" \
  -d "$REG_PAYLOAD" || echo "")

if echo "$RESP" | grep -q '"ok":true'; then
  mkdir -p "$MY_DIR"
  echo "${AP_PROTO}://${LAN_IP}:${DAEMON_PORT}" > "${MY_DIR}/url"
  echo "$SESSION_ID" > "${MY_DIR}/session"
  echo "$TMUX_SESSION" > "${MY_DIR}/tmux"
  echo "$PROVIDER" > "${MY_DIR}/provider"
  touch "$ACTIVE_FILE"
  [ "${CREATED_SESSION:-}" = "true" ] && touch "${MY_DIR}/mirror"
  if [ -n "$SESSION_NAME" ]; then
    # Registration already stores name on daemon; just persist to disk
    echo "$SESSION_NAME" > "${MY_DIR}/name"
    _persist_project_name "$SESSION_NAME"
    echo "Session name: $SESSION_NAME"
  fi
  echo "AirPrompt session registered: $SESSION_ID"
  echo "Mobile URL: ${AP_PROTO}://${LAN_IP}:${DAEMON_PORT}"
elif echo "$RESP" | grep -q '"Session already registered"'; then
  mkdir -p "$MY_DIR"
  echo "${AP_PROTO}://${LAN_IP}:${DAEMON_PORT}" > "${MY_DIR}/url"
  echo "$SESSION_ID" > "${MY_DIR}/session"
  echo "$TMUX_SESSION" > "${MY_DIR}/tmux"
  echo "$PROVIDER" > "${MY_DIR}/provider"
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
if _safe_rm_rf "$SESSIONS_DIR"; then
  for d in "$SESSIONS_DIR"/*/; do
    [ -d "$d" ] || continue
    DN=$(basename "$d")
    [ "$DN" = "${PROVIDER}-${SAFE_TMUX}" ] && continue
    # Read real tmux name from dir — dir name is sanitized,
    # real name may differ (e.g. "My Session!" vs "MySession").
    REAL_TMUX=$(head -c 128 "${d}/tmux" 2>/dev/null | tr -d '\n\r' || true)
    [ -z "$REAL_TMUX" ] && REAL_TMUX="$DN"
    tmux has-session -t "$REAL_TMUX" 2>/dev/null && HAS_SESSION_RC=0 || HAS_SESSION_RC=$?
    if [ "$HAS_SESSION_RC" -eq 0 ]; then
      : # session alive — skip
    elif [ "$HAS_SESSION_RC" -eq 1 ]; then
      # Only delete if tmux explicitly says "no session" (exit code 1).
      # Other non-zero codes = tmux error/timeout — don't touch (safe).
      echo "Cleaning up dead session dir: $DN" >&2
      # Read session ID from the session file (not from dir name)
      SID=$(head -c 128 "${d}/session" 2>/dev/null | tr -d '\n\r' || true)
      [ -z "$SID" ] && SID=$(echo "$DN" | tr -cd 'a-zA-Z0-9_-')
      curl -s "${AP_CURL_OPTS[@]}" -X POST "${AP_PROTO}://localhost:${DAEMON_PORT}/api/sessions/unregister" \
        -H "Content-Type: application/json" \
        -d "{\"sessionId\":\"${SID}\"}" > /dev/null 2>&1 || true
      rm -rf "$d"
    fi
  done
fi
