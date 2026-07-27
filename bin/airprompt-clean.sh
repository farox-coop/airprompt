#!/bin/bash
# airprompt-clean.sh — Tear down EVERYTHING. Start from scratch.
# Use: /airprompt clean
set -euo pipefail

CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
PID_FILE="/tmp/airprompt-server.pid"
LOG_FILE="/tmp/airprompt.log"

echo "AirPrompt: tearing down everything..."

# 1. Kill daemon tmux session (primary) + PID fallback
tmux kill-session -t airprompt-daemon 2>/dev/null && echo "  daemon tmux session killed" || true
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    echo "  daemon stopped (PID $PID)"
  fi
  rm -f "$PID_FILE"
fi

# 2. Kill all airprompt tmux sessions
# Use mapfile to avoid subshell issues with pipe → while read.
if command -v tmux &>/dev/null; then
  mapfile -t AIRPROMPT_SESSIONS < <(tmux ls 2>/dev/null | grep '^airprompt-' | cut -d: -f1 || true)
  for s in "${AIRPROMPT_SESSIONS[@]}"; do
    [ -z "$s" ] && continue
    tmux kill-session -t "$s" 2>/dev/null || true
    echo "  tmux session killed: $s"
  done
fi

# 3. Remove all markers
MARKERS_REMOVED=0
for f in \
  "$CONFIG_DIR/.airprompt-active" \
  "$CONFIG_DIR/.airprompt-url" \
  "$CONFIG_DIR/.airprompt-session" \
  "$CONFIG_DIR/.airprompt-tmux-active" \
  "$CONFIG_DIR/.airprompt-tmux-session"; do
  if [ -f "$f" ]; then
    rm -f "$f"
    MARKERS_REMOVED=$((MARKERS_REMOVED + 1))
  fi
done

# 4. Remove logs
rm -f "$LOG_FILE"

echo "  markers removed: $MARKERS_REMOVED"
echo "AirPrompt: clean. Ready for /airprompt on."
