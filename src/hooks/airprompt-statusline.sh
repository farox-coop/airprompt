#!/bin/bash
# airprompt-statusline.sh — StatusLine hook.
# Shows [airprompt: https://<IP>:3210] badge only in the registered session.
# Per-session isolation: reads ~/.claude/.airprompt-sessions/{tmux-name}/url
# Multiple Claude sessions can coexist without fighting over global files.
set -euo pipefail

CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SESSIONS_DIR="${CONFIG_DIR}/.airprompt-sessions"

# ── Detect current tmux session ─────────────────────────────────────
CURRENT_TMUX=""
if [ -n "${TMUX:-}" ]; then
  CURRENT_TMUX=$(tmux display-message -p '#S' 2>/dev/null || true)
  # Inside a web proxy session — resolve to parent via tmux group name
  if echo "$CURRENT_TMUX" | grep -q '^airprompt-web-'; then
    CURRENT_TMUX=$(tmux display-message -p '#{session_group}' 2>/dev/null | tr -d '\n\r')
  fi
fi

# ── Per-session marker (primary) ─────────────────────────────────────
if [ -n "$CURRENT_TMUX" ]; then
  # Sanitize: tmux names can contain dots/dashes/underscores/alphanum.
  # Replace any chars that are unsafe for a path component.
  SAFE_NAME=$(printf '%s' "$CURRENT_TMUX" | tr -cd 'a-zA-Z0-9_.-')
  URL_FILE="${SESSIONS_DIR}/${SAFE_NAME}/url"
  NAME_FILE="${SESSIONS_DIR}/${SAFE_NAME}/name"
  if [ -f "$URL_FILE" ] && [ ! -L "$URL_FILE" ]; then
    URL=$(head -c 256 "$URL_FILE" 2>/dev/null | tr -d '\n\r' | tr -d '\000-\037\177')
    if [ -n "$URL" ]; then
      if [ -f "$NAME_FILE" ] && [ ! -L "$NAME_FILE" ]; then
        NAME=$(head -c 64 "$NAME_FILE" 2>/dev/null | tr -d '\n\r' | tr -d '\000-\037\177')
        [ -n "$NAME" ] && printf '\033[33m[%s@%s]\033[0m' "$NAME" "$URL" || printf '\033[33m[AirPrompt: %s]\033[0m' "$URL"
      else
        printf '\033[33m[AirPrompt: %s]\033[0m' "$URL"
      fi
      exit 0
    fi
  fi
fi

