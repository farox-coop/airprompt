#!/bin/bash
set -euo pipefail

DAEMON_PORT="${PORT:-${AIRPROMPT_PORT:-3210}}"
CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SESSIONS_DIR="${CONFIG_DIR}/.airprompt-sessions"

# Legacy global marker paths (cleaned up during migration)
MARKER="${CONFIG_DIR}/.airprompt-active"
URL_FILE="${CONFIG_DIR}/.airprompt-url"
SESSION_FILE="${CONFIG_DIR}/.airprompt-session"
TMUX_ACTIVE_FILE="${CONFIG_DIR}/.airprompt-tmux-active"
TMUX_SESSION_FILE="${CONFIG_DIR}/.airprompt-tmux-session"

SESSION_ID="${1:-}"

# ── Detect current tmux session ──────────────────────────────────────
CURRENT_TMUX=""
if [ -n "${TMUX:-}" ]; then
  CURRENT_TMUX=$(tmux display-message -p '#S' 2>/dev/null || true)
  if echo "$CURRENT_TMUX" | grep -q '^airprompt-web-'; then
    CURRENT_TMUX=$(tmux display-message -p '#{session_group}' 2>/dev/null | tr -d '\n\r')
  fi
fi

# ── Auto-discover session from per-session dir ───────────────────────
MY_DIR=""
if [ -n "$CURRENT_TMUX" ] && [ -d "${SESSIONS_DIR}/${CURRENT_TMUX}" ]; then
  MY_DIR="${SESSIONS_DIR}/${CURRENT_TMUX}"
  if [ -z "$SESSION_ID" ]; then
    SESSION_ID=$(head -c 128 "${MY_DIR}/session" 2>/dev/null | tr -d '\n\r')
  fi
fi

# ── Fallback: auto-discover from legacy global files ─────────────────
if [ -z "$SESSION_ID" ] && [ -f "$SESSION_FILE" ]; then
  SESSION_ID=$(head -c 128 "$SESSION_FILE" 2>/dev/null | tr -d '\n\r')
fi

# ── Idempotent: if already off, exit silently ────────────────────────
if [ -z "$SESSION_ID" ]; then
  HAS_MARKERS=false
  for f in "$MARKER" "$URL_FILE" "$SESSION_FILE" "$TMUX_ACTIVE_FILE" "$TMUX_SESSION_FILE"; do
    [ -f "$f" ] && HAS_MARKERS=true
  done
  if [ -d "$SESSIONS_DIR" ] && [ "$(ls -A "$SESSIONS_DIR" 2>/dev/null)" ]; then
    HAS_MARKERS=true
  fi
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
TMUX_TO_KILL=""
if [ -n "$MY_DIR" ] && [ -f "${MY_DIR}/tmux" ]; then
  TMUX_TO_KILL=$(head -c 128 "${MY_DIR}/tmux" 2>/dev/null | tr -d '\n\r')
elif [ -f "$TMUX_ACTIVE_FILE" ]; then
  TMUX_TO_KILL=$(head -c 128 "$TMUX_ACTIVE_FILE" 2>/dev/null | tr -d '\n\r')
fi
if [ -n "$TMUX_TO_KILL" ] && echo "$TMUX_TO_KILL" | grep -q '^airprompt-'; then
  tmux kill-session -t "$TMUX_TO_KILL" 2>/dev/null || true
  sleep 0.2
fi

# ── Unregister from daemon (force: true — user explicitly asked) ────
UNREG_OK=false
if [ -n "$SESSION_ID" ]; then
  RESP=$(curl -s $CURL_OPTS -X POST "${PROTO}://localhost:${DAEMON_PORT}/api/sessions/unregister" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${SESSION_ID}\",\"force\":true}" 2>/dev/null || echo "")
  if echo "$RESP" | grep -q '"ok":true'; then
    UNREG_OK=true
  elif [ -z "$RESP" ]; then
    # Daemon unreachable — clean up locally anyway
    echo "Warning: daemon unreachable, removing local markers only" >&2
    UNREG_OK=true
  else
    echo "Warning: daemon refused unregister — $RESP" >&2
  fi
fi

# ── Remove per-session directory ─────────────────────────────────────
if [ -n "$MY_DIR" ] && [ -d "$MY_DIR" ]; then
  rm -rf "$MY_DIR"
fi

# ── Remove legacy global markers ─────────────────────────────────────
rm -f "$MARKER" "$URL_FILE" "$SESSION_FILE" "$TMUX_ACTIVE_FILE" "$TMUX_SESSION_FILE" "${CONFIG_DIR}/.airprompt-name"

# ── Sweep dead session dirs ──────────────────────────────────────────
if [ -d "$SESSIONS_DIR" ]; then
  for d in "$SESSIONS_DIR"/*/; do
    [ -d "$d" ] || continue
    DN=$(basename "$d")
    tmux has-session -t "$DN" 2>/dev/null; HAS_RC=$?
    if [ $HAS_RC -eq 0 ]; then
      : # session alive — skip
    elif [ $HAS_RC -eq 1 ]; then
      # Only delete if tmux explicitly says "no session" (exit code 1).
      echo "Cleaning up dead session dir: $DN" >&2
      rm -rf "$d"
    fi
  done
fi

# ── Stop daemon if no sessions remain ────────────────────────────────
REMAINING=$(curl -s $CURL_OPTS "${PROTO}://localhost:${DAEMON_PORT}/api/sessions" 2>/dev/null || echo "[]")
REMAINING_COUNT=$(echo "$REMAINING" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
if [ "$REMAINING_COUNT" = "0" ]; then
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
  if $UNREG_OK; then
    echo "AirPrompt session unregistered: $SESSION_ID"
  else
    echo "AirPrompt: session $SESSION_ID removed locally (daemon refused)"
  fi
else
  echo "AirPrompt cleaned up."
fi
