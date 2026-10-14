#!/bin/bash
set -euo pipefail

# ── Help guard ─────────────────────────────────────────────────────────
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  echo "Usage: bin/airprompt off [<sessionId>]"
  echo ""
  echo "  Unregister current session from daemon, remove local markers,"
  echo "  and stop daemon if no sessions remain."
  echo ""
  echo "  <sessionId> targets that session instead of the current one. Use it"
  echo "  when the current session cannot be resolved — a pane whose \$TMUX was"
  echo "  lost, for instance."
  echo ""
  echo "This is an internal script. Use 'bin/airprompt off' directly."
  exit 0
fi

DAEMON_PORT="${AIRPROMPT_PORT:-3210}"
SESSIONS_DIR="${AIRPROMPT_SESSIONS_DIR:-$HOME/.airprompt/sessions}"
UPLOADS_DIR="${AIRPROMPT_UPLOADS_DIR:-$HOME/.airprompt/uploads}"
PROVIDER="${AIRPROMPT_PROVIDER:-}"

# ── Protocol detection (shared lib) ────────────────────────────────────
source "$(dirname "$0")/lib/protocol.sh"
detect_protocol
DAEMON_PORT="$AP_PORT"

SESSION_ID="${1:-}"

# ── Detect current tmux session ──────────────────────────────────────
CURRENT_TMUX=""
SAFE_TMUX=""
if [ -n "${TMUX:-}" ]; then
  CURRENT_TMUX=$(tmux display-message -p '#S' 2>/dev/null || true)
  if echo "$CURRENT_TMUX" | grep -q '^airprompt-web-'; then
    PROXY_GROUP=$(tmux display-message -p '#{session_group}' 2>/dev/null | tr -d '\n\r' || true)
    # Only a session that really belongs to a group is a proxy. A session merely
    # *named* `airprompt-web-…` — `--name web-x` produces exactly that — is not,
    # and blanking its name here would leave `off` unable to resolve it at all.
    # activate.js and deactivate.js guard the same way.
    if [ -n "$PROXY_GROUP" ]; then
      CURRENT_TMUX="$PROXY_GROUP"
    fi
  fi
fi

