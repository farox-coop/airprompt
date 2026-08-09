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

source "$(dirname "$0")/lib/protocol.sh"

SESSIONS_DIR="${AIRPROMPT_SESSIONS_DIR:-$HOME/.airprompt/sessions}"
AIRPROMPT_DIR="${AIRPROMPT_STATE_DIR:-$HOME/.airprompt/state}"
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
_safe_rm_rf "${SESSIONS_DIR}" && { rm -rf "${SESSIONS_DIR}" 2>/dev/null || true; }
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

# 3. Session directories already removed as part of SESSIONS_DIR above

# 4. Remove ~/bin/ symlinks and provider wrappers
HOME_BIN="$HOME/bin"
if [ -d "$HOME_BIN" ]; then
  # Symlinks created by sync.sh / install.js
  for name in airprompt airprompt-launch; do
    link_path="$HOME_BIN/$name"
    if [ -L "$link_path" ] || [ -f "$link_path" ]; then
      rm -f "$link_path"
      echo "  removed $link_path"
    fi
  done
  # Provider wrappers (real files)
  for name in airprompt-claude airprompt-codex airprompt-cursor airprompt-windsurf; do
    wrapper_path="$HOME_BIN/$name"
    if [ -f "$wrapper_path" ]; then
      rm -f "$wrapper_path"
      echo "  removed $wrapper_path"
    fi
  done
fi

# 5. Remove state directory (sessions + daemon data). If ~/.airprompt is the
#    install dir (contains server.js), only remove state/sessions subdirs so
#    the autostart hook target (src/hooks/airprompt-activate.js) survives.
AIRPROMPT_INSTALL="${AIRPROMPT_INSTALL_DIR:-$HOME/.airprompt}"
if [ -d "$AIRPROMPT_INSTALL" ]; then
  if [ -f "$AIRPROMPT_INSTALL/server.js" ]; then
    # ~/.airprompt is the install dir — only remove state subdirs
    echo "  (preserving install files in $AIRPROMPT_INSTALL — removing only state/sessions)"
    _safe_rm_rf "$AIRPROMPT_INSTALL/state" && { rm -rf "$AIRPROMPT_INSTALL/state" && echo "  removed state dir"; } || true
    _safe_rm_rf "$AIRPROMPT_INSTALL/sessions" && { rm -rf "$AIRPROMPT_INSTALL/sessions" && echo "  removed sessions dir"; } || true
  else
    _safe_rm_rf "$AIRPROMPT_INSTALL" && { rm -rf "$AIRPROMPT_INSTALL" && echo "  removed $AIRPROMPT_INSTALL"; }
  fi
fi

# 6. Remove logs
rm -f "$LOG_FILE"

echo "AirPrompt: clean. Ready for /airprompt on."
