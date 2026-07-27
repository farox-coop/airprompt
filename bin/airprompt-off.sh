#!/bin/bash
set -euo pipefail

DAEMON_PORT="${PORT:-${AIRPROMPT_PORT:-3210}}"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
MARKER="${CONFIG_DIR}/.airprompt-active"
URL_FILE="${CONFIG_DIR}/.airprompt-url"
SESSION_FILE="${CONFIG_DIR}/.airprompt-session"

SESSION_ID="${1:-}"

# Auto-discover session ID from saved file if not provided
if [ -z "$SESSION_ID" ] && [ -f "$SESSION_FILE" ]; then
  SESSION_ID=$(head -c 128 "$SESSION_FILE" 2>/dev/null | tr -d '\n\r')
fi

# Idempotent: if already off, exit silently
if [ -z "$SESSION_ID" ]; then
  # No session file, no markers — already clean
  echo "AirPrompt: nothing to unregister (already off)."
  exit 0
fi

# ── Detect protocol ──────────────────────────────────────────────────
CERT_FILE="${CONFIG_DIR}/airprompt-cert.pem"
KEY_FILE="${CONFIG_DIR}/airprompt-key.pem"
PROTO="http"
CURL_OPTS=""
if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
  PROTO="https"
  CURL_OPTS="-k"
fi

# ── Kill airprompt tmux session before unregister ──────────────────
# Server-side guard rejects unregister if tmux is alive. Kill our
# managed tmux first (only airprompt- prefixed, never real Claude sessions).
TMUX_ACTIVE_FILE="${CONFIG_DIR}/.airprompt-tmux-active"
if [ -f "$TMUX_ACTIVE_FILE" ]; then
  TMUX_TO_KILL=$(head -c 128 "$TMUX_ACTIVE_FILE" 2>/dev/null | tr -d '\n\r')
  if [ -n "$TMUX_TO_KILL" ] && echo "$TMUX_TO_KILL" | grep -q '^airprompt-'; then
    tmux kill-session -t "$TMUX_TO_KILL" 2>/dev/null || true
    sleep 0.2
  fi
fi

# ── Unregister from daemon ──────────────────────────────────────────
if ! curl -s $CURL_OPTS -X POST "${PROTO}://localhost:${DAEMON_PORT}/api/sessions/unregister" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"${SESSION_ID}\"}" > /dev/null; then
  echo "Warning: failed to contact daemon, removing local markers anyway" >&2
fi

# ── Remove markers ──────────────────────────────────────────────────
rm -f "$MARKER" "$URL_FILE" "$SESSION_FILE" "${CONFIG_DIR}/.airprompt-tmux-active"

# ── Stop daemon if no sessions remain ────────────────────────────────
REMAINING=$(curl -s $CURL_OPTS "${PROTO}://localhost:${DAEMON_PORT}/api/sessions" 2>/dev/null || echo "[]")
REMAINING_COUNT=$(echo "$REMAINING" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
if [ "$REMAINING_COUNT" = "0" ]; then
  PID_FILE="/tmp/airprompt-server.pid"
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID" 2>/dev/null || true
      echo "Daemon stopped (no sessions remaining)"
    fi
    rm -f "$PID_FILE"
  fi
fi

echo "AirPrompt session unregistered: $SESSION_ID"
