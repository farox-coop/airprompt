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
# USAGE (run from a SEPARATE terminal, NOT from within Claude itself):
#   1. Find Claude's PID:  ps aux | grep claude
#   2. Run:  bash bin/airprompt-attach.sh <PID>
#   3. Your Claude session is now inside tmux + registered with AirPrompt
#   4. Reconnect locally:  tmux attach -t airprompt-<id>
#   5. Open on phone:  https://<LAN-IP>:3210
#
# NOTE: Running this from WITHIN Claude won't work — reptyr cannot steal
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
DAEMON_PORT="${PORT:-${AIRPROMPT_PORT:-3210}}"
DAEMON_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SESSIONS_DIR="${CONFIG_DIR}/.airprompt-sessions"

# ── Detect protocol ─────────────────────────────────────────────────
CERT_FILE="${CONFIG_DIR}/airprompt-cert.pem"
KEY_FILE="${CONFIG_DIR}/airprompt-key.pem"
PROTO="http"
CURL_OPTS=""
if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
  PROTO="https"
  CURL_OPTS="-k"
fi
API_URL="${PROTO}://localhost:${DAEMON_PORT}"

# ── Target PID ─────────────────────────────────────────────────────
TARGET_PID="${1:-}"
if [ -z "$TARGET_PID" ]; then
  echo "Usage: $0 <PID>" >&2
  echo "  Find Claude's PID: ps aux | grep claude" >&2
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
  echo "Fallback: empty tmux session registered. Start Claude inside it:"
  echo "  tmux send-keys -t $TMUX_SESSION 'claude' Enter"
fi

# ── Ensure daemon is running ─────────────────────────────────────────
if ! curl -s $CURL_OPTS "${API_URL}/api/sessions" > /dev/null 2>&1; then
  echo "Starting AirPrompt daemon..."
  cd "$DAEMON_DIR"
  node server.js > /tmp/airprompt.log 2>&1 &
  for i in $(seq 1 20); do
    if curl -s $CURL_OPTS "${API_URL}/api/sessions" > /dev/null 2>&1; then break; fi
    if ! kill -0 $! 2>/dev/null; then
      echo "Error: server process died. Check /tmp/airprompt.log" >&2
      exit 1
    fi
    sleep 0.5
  done
  cd "$ORIG_PWD"
fi

# ── Register with daemon ────────────────────────────────────────────
RESP=$(curl -s $CURL_OPTS -X POST "${API_URL}/api/sessions/register" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"${SESSION_ID}\",\"cwd\":\"${ORIG_PWD}\",\"tmuxSession\":\"${TMUX_SESSION}\"}")

if echo "$RESP" | grep -q '"ok":true'; then
  mkdir -p "$CONFIG_DIR"
  LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
  [ -z "$LAN_IP" ] && LAN_IP="localhost"

  MY_DIR="${SESSIONS_DIR}/${TMUX_SESSION}"
  mkdir -p "$MY_DIR"
  echo "${PROTO}://${LAN_IP}:${DAEMON_PORT}" > "${MY_DIR}/url"
  echo "$SESSION_ID" > "${MY_DIR}/session"
  echo "$TMUX_SESSION" > "${MY_DIR}/tmux"
  touch "${MY_DIR}/active"
  echo ""
  echo "AirPrompt session registered: $SESSION_ID"
  echo "Mobile URL: ${PROTO}://${LAN_IP}:${DAEMON_PORT}"
  echo ""
  echo "Reconnect locally: tmux attach -t $TMUX_SESSION"
else
  echo "Registration failed: $RESP" >&2
  exit 1
fi
