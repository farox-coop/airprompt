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

if [ -z "$SESSION_ID" ]; then
  echo "Usage: $0 <sessionId>" >&2
  echo "No saved session found. Pass sessionId from registration output." >&2
  exit 1
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

# ── Unregister from daemon ──────────────────────────────────────────
if ! curl -s $CURL_OPTS -X POST "${PROTO}://localhost:${DAEMON_PORT}/api/sessions/unregister" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"${SESSION_ID}\"}" > /dev/null; then
  echo "Warning: failed to contact daemon, removing local markers anyway" >&2
  # Kill tmux session locally since server can't do it
  tmux kill-session -t "airprompt-${SESSION_ID}" 2>/dev/null || true
fi

# ── Remove markers ──────────────────────────────────────────────────
rm -f "$MARKER" "$URL_FILE" "$SESSION_FILE"

echo "AirPrompt session unregistered: $SESSION_ID"
