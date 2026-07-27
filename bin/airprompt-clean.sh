#!/bin/bash
# airprompt-clean.sh — Tear down EVERYTHING. Start from scratch.
# Use: /airprompt clean
set -euo pipefail

CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SESSIONS_DIR="${CONFIG_DIR}/.airprompt-sessions"
PID_FILE="/tmp/airprompt-server.pid"
LOG_FILE="/tmp/airprompt.log"

echo "AirPrompt: tearing down everything..."

# 1. Kill daemon: PID first (faster), then tmux session
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    # Safety: verify this PID actually is an airprompt server before killing.
    # Prevents killing a reused PID belonging to a different process.
    IS_AIRPROMPT=false
    if [ -r "/proc/$PID/cmdline" ]; then
      tr '\0' ' ' < "/proc/$PID/cmdline" | grep -q 'server\.js' && IS_AIRPROMPT=true
    fi
    if $IS_AIRPROMPT; then
      kill "$PID" 2>/dev/null || true
      # Wait for graceful shutdown
      for i in $(seq 1 10); do
        kill -0 "$PID" 2>/dev/null || break
        sleep 0.1
      done
      # Force kill if still alive
      kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null || true
      echo "  daemon stopped (PID $PID)"
    else
      echo "  PID $PID exists but is not airprompt — skipping kill (stale PID file)"
    fi
  fi
  rm -f "$PID_FILE"
fi
# Also kill daemon tmux session (airprompt-on.sh starts it this way)
tmux kill-session -t airprompt-daemon 2>/dev/null && echo "  daemon tmux session killed" || true

# 2. Kill all airprompt tmux sessions
if command -v tmux &>/dev/null; then
  mapfile -t AIRPROMPT_SESSIONS < <(tmux ls 2>/dev/null | grep '^airprompt-' | cut -d: -f1 || true)
  for s in "${AIRPROMPT_SESSIONS[@]}"; do
    [ -z "$s" ] && continue
    tmux kill-session -t "$s" 2>/dev/null || true
    echo "  tmux session killed: $s"
  done
fi

# 3. Remove all per-session directories
MARKERS_REMOVED=0
if [ -d "$SESSIONS_DIR" ]; then
  for d in "$SESSIONS_DIR"/*/; do
    [ -d "$d" ] || continue
    rm -rf "$d"
    MARKERS_REMOVED=$((MARKERS_REMOVED + 1))
  done
  rmdir "$SESSIONS_DIR" 2>/dev/null || true
fi

# 4. Remove legacy global markers
for f in \
  "$CONFIG_DIR/.airprompt-active" \
  "$CONFIG_DIR/.airprompt-url" \
  "$CONFIG_DIR/.airprompt-session" \
  "$CONFIG_DIR/.airprompt-tmux-active" \
  "$CONFIG_DIR/.airprompt-tmux-session" \
  "$CONFIG_DIR/.airprompt-name"; do
  if [ -f "$f" ]; then
    rm -f "$f"
    MARKERS_REMOVED=$((MARKERS_REMOVED + 1))
  fi
done

# 5. Remove logs
rm -f "$LOG_FILE"

echo "  markers removed: $MARKERS_REMOVED"
echo "AirPrompt: clean. Ready for /airprompt on."