# ── Auto-discover session from per-session dir ───────────────────────
# An explicit sessionId names its own session, so resolve THAT session's dir.
# Falling back to the current pane's would make `airprompt off <otherId>` remove
# the caller's markers — and kill its mirror — while leaving the target's behind.
MY_DIR=""
if [ -n "$SESSION_ID" ]; then
  for d in "${SESSIONS_DIR}"/*/; do
    [ -d "$d" ] || continue
    if [ "$(head -c 128 "${d}/session" 2>/dev/null | tr -d '\n\r' || true)" = "$SESSION_ID" ]; then
      MY_DIR="${d%/}"
      break
    fi
  done
elif [ -n "$CURRENT_TMUX" ]; then
  SAFE_TMUX=$(printf '%s' "$CURRENT_TMUX" | tr -cd 'a-zA-Z0-9_.-')
  if [ -n "$PROVIDER" ] && [ -d "${SESSIONS_DIR}/${PROVIDER}-${SAFE_TMUX}" ]; then
    MY_DIR="${SESSIONS_DIR}/${PROVIDER}-${SAFE_TMUX}"
  else
    # Provider unknown (e.g. IDE uninstalled) — find the session dir matching
    # this tmux regardless of provider prefix.
    for d in "${SESSIONS_DIR}"/*-"${SAFE_TMUX}"; do
      [ -d "$d" ] && { MY_DIR="$d"; break; }
    done
  fi
  if [ -n "$MY_DIR" ]; then
    SESSION_ID=$(head -c 128 "${MY_DIR}/session" 2>/dev/null | tr -d '\n\r' || true)
  fi
fi

# ── Purge this session's uploads ─────────────────────────────────────
# Keyed the same way as the daemon writes them: <providerId>-<sessionId>.
# Deliberately done BEFORE the "already off" early exit below, so a session torn
# down the hard way still cleans up. If even the sessionId is unknown there is no
# way to name the dir here — the daemon's sweep reaps it from its manifest once
# this session's tmux is gone.
if [ -n "$SESSION_ID" ]; then
  for _ud in "${UPLOADS_DIR}"/*-"${SESSION_ID}"; do
    [ -d "$_ud" ] && _purge_uploads_dir "$_ud"
  done
fi

# ── Idempotent: if already off, exit silently ────────────────────────
if [ -z "$SESSION_ID" ]; then
  echo "AirPrompt: nothing to unregister (already off)."
  exit 0
fi


# ── Kill airprompt tmux session before unregister ──────────────────
TMUX_TO_KILL=""
if [ -n "$MY_DIR" ] && [ -f "${MY_DIR}/tmux" ]; then
  TMUX_TO_KILL=$(head -c 128 "${MY_DIR}/tmux" 2>/dev/null | tr -d '\n\r' || true)
fi
if [ -n "$TMUX_TO_KILL" ] && echo "$TMUX_TO_KILL" | grep -q '^airprompt-'; then
  # Only kill what the daemon owns — a `mirror` (activate.js) or a `standin` (the
  # register route stood the session up). Real sessions named airprompt-* must
  # survive, and without this fallback a stand-in would outlive its marker.
  if [ -f "${MY_DIR}/mirror" ] || [ -f "${MY_DIR}/standin" ]; then
    tmux kill-session -t "$TMUX_TO_KILL" 2>/dev/null || true
    sleep 0.2
  fi
fi

# ── Unregister from daemon (force: true — user explicitly asked) ────
UNREG_OK=false
if [ -n "$SESSION_ID" ]; then
  RESP=$(curl -s ${AP_CURL_OPTS[@]+"${AP_CURL_OPTS[@]}"} -X POST "${AP_PROTO}://localhost:${DAEMON_PORT}/api/sessions/unregister" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${SESSION_ID}\",\"force\":true}" 2>/dev/null || echo "")
  if echo "$RESP" | grep -q '"ok":true'; then
    UNREG_OK=true
  elif [ -z "$RESP" ]; then
    echo "Warning: daemon unreachable, removing local markers only" >&2
    UNREG_OK=true
  else
    echo "Warning: daemon refused unregister — $RESP" >&2
  fi
fi

# ── Remove per-session directory ─────────────────────────────────────
if [ -n "$MY_DIR" ] && [ -d "$MY_DIR" ]; then
  _safe_rm_rf "$MY_DIR" && { rm -rf "$MY_DIR"; }
fi

# ── Sweep dead session dirs ──────────────────────────────────────────
if _safe_rm_rf "$SESSIONS_DIR"; then
  for d in "$SESSIONS_DIR"/*/; do
    [ -d "$d" ] || continue
    DN=$(basename "$d")
    # Read real tmux name from dir — dir name is sanitized,
    # real name may differ (e.g. "My Session!" vs "MySession").
    REAL_TMUX=$(head -c 128 "${d}/tmux" 2>/dev/null | tr -d '\n\r' || true)
    [ -z "$REAL_TMUX" ] && REAL_TMUX="$DN"
    tmux has-session -t "$REAL_TMUX" 2>/dev/null && HAS_RC=0 || HAS_RC=$?
    if [ "$HAS_RC" -eq 0 ]; then
      : # session alive — skip
    elif [ "$HAS_RC" -eq 1 ]; then
      # Only delete if tmux explicitly says "no session" (exit code 1).
      echo "Cleaning up dead session dir: $DN" >&2
      SID=$(head -c 128 "${d}/session" 2>/dev/null | tr -d '\n\r' || true)
      [ -z "$SID" ] && SID=$(echo "$DN" | tr -cd 'a-zA-Z0-9_-')
      curl -s ${AP_CURL_OPTS[@]+"${AP_CURL_OPTS[@]}"} -X POST "${AP_PROTO}://localhost:${DAEMON_PORT}/api/sessions/unregister" \
        -H "Content-Type: application/json" \
        -d "{\"sessionId\":\"${SID}\"}" > /dev/null 2>&1 || true
      rm -rf "$d"
    fi
  done
fi

# ── Stop daemon if no sessions remain ────────────────────────────────
# Count with python3 if available, fallback to grep counting — safer
# than defaulting to "0" which would kill daemon with active sessions.
REMAINING=$(curl -s ${AP_CURL_OPTS[@]+"${AP_CURL_OPTS[@]}"} "${AP_PROTO}://localhost:${DAEMON_PORT}/api/sessions" 2>/dev/null || echo "")
# If curl failed or returned empty, default to "unreachable" — never
# kill daemon on a failed fetch.  Empty "[]" = truly zero sessions.
if [ -z "$REMAINING" ]; then
  REMAINING_COUNT="-1"
else
  if command -v python3 &>/dev/null; then
    REMAINING_COUNT=$(echo "$REMAINING" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "-1")
  elif command -v python &>/dev/null; then
    REMAINING_COUNT=$(echo "$REMAINING" | python -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "-1")
  else
    # No Python — count '"id":' occurrences as rough estimate.
    # Overestimate is safe: daemon won't be killed spuriously.
    REMAINING_COUNT=$(echo "$REMAINING" | grep -o '"id":"[^"]*"' | wc -l)
  fi
fi
if [ "$REMAINING_COUNT" = "0" ]; then
  if tmux has-session -t airprompt-daemon 2>/dev/null; then
    tmux kill-session -t airprompt-daemon 2>/dev/null || true
  fi
  PID_FILE="${AIRPROMPT_PID_FILE:-/tmp/airprompt-server.pid}"
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
      # Verify PID is actually airprompt before killing (same guard as clean.sh)
      if _is_airprompt_pid "$PID"; then
        kill "$PID" 2>/dev/null || true
      fi
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
