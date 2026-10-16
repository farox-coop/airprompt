#!/bin/bash
# notification-test/send.sh — send realistic simulated Claude notifications
# Two delivery paths (auto-detected):
#   1. $HOME/.claude/hooks/notify.sh exists → pipes through it (sound + desktop + WS)
#   2. notify.sh NOT found → POSTs directly to AirPrompt daemon /api/notify (WS only)
#
# Usage:
#   send.sh [options]
#
# Options (all optional — sensible defaults for every field):
#   --type <t>            notification_type: idle_prompt | permission_prompt |
#                         agent_needs_input | agent_completed (default: idle_prompt)
#   --message <msg>       notification message text (default: auto-generated)
#   --session-id <id>     AirPrompt session ID (default: first from /api/sessions)
#   --cwd <path>          working directory (default: resolved from session)
#   --ai-title <title>    simulated Claude transcript aiTitle
#   --duration-ms <ms>    simulated turn duration in ms (default: random 500-5000)
#   --tokens <n>          simulated session context size in tokens (default: random 10k-200k)
#   --permission-mode <m> acceptEdits|bypassPermissions|default|plan (default: default)
#   --effort <level>      low|medium|high|xhigh|max (default: medium)
#   --count <n>           send N notifications (default: 1)
#   --delay <ms>          delay between notifications when count>1 (default: 100)
#   --auto-dismiss <0|1>  server-side auto_dismiss flag (default: 0)
#   --dry-run             print JSON payloads without sending
#   --help                show this help

# ── Resolve config dirs ─────────────────────────────────────────────────
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
NOTIFY_HOOK="$CLAUDE_DIR/hooks/notify.sh"
AIRPROMPT_PORT="${AIRPROMPT_PORT:-3210}"
AIRPROMPT_DAEMON_JSON="$CLAUDE_DIR/.airprompt/daemon.json"

# ── Guard: require jq ───────────────────────────────────────────────────
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required but not installed" >&2
  exit 1
fi

# ── Defaults ────────────────────────────────────────────────────────────
NOTIFY_TYPE="idle_prompt"
MESSAGE=""
SESSION_ID=""
CWD=""
AI_TITLE=""
DURATION_MS=""
TOKENS=""
PERMISSION_MODE="default"
EFFORT="medium"
COUNT=1
# The server compares `auto_dismiss === true`, so the payload must carry a real
# boolean: `--argjson 1` never auto-dismissed a notification on either path.
AUTO_DISMISS_BOOL=false
DELAY_MS=100
DRY_RUN=0

# ── Parse args ──────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  # Every flag except the two booleans takes a value; without this a trailing
  # `--tokens` (value eaten by shift) loops forever instead of reporting itself.
  case "$1" in
    --dry-run|--help) ;;
    *) [ $# -ge 2 ] || { echo "ERROR: $1 expects a value" >&2; exit 1; } ;;
  esac
  case "$1" in
    --type)             NOTIFY_TYPE="$2"; shift 2 ;;
    --message)          MESSAGE="$2"; shift 2 ;;
    --session-id)       SESSION_ID="$2"; shift 2 ;;
    --cwd)              CWD="$2"; shift 2 ;;
    --ai-title)         AI_TITLE="$2"; shift 2 ;;
    --duration-ms)      DURATION_MS="$2"; shift 2 ;;
    --tokens)           TOKENS="$2"; TOKENS_GIVEN=1; shift 2 ;;
    --permission-mode)  PERMISSION_MODE="$2"; shift 2 ;;
    --effort)           EFFORT="$2"; shift 2 ;;
    --count)            COUNT="$2"; shift 2 ;;
    --delay)            DELAY_MS="$2"; shift 2 ;;
    --auto-dismiss)     case "$2" in 1|true) AUTO_DISMISS_BOOL=true ;; esac; shift 2 ;;
    --dry-run)          DRY_RUN=1; shift ;;
    --help)
      sed -n '2,/^$/p' "$0" | sed 's/^# //; s/^#$//'
      exit 0 ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done

# ── Guard: reject a --tokens that is not a positive count ───────────────
# Same rule as the helper (which would reject it too, one layer down): a value
# that is not a number never becomes a badge. `--tokens ''` is a caller mistake,
# not a request for the random default, so it is rejected rather than ignored.
if [ -n "$TOKENS_GIVEN" ]; then
  case "$TOKENS" in
    ''|0|0*|*[!0-9]*) echo "ERROR: --tokens expects a positive integer, got '$TOKENS'" >&2; exit 1 ;;
  esac
fi

