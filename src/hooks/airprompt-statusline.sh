#!/bin/bash
# airprompt-statusline.sh — StatusLine hook.
# Shows [airprompt: https://<IP>:3210] badge only in the registered session.
# Per-session isolation: reads ~/.airprompt/sessions/{provider}-{tmux-name}/url
# Multiple IDE sessions can coexist without fighting over global files.
set -euo pipefail

SESSIONS_DIR="${AIRPROMPT_SESSIONS_DIR:-$HOME/.airprompt/sessions}"

# Auto-detect provider if not set (statusline runs standalone, not via dispatcher)
if [ -z "${AIRPROMPT_PROVIDER:-}" ]; then
  for prov in claude codex cursor windsurf; do
    if command -v "$prov" >/dev/null 2>&1; then
      AIRPROMPT_PROVIDER="$prov"
      break
    fi
  done
fi
PROVIDER="${AIRPROMPT_PROVIDER:-}"

# No provider detected → no badge output (silent, safe)
if [ -z "$PROVIDER" ]; then
  exit 0
fi

# ── Test override: set fake tmux session name so tests don't need a real tmux
CURRENT_TMUX="${AIRPROMPT_TEST_TMUX:-}"

# ── Detect current tmux session ─────────────────────────────────────
if [ -z "$CURRENT_TMUX" ] && [ -n "${TMUX:-}" ]; then
  CURRENT_TMUX=$(tmux display-message -p '#S' 2>/dev/null || true)
  # Inside a web proxy session — resolve to parent via tmux group name
  if echo "$CURRENT_TMUX" | grep -q '^airprompt-web-'; then
    CURRENT_TMUX=$(tmux display-message -p '#{session_group}' 2>/dev/null | tr -d '\n\r' || true)
  fi
fi

# ── Per-session marker (primary) ─────────────────────────────────────
if [ -n "$CURRENT_TMUX" ]; then
  # Sanitize: tmux names can contain dots/dashes/underscores/alphanum.
  # Replace any chars that are unsafe for a path component.
  SAFE_NAME=$(printf '%s' "$CURRENT_TMUX" | tr -cd 'a-zA-Z0-9_.-')
  # Try exact provider dir first, then scan as fallback
  MY_DIR=""
  if [ -d "$SESSIONS_DIR" ]; then
    if [ -n "$PROVIDER" ] && [ -d "${SESSIONS_DIR}/${PROVIDER}-${SAFE_NAME}" ] && [ -f "${SESSIONS_DIR}/${PROVIDER}-${SAFE_NAME}/url" ]; then
      MY_DIR="${SESSIONS_DIR}/${PROVIDER}-${SAFE_NAME}"
    else
      for d in "$SESSIONS_DIR"/*-"$SAFE_NAME"; do
        if [ -d "$d" ] && [ -f "$d/url" ]; then
          MY_DIR="$d"
          break
        fi
      done
    fi
  fi
  if [ -z "$MY_DIR" ]; then
    exit 0
  fi
  URL_FILE="${MY_DIR}/url"
  NAME_FILE="${MY_DIR}/name"
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

