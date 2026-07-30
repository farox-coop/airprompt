#!/bin/bash
# airprompt-clean.sh — Tear down EVERYTHING. Start from scratch.
# Use: /airprompt clean
set -euo pipefail

# ── Help guard ─────────────────────────────────────────────────────────
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  echo "Usage: bin/airprompt clean"
  echo ""
  echo "  Full teardown: kill daemon, remove all airprompt tmux sessions,"
  echo "  delete all per-session marker directories and logs."
  echo "  WARNING: destructive — removes everything AirPrompt-related."
  echo ""
  echo "This is an internal script. Use 'bin/airprompt clean' directly."
  exit 0
fi

CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SESSIONS_DIR="${CONFIG_DIR}/.airprompt/sessions"
AIRPROMPT_DIR="${CONFIG_DIR}/.airprompt"
PID_FILE="${AIRPROMPT_PID_FILE:-/tmp/airprompt-server.pid}"
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
rm -f "${AIRPROMPT_DIR}/daemon.json" && echo "  daemon.json removed" || true
rm -rf "${AIRPROMPT_DIR}/sessions" 2>/dev/null || true
rmdir "${AIRPROMPT_DIR}" 2>/dev/null || true
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

# 4. Remove logs
rm -f "$LOG_FILE"

echo "  markers removed: $MARKERS_REMOVED"
echo "AirPrompt: clean. Ready for /airprompt on."
