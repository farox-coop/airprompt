#!/bin/bash
# airprompt-attach — Attach a running process to a tmux session via reptyr,
# then register it with AirPrompt for remote mobile access.
#
# Dependencies: tmux, reptyr, curl, node
#   sudo apt install tmux reptyr
#
# SECURITY: reptyr uses ptrace. On Ubuntu with kernel.yama.ptrace_scope=1,
# only child processes can be traced. Set scope=0 for full access:
#   echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope
#
# USAGE (run from a SEPARATE terminal, NOT from within the IDE itself):
#   1. Find the IDE process PID:  ps aux | grep -E 'claude|codex|cursor'
#   2. Run:  bash bin/airprompt-attach.sh <PID>
#   3. Your IDE session is now inside tmux + registered with AirPrompt
#   4. Reconnect locally:  tmux attach -t airprompt-<id>
#   5. Open on phone:  https://<LAN-IP>:3210
#
# NOTE: Running this from WITHIN the IDE won't work — reptyr cannot steal
# the process that's running the script itself. Use a second terminal.

set -euo pipefail

# ── Dependency check ───────────────────────────────────────────────
for cmd in tmux reptyr curl node; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: '$cmd' is required but not installed." >&2
    case "$cmd" in
      tmux)   echo "  sudo apt install tmux" >&2 ;;
      reptyr) echo "  sudo apt install reptyr" >&2 ;;
      curl)   echo "  sudo apt install curl" >&2 ;;
      node)   echo "  Node.js required: https://nodejs.org" >&2 ;;
    esac
    exit 1
  fi
done

# ── Config ─────────────────────────────────────────────────────────
DAEMON_PORT="${AIRPROMPT_PORT:-3210}"
DAEMON_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SESSIONS_DIR="${AIRPROMPT_SESSIONS_DIR:-$HOME/.airprompt/sessions}"
# Auto-detect provider if not set (attach.sh can be invoked directly)
if [ -z "${AIRPROMPT_PROVIDER:-}" ]; then
  for prov in claude codex cursor windsurf; do
    if command -v "$prov" >/dev/null 2>&1; then
      export AIRPROMPT_PROVIDER="$prov"
      break
    fi
  done
fi
if [ -z "${AIRPROMPT_PROVIDER:-}" ]; then
  echo "AirPrompt: no provider detected and AIRPROMPT_PROVIDER not set." >&2
  echo "  Install claude (codex, cursor, windsurf coming soon)" >&2
  echo "  Or set AIRPROMPT_PROVIDER manually." >&2
  exit 1
fi
PROVIDER="${AIRPROMPT_PROVIDER}"

# ── Protocol detection (shared lib) ────────────────────────────────────
source "$(dirname "$0")/lib/protocol.sh"
detect_protocol
DAEMON_PORT="$AP_PORT"
API_URL="${AP_PROTO}://localhost:${DAEMON_PORT}"

# ── Target PID ─────────────────────────────────────────────────────
TARGET_PID="${1:-}"
if [ -z "$TARGET_PID" ]; then
  echo "Usage: $0 <PID>" >&2
  echo "  Find IDE PID: ps aux | grep -E 'claude|codex|cursor'" >&2
  exit 1
fi

if ! kill -0 "$TARGET_PID" 2>/dev/null; then
  echo "Error: PID $TARGET_PID not found or not accessible" >&2
  exit 1
fi

echo "Target process: PID $TARGET_PID ($(ps -o comm= -p "$TARGET_PID" 2>/dev/null || echo unknown))"

# ── Create tmux session ────────────────────────────────────────────
ORIG_PWD="$PWD"
SESSION_ID="$(date +%s)-$$-$(basename "$ORIG_PWD" | tr -cd 'a-zA-Z0-9-_')"
TMUX_SESSION="airprompt-${SESSION_ID}"

echo "Creating tmux session: $TMUX_SESSION"
tmux new-session -d -s "$TMUX_SESSION" -c "$ORIG_PWD"

# ── Steal process into tmux via reptyr ─────────────────────────────
# reptyr must run FROM INSIDE the tmux session to capture the target TTY.
# We use tmux send-keys to execute reptyr inside the session.
echo "Stealing PID $TARGET_PID into tmux session..."
tmux send-keys -t "$TMUX_SESSION" "reptyr $TARGET_PID" Enter
sleep 1

# Check if reptyr succeeded by looking at the pane output
PANELINE=$(tmux capture-pane -t "$TMUX_SESSION" -p | tail -5)
if echo "$PANELINE" | grep -q "Unable to attach\|ptrace\|denied\|error"; then
  echo "Warning: reptyr may have failed."
  echo "  ptrace_scope=$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo unknown)"
  echo "  Try: echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope"
  echo ""
  echo "Fallback: empty tmux session registered. Start your IDE inside it:"
  echo "  tmux send-keys -t $TMUX_SESSION '$PROVIDER' Enter"
fi

# ── Ensure daemon is running ─────────────────────────────────────────
if ! curl -s "${AP_CURL_OPTS[@]}" "${API_URL}/api/sessions" > /dev/null 2>&1; then
  echo "Starting AirPrompt daemon..."
  cd "$DAEMON_DIR"
  nohup node server.js > /tmp/airprompt.log 2>&1 &
  DAEMON_PID=$!
  disown "$DAEMON_PID" 2>/dev/null || true
  for _ in $(seq 1 20); do
    if curl -s "${AP_CURL_OPTS[@]}" "${API_URL}/api/sessions" > /dev/null 2>&1; then break; fi
    if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
      echo "Error: server process died. Check /tmp/airprompt.log" >&2
      exit 1
    fi
    sleep 0.5
  done
  cd "$ORIG_PWD"
fi

# ── Register with daemon ────────────────────────────────────────────
# JSON-escape fields to prevent injection from special chars in paths
_json_esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
ESC_CWD=$(_json_esc "$ORIG_PWD")
ESC_TMUX=$(_json_esc "$TMUX_SESSION")
ESC_PROV=$(_json_esc "$PROVIDER")
RESP=$(curl -s "${AP_CURL_OPTS[@]}" -X POST "${API_URL}/api/sessions/register" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"${SESSION_ID}\",\"cwd\":\"${ESC_CWD}\",\"tmuxSession\":\"${ESC_TMUX}\",\"providerId\":\"${ESC_PROV}\"}" || echo "")

if echo "$RESP" | grep -q '"ok":true'; then
  LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  [ -z "$LAN_IP" ] && LAN_IP="localhost"

  MY_DIR="${SESSIONS_DIR}/${PROVIDER}-${TMUX_SESSION}"
  mkdir -p "$MY_DIR"
  echo "${AP_PROTO}://${LAN_IP}:${DAEMON_PORT}" > "${MY_DIR}/url"
  echo "$SESSION_ID" > "${MY_DIR}/session"
  echo "$TMUX_SESSION" > "${MY_DIR}/tmux"
  echo "$PROVIDER" > "${MY_DIR}/provider"
  touch "${MY_DIR}/active"
  # Do NOT write mirror — attached sessions contain real IDE processes.
  # Only AirPrompt-created empty shells (on.sh CREATED_SESSION=true) get mirror.
  echo ""
  echo "AirPrompt session registered: $SESSION_ID"
  echo "Mobile URL: ${AP_PROTO}://${LAN_IP}:${DAEMON_PORT}"
  echo ""
  echo "Reconnect locally: tmux attach -t $TMUX_SESSION"
else
  echo "Registration failed: $RESP" >&2
  exit 1
fi