# ── Resolve session + daemon connection ──────────────────────────────────
_resolve_session() {
  local proto="http" opts=""
  if [ -f "$AIRPROMPT_DAEMON_JSON" ] && command -v jq >/dev/null 2>&1; then
    proto=$(jq -r '.protocol // "http"' "$AIRPROMPT_DAEMON_JSON" 2>/dev/null || echo "http")
  fi
  [ "$proto" = "https" ] && opts="-k"
  AP_PROTO="$proto"
  AP_OPTS="$opts"

  local list
  list=$(curl -s -m 1 ${opts} "${proto}://127.0.0.1:${AIRPROMPT_PORT}/api/sessions" 2>/dev/null) || list="[]"
  if [ -z "$SESSION_ID" ]; then
    SESSION_ID=$(echo "$list" | jq -r 'first(.[].id // empty)' 2>/dev/null) || SESSION_ID=""
  fi
  # Resolve name + cwd from session
  SESSION_NAME=$(echo "$list" | jq -r --arg sid "$SESSION_ID" '.[] | select(.id == $sid) | .name // ""' 2>/dev/null) || SESSION_NAME=""
  if [ -z "$CWD" ]; then
    CWD=$(echo "$list" | jq -r --arg sid "$SESSION_ID" '.[] | select(.id == $sid) | .cwd // ""' 2>/dev/null) || CWD=""
    [ -z "$CWD" ] && CWD="$(pwd)"
  fi
}
_resolve_session

# ── Detect delivery path ─────────────────────────────────────────────────
if [ -x "$NOTIFY_HOOK" ]; then
  DELIVERY="hook"
else
  DELIVERY="direct"
fi

# ── Auto-generate missing fields ────────────────────────────────────────
[ -z "$AI_TITLE" ] && AI_TITLE="Simulated notification — $(date '+%H:%M:%S')"
if [ -z "$DURATION_MS" ]; then
  DURATION_MS=$(( 500 + RANDOM % 4500 ))
fi
if [ -z "$TOKENS" ]; then
  # `(10 + RANDOM % 191) * 1000` spans the whole documented range. The obvious
  # `10000 + RANDOM % 190000` does not: bash RANDOM is 0-32767, so the modulo is
  # a no-op and every simulated session would report 10k-43k.
  TOKENS=$(( (10 + RANDOM % 191) * 1000 ))
fi
if [ -z "$MESSAGE" ]; then
  case "$NOTIFY_TYPE" in
    idle_prompt)       MESSAGE="Claude is idle — ready for your next prompt" ;;
    permission_prompt) MESSAGE="Permission requested: Bash tool execution" ;;
    agent_needs_input) MESSAGE="Background agent requires your input" ;;
    agent_completed)   MESSAGE="Background agent finished successfully" ;;
    *)                 MESSAGE="AirPrompt test notification" ;;
  esac
fi

# ── Compute webUI-enrichment fields ─────────────────────────────────────
# Same logic as notify.sh — provides rich info even via direct delivery
_format_duration() {
  local ms="$1"
  if [ "$ms" -lt 1000 ]; then
    echo "${ms}ms"
  elif [ "$ms" -lt 60000 ]; then
    echo "$(echo "scale=1; $ms/1000" | bc 2>/dev/null || echo "0")s"
  elif [ "$ms" -lt 3600000 ]; then
    echo "$(echo "scale=1; $ms/60000" | bc 2>/dev/null || echo "0")m"
  else
    echo "$(echo "scale=1; $ms/3600000" | bc 2>/dev/null || echo "0")h"
  fi
}
# ── Current context tokens — the same badge the statusline shows ────────
# Computed with the real helper (AirPrompt's provider-agnostic reader) so the
# simulation prints exactly what notify.sh derives from the transcript below.
# No local fallback: a second copy of the rounding rule would drift from the
# helper, and a badge is either the number the helper read or nothing at all.
# Path resolved with `cd … && pwd -P`, never `readlink -f` — that flag is absent
# on macOS ≤12 and banned repo-wide (bin/airprompt:8-11). A symlink *file*
# pointing at this script is not followed here; the documented invocation is a
# repo path.
TOKENS_HELPER="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." 2>/dev/null && pwd -P)/src/hooks/airprompt-session-tokens.js"
TOKEN_BADGE=""
if [ -f "$TOKENS_HELPER" ] && command -v node >/dev/null 2>&1; then
  TOKEN_BADGE=$(node "$TOKENS_HELPER" --tokens "$TOKENS" 2>/dev/null | tr -d '\n\r')
else
  echo "WARNING: no token badge — helper=$TOKENS_HELPER node=$(command -v node || echo missing)" >&2
fi

TURN_INFO="$(_format_duration "$DURATION_MS")"
[ -n "$TOKEN_BADGE" ] && TURN_INFO="$TURN_INFO — ${TOKEN_BADGE}"
PROJECT_NAME="$(basename "$CWD")"
if [ -n "$SESSION_NAME" ]; then
  SESSION_LABEL="$SESSION_NAME"
elif [ -n "$PROJECT_NAME" ] && [ "$PROJECT_NAME" != "." ]; then
  SESSION_LABEL="$PROJECT_NAME @ $AI_TITLE"
elif [ -n "$AI_TITLE" ]; then
  SESSION_LABEL="$AI_TITLE"
else
  SESSION_LABEL="${SESSION_ID:0:8}"
fi
if [ -n "$SESSION_NAME" ]; then
  SUBTITLE="($PROJECT_NAME @ $AI_TITLE)"
