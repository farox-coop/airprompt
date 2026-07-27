#!/bin/bash
# airprompt-name.sh — Name (or rename) the current AirPrompt session.
# Use: /airprompt name <something>
#      /airprompt name         (clears name)
set -euo pipefail

# ── Help guard ─────────────────────────────────────────────────────────
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  echo "Usage: bin/airprompt name [<text>]"
  echo ""
  echo "  Set display name for current session (shown in web UI session list)."
  echo "  Empty text clears the name."
  echo ""
  echo "This is an internal script. Use 'bin/airprompt name <text>' directly."
  exit 0
fi

DAEMON_PORT="${PORT:-${AIRPROMPT_PORT:-3210}}"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SESSIONS_DIR="${CONFIG_DIR}/.airprompt-sessions"

NAME="${1:-}"

# ── Detect protocol ──────────────────────────────────────────────────
CERT_FILE="${CONFIG_DIR}/airprompt-cert.pem"
KEY_FILE="${CONFIG_DIR}/airprompt-key.pem"
PROTO="http"
CURL_OPTS="-s"
if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
  PROTO="https"
  CURL_OPTS="-s -k"
fi

# ── Resolve current tmux session ─────────────────────────────────────
CURRENT_TMUX=""
if [ -n "${TMUX:-}" ]; then
  CURRENT_TMUX=$(tmux display-message -p '#S' 2>/dev/null || true)
  if echo "$CURRENT_TMUX" | grep -q '^airprompt-web-'; then
    CURRENT_TMUX=$(tmux display-message -p '#{session_group}' 2>/dev/null | tr -d '\n\r')
  fi
fi

# ── Resolve per-session dir and session ID ───────────────────────────
MY_DIR=""
SESSION_ID=""
# Sanitize to match dir name created by airprompt-on / activate (same: tr -cd 'a-zA-Z0-9_.-')
SAFE_NAME=$(printf '%s' "$CURRENT_TMUX" | tr -cd 'a-zA-Z0-9_.-')
if [ -n "$SAFE_NAME" ] && [ -d "${SESSIONS_DIR}/${SAFE_NAME}" ]; then
  MY_DIR="${SESSIONS_DIR}/${SAFE_NAME}"
  SESSION_ID=$(head -c 128 "${MY_DIR}/session" 2>/dev/null | tr -d '\n\r')
fi

if [ -z "$SESSION_ID" ]; then
  echo "AirPrompt: no active session. Run /airprompt on first." >&2
  exit 1
fi

# ── Set name via API ──────────────────────────────────────────────────
API_URL="${PROTO}://localhost:${DAEMON_PORT}"
ESC_NAME=$(printf '%s' "$NAME" | sed 's/\\/\\\\/g; s/"/\\"/g')
RESP=$(curl $CURL_OPTS -s -X PUT "${API_URL}/api/sessions/name" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"${SESSION_ID}\",\"name\":\"${ESC_NAME}\"}")

if echo "$RESP" | grep -q '"ok":true'; then
  NEW_NAME=$(echo "$RESP" | grep -o '"name":"[^"]*"' | head -1 | sed 's/"name":"//;s/"$//')
  if [ -n "$NEW_NAME" ]; then
    if [ -n "$MY_DIR" ]; then
      printf '%s\n' "$NEW_NAME" > "${MY_DIR}/name"
    fi
    echo "AirPrompt: session named '$NEW_NAME'"
  else
    if [ -n "$MY_DIR" ]; then
      rm -f "${MY_DIR}/name"
    fi
    echo "AirPrompt: session name cleared"
  fi
else
  echo "AirPrompt: failed to set name — $RESP" >&2
  exit 1
fi
