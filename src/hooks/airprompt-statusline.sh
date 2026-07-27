#!/bin/bash
# airprompt-statusline.sh — StatusLine hook.
# Shows [airprompt: https://<IP>:3210] badge only in the registered session.
# Session-aware: compares current tmux session name with registered one.
set -euo pipefail

CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
MARKER="${CONFIG_DIR}/.airprompt-active"
URL_FILE="${CONFIG_DIR}/.airprompt-url"
TMUX_ACTIVE_FILE="${CONFIG_DIR}/.airprompt-tmux-active"

# Session-specific check: only show badge if this tmux session
# is the one that ran /airprompt on.
if [ -f "$TMUX_ACTIVE_FILE" ] && [ ! -L "$TMUX_ACTIVE_FILE" ]; then
  REGISTERED_TMUX=$(head -c 128 "$TMUX_ACTIVE_FILE" 2>/dev/null | tr -d '\n\r')
  CURRENT_TMUX=""
  if [ -n "${TMUX:-}" ]; then
    CURRENT_TMUX=$(tmux display-message -p '#S' 2>/dev/null || true)
    # Inside a web proxy session — resolve to parent via tmux group name
    if echo "$CURRENT_TMUX" | grep -q '^airprompt-web-'; then
      CURRENT_TMUX=$(tmux display-message -p '#{session_group}' 2>/dev/null | tr -d '\n\r')
    fi
  fi
  # Only show badge if this tmux session matches the registered one
  if [ "$CURRENT_TMUX" != "$REGISTERED_TMUX" ]; then
    exit 0
  fi
  # Tmux session matches — show badge using URL file if available
  if [ -f "$URL_FILE" ] && [ ! -L "$URL_FILE" ]; then
    URL=$(head -c 256 "$URL_FILE" 2>/dev/null | tr -d '\n\r' | tr -d '\000-\037\177')
    printf '\033[33m[airprompt: %s]\033[0m' "$URL"
  fi
  exit 0
fi

# Fallback: global marker for non-tmux sessions (VS Code direct Claude)
# Security: refuse symlinks (local attacker can't point at sensitive files)
if [ -f "$MARKER" ] && [ -f "$URL_FILE" ] && [ ! -L "$MARKER" ] && [ ! -L "$URL_FILE" ]; then
  URL=$(head -c 256 "$URL_FILE" 2>/dev/null | tr -d '\n\r' | tr -d '\000-\037\177')
  printf '\033[33m[airprompt: %s]\033[0m' "$URL"
fi