else
  SUBTITLE=""
fi

# ── Create temp transcript with simulated events ────────────────────────
TRANSCRIPT_DIR="$(mktemp -d)"
trap 'rm -rf "$TRANSCRIPT_DIR"' EXIT
TRANSCRIPT_FILE="$TRANSCRIPT_DIR/transcript.jsonl"
# Write the events in the shape a real transcript uses, so notify.sh extracts
# them the same way it does in production: notify.sh greps each event name
# separately (`tac | grep '"ai-title"' | head -1`), so file order is not load
# bearing — but the JSON keys must match (`aiTitle`, not `ai-title` as a key).
# The assistant line carries the usage record the context badge is read from, so
# the simulated badge is real data, not a hardcoded string.
cat > "$TRANSCRIPT_FILE" <<TRANSCRIPT_EOF
{"type":"user","message":{"role":"user","content":"simulated prompt"}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"simulated response"}],"usage":{"input_tokens":${TOKENS},"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
{"turn_duration":"${DURATION_MS}","durationMs":${DURATION_MS}}
{"type":"ai-title","aiTitle":"${AI_TITLE}"}
TRANSCRIPT_EOF

# ── Build JSON payload ──────────────────────────────────────────────────
build_payload() {
  if [ "$DELIVERY" = "hook" ]; then
    jq -n \
      --arg type "$NOTIFY_TYPE" \
      --arg message "$MESSAGE" \
      --arg session_id "$SESSION_ID" \
      --arg cwd "$CWD" \
      --arg transcript_path "$TRANSCRIPT_FILE" \
      --arg permission_mode "$PERMISSION_MODE" \
      --arg effort "$EFFORT" \
      --arg session_label "$SESSION_LABEL" \
      --arg turn_info "$TURN_INFO" \
      --arg subtitle "$SUBTITLE" \
      --arg cc_title "$AI_TITLE" \
      --argjson auto_dismiss "$AUTO_DISMISS_BOOL" \
      '{notification_type:$type,message:$message,session_id:$session_id,cwd:$cwd,transcript_path:$transcript_path,permission_mode:$permission_mode,effort:{level:$effort},session_label:$session_label,turn_info:$turn_info,subtitle:$subtitle,cc_title:$cc_title,auto_dismiss:$auto_dismiss}'
  else
    jq -n \
      --arg type "$NOTIFY_TYPE" \
      --arg message "$MESSAGE" \
      --arg session_id "$SESSION_ID" \
      --arg cwd "$CWD" \
      --arg permission_mode "$PERMISSION_MODE" \
      --arg effort "$EFFORT" \
      --arg session_label "$SESSION_LABEL" \
      --arg turn_info "$TURN_INFO" \
      --arg subtitle "$SUBTITLE" \
      --arg cc_title "$AI_TITLE" \
      --argjson auto_dismiss "$AUTO_DISMISS_BOOL" \
      '{notification_type:$type,message:$message,session_id:$session_id,cwd:$cwd,permission_mode:$permission_mode,effort:{level:$effort},session_label:$session_label,turn_info:$turn_info,subtitle:$subtitle,cc_title:$cc_title,auto_dismiss:$auto_dismiss}'
  fi
}

_send_one() {
  local payload
  payload="$(build_payload)" || { echo "ERROR: build_payload failed" >&2; return 1; }
  if [ "$DRY_RUN" = "1" ]; then
    echo "$payload" | jq '.' 2>/dev/null || echo "$payload"
    return 0
  fi
  if [ "$DELIVERY" = "hook" ]; then
    echo "$payload" | bash "$NOTIFY_HOOK" || { echo "WARNING: notify.sh failed (exit $?)" >&2; }
  else
    curl -s -m 2 ${AP_OPTS} -X POST "${AP_PROTO}://127.0.0.1:${AIRPROMPT_PORT}/api/notify" \
      -H 'Content-Type: application/json' -d "$payload" >/dev/null || { echo "WARNING: direct API call failed" >&2; }
  fi
}

# ── Send ────────────────────────────────────────────────────────────────
NOTIFY_COUNT=0
while [ "$NOTIFY_COUNT" -lt "$COUNT" ]; do
  _send_one
  NOTIFY_COUNT=$((NOTIFY_COUNT + 1))
  if [ "$NOTIFY_COUNT" -lt "$COUNT" ]; then
    sleep "$(echo "scale=3; $DELAY_MS/1000" | bc 2>/dev/null || echo "0.1")"
  fi
done

# ── Cleanup ─────────────────────────────────────────────────────────────
rm -rf "$TRANSCRIPT_DIR"

# ── Summary ─────────────────────────────────────────────────────────────
if [ "$DRY_RUN" = "0" ]; then
  echo "Sent $COUNT notification(s) via $DELIVERY: type=$NOTIFY_TYPE session=$SESSION_ID ($SESSION_NAME) cwd=$CWD ai_title=\"$AI_TITLE\" duration=${DURATION_MS}ms tokens=${TOKENS}"
fi
