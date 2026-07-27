#!/bin/bash
set -euo pipefail

DAEMON_PORT="${PORT:-${AIRPROMPT_PORT:-3210}}"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
MARKER="${CONFIG_DIR}/.airprompt-active"
URL_FILE="${CONFIG_DIR}/.airprompt-url"
SESSION_FILE="${CONFIG_DIR}/.airprompt-session"
TMUX_ACTIVE_FILE="${CONFIG_DIR}/.airprompt-tmux-active"
TMUX_SESSION_FILE="${CONFIG_DIR}/.airprompt-tmux-session"

SESSION_ID="${1:-}"

# Auto-discover session ID from saved file if not provided
if [ -z "$SESSION_ID" ] && [ -f "$SESSION_FILE" ]; then
  SESSION_ID=$(head -c 128 "$SESSION_FILE" 2>/dev/null | tr -d '\n\r')
fi

# Idempotent: if already off, exit silently — UNLESS stale markers remain.
if [ -z "$SESSION_ID" ]; then
  # Check if any stale markers remain (session file missing but other markers present).
  HAS_MARKERS=false
  for f in "$MARKER" "$URL_FILE" "$SESSION_FILE" "$TMUX_ACTIVE_FILE" "$TMUX_SESSION_FILE"; do
    [ -f "$f" ] && HAS_MARKERS=true
  done
  if ! $HAS_MARKERS; then
    echo "AirPrompt: nothing to unregister (already off)."
    exit 0
  fi
  echo "AirPrompt: stale markers found, cleaning up..."
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
if [ -f "$TMUX_ACTIVE_FILE" ]; then
  TMUX_TO_KILL=$(head -c 128 "$TMUX_ACTIVE_FILE" 2>/dev/null | tr -d '\n\r')
  if [ -n "$TMUX_TO_KILL" ] && echo "$TMUX_TO_KILL" | grep -q '^airprompt-'; then
    tmux kill-session -t "$TMUX_TO_KILL" 2>/dev/null || true
    sleep 0.2
  fi
fi

# ── Unregister from daemon ──────────────────────────────────────────
if [ -n "$SESSION_ID" ]; then
  if ! curl -s $CURL_OPTS -X POST "${PROTO}://localhost:${DAEMON_PORT}/api/sessions/unregister" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${SESSION_ID}\"}" > /dev/null; then
    echo "Warning: failed to contact daemon, removing local markers anyway" >&2
  fi
fi

# ── Remove markers ──────────────────────────────────────────────────
rm -f "$MARKER" "$URL_FILE" "$SESSION_FILE" "$TMUX_ACTIVE_FILE" "$TMUX_SESSION_FILE"

# ── Stop daemon if no sessions remain ────────────────────────────────
REMAINING=$(curl -s $CURL_OPTS "${PROTO}://localhost:${DAEMON_PORT}/api/sessions" 2>/dev/null || echo "[]")
REMAINING_COUNT=$(echo "$REMAINING" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
if [ "$REMAINING_COUNT" = "0" ]; then
  # Kill daemon tmux session if running
  if tmux has-session -t airprompt-daemon 2>/dev/null; then
    tmux kill-session -t airprompt-daemon 2>/dev/null || true
  fi
  PID_FILE="/tmp/airprompt-server.pid"
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
  echo "Daemon stopped (no sessions remaining)"
fi

if [ -n "$SESSION_ID" ]; then
  echo "AirPrompt session unregistered: $SESSION_ID"
else
  echo "AirPrompt cleaned up."
fi
