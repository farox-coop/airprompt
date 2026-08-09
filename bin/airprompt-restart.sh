#!/bin/bash
# airprompt-restart.sh — Restart the AirPrompt daemon without killing sessions.
# Sessions are auto-recovered from disk markers on daemon startup.
# Use: /airprompt restart
set -euo pipefail

# ── Help guard ─────────────────────────────────────────────────────────
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  echo "Usage: bin/airprompt restart"
  echo ""
  echo "  Restart the AirPrompt daemon. Active sessions survive — they are"
  echo "  recovered from ~/.airprompt/sessions/{provider}-*/ on startup."
  echo ""
  echo "This is an internal script. Use 'bin/airprompt restart' directly."
  exit 0
fi

DAEMON_PORT="${PORT:-${AIRPROMPT_PORT:-3210}}"
DAEMON_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="${AIRPROMPT_PID_FILE:-/tmp/airprompt-server.pid}"
STATE_DIR="${AIRPROMPT_STATE_DIR:-$HOME/.airprompt/state}"
DEBUG="${AIRPROMPT_DEBUG:-0}"

# ── Protocol detection (shared lib) ────────────────────────────────────
source "$(dirname "$0")/lib/protocol.sh"
detect_protocol
DAEMON_PORT="$AP_PORT"

# ── Auto-generate TLS certs if missing ─────────────────────────────
CERT_DIR="${AIRPROMPT_STATE_DIR:-$HOME/.airprompt/state}"
CERT_FILE="${CERT_DIR}/airprompt-cert.pem"
KEY_FILE="${CERT_DIR}/airprompt-key.pem"
if [ "${AIRPROMPT_NO_TLS:-}" != "1" ] && { [ ! -f "$CERT_FILE" ] || [ ! -f "$KEY_FILE" ]; }; then
  GEN_CERT_SCRIPT="$(dirname "$0")/generate-cert.sh"
  if [ -x "$GEN_CERT_SCRIPT" ]; then
    bash "$GEN_CERT_SCRIPT" || true  # non-fatal: HTTP fallback if openssl missing
    # Re-detect protocol after cert generation
    detect_protocol
    DAEMON_PORT="$AP_PORT"
  fi
fi

echo "AirPrompt: restarting daemon..."

# ── 1. Kill existing daemon PID (fast path) ───────────────────────────
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null || true)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    IS_AIRPROMPT=false
    if [ -r "/proc/$PID/cmdline" ]; then
      tr '\0' ' ' < "/proc/$PID/cmdline" | grep -q 'server\.js' && IS_AIRPROMPT=true
    fi
    if $IS_AIRPROMPT; then
      kill "$PID" 2>/dev/null || true
      for i in $(seq 1 15); do
        kill -0 "$PID" 2>/dev/null || break
        sleep 0.1
      done
      kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null || true
      echo "  old daemon stopped (PID $PID)"
    fi
  fi
  rm -f "$PID_FILE"
fi

DAEMON_ENV="$(daemon_env)"

# ── 2. Restart daemon inside tmux ─────────────────────────────────────
cd "$DAEMON_DIR"
if tmux has-session -t airprompt-daemon 2>/dev/null; then
  tmux respawn-pane -k -t airprompt-daemon "$DAEMON_ENV node server.js 2>&1 | tee /tmp/airprompt.log" 2>/dev/null || {
    # respawn failed — kill zombie daemon session and create fresh one
    tmux kill-session -t airprompt-daemon 2>/dev/null || true
    rm -f "$PID_FILE"
  }
fi

# Fallback: create daemon session if it doesn't exist (e.g. killed above)
if ! tmux has-session -t airprompt-daemon 2>/dev/null; then
  tmux new-session -d -s airprompt-daemon "$DAEMON_ENV node server.js 2>&1 | tee /tmp/airprompt.log" || true
fi

# ── 3. Wait for daemon to be ready ────────────────────────────────────
DAEMON_READY=false
for i in $(seq 1 20); do
  if curl -s $AP_CURL_OPTS "${AP_PROTO}://localhost:${DAEMON_PORT}/api/sessions" > /dev/null 2>&1; then
    echo "  daemon ready on port $DAEMON_PORT"
    DAEMON_READY=true
    break
  fi
  if ! tmux has-session -t airprompt-daemon 2>/dev/null; then
    echo "Error: daemon died during restart. Check /tmp/airprompt.log" >&2
    exit 1
  fi
  sleep 0.5
done

if ! $DAEMON_READY; then
  echo "Error: daemon did not become ready within 10s. Check /tmp/airprompt.log" >&2
  exit 1
fi

# ── 4. Show recovered sessions ────────────────────────────────────────
SESSION_COUNT=$(curl -s $AP_CURL_OPTS "${AP_PROTO}://localhost:${DAEMON_PORT}/api/sessions" | jq '. | length' 2>/dev/null || echo "?")
echo "AirPrompt: daemon restarted — $SESSION_COUNT session(s) recovered"
