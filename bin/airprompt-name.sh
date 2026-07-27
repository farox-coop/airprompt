#!/bin/bash
# airprompt-name.sh — Name (or rename) the current AirPrompt session.
# Use: /airprompt name <something>
#      /airprompt name         (clears name)
set -euo pipefail

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
if [ -n "$CURRENT_TMUX" ] && [ -d "${SESSIONS_DIR}/${CURRENT_TMUX}" ]; then
  MY_DIR="${SESSIONS_DIR}/${CURRENT_TMUX}"
  SESSION_ID=$(head -c 128 "${MY_DIR}/session" 2>/dev/null | tr -d '\n\r')
fi

# Legacy fallback
if [ -z "$SESSION_ID" ] && [ -f "${CONFIG_DIR}/.airprompt-session" ]; then
  SESSION_ID=$(head -c 128 "${CONFIG_DIR}/.airprompt-session" 2>/dev/null | tr -d '\n\r')
fi

if [ -z "$SESSION_ID" ]; then
  echo "AirPrompt: no active session. Run /airprompt on first." >&2
  exit 1
fi

# ── Set name via API ──────────────────────────────────────────────────
API_URL="${PROTO}://localhost:${DAEMON_PORT}"
RESP=$(curl $CURL_OPTS -X PUT "${API_URL}/api/sessions/name" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"${SESSION_ID}\",\"name\":\"${NAME}\"}")

if echo "$RESP" | grep -q '"ok":true'; then
  NEW_NAME=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('name','') or '')" 2>/dev/null || echo "")
  if [ -n "$NEW_NAME" ]; then
    if [ -n "$MY_DIR" ]; then
      echo "$NEW_NAME" > "${MY_DIR}/name"
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
