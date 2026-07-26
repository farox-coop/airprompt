#!/bin/bash
set -euo pipefail

PORT="${AIRPROMPT_TEST_PORT:-3211}"
PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SERVER_PID=""
TMPDIR=$(mktemp -d)
trap 'cleanup' EXIT

MARKER="${TMPDIR}/.airprompt-active"
URL_FILE="${TMPDIR}/.airprompt-url"

pass=0; fail=0; skip=0
ok()   { echo "  PASS: $1"; pass=$((pass + 1)); }
not_ok() { echo "  FAIL: $1"; fail=$((fail + 1)); }
skipped() { echo "  SKIP: $1"; skip=$((skip + 1)); }

cleanup() {
  set +e
  if command -v tmux &>/dev/null; then
    for s in $(tmux ls 2>/dev/null | grep -o 'airprompt-integtest-[^:]*' || true); do
      tmux kill-session -t "$s" 2>/dev/null || true
    done
  fi
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -f "${TEST_PID_FILE:-/tmp/airprompt-server-test.pid}"
  rm -rf "$TMPDIR"
}

# ── Check dependencies ────────────────────────────────────────────────
TMUX_OK=true
if ! command -v tmux &>/dev/null; then
  TMUX_OK=false
fi

echo "=== AirPrompt Integration Tests ==="
echo "tmux available: $TMUX_OK"

# ── Start server ─────────────────────────────────────────────────────
echo "Starting AirPrompt server on port $PORT..."
TEST_PID_FILE="/tmp/airprompt-server-test.pid"
rm -f "$TEST_PID_FILE"
cd "$PROJECT_DIR"
AIRPROMPT_NO_TLS=1 AIRPROMPT_PID_FILE="$TEST_PID_FILE" PORT="$PORT" node server.js 2>/dev/null &
SERVER_PID=$!

for i in $(seq 1 20); do
  if kill -0 "$SERVER_PID" 2>/dev/null && curl -s "http://localhost:${PORT}/api/sessions" > /dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Server process died" >&2
    exit 1
  fi
  sleep 0.5
done
echo "Server running (PID $SERVER_PID)"

# ── Test 1: Register → List → Unregister ────────────────────────────
echo "[1/5] Full register → list → unregister"
if $TMUX_OK; then
  SESSION_ID="integtest-$(date +%s)-$$-full"
  tmux new-session -d -s "airprompt-${SESSION_ID}" 2>/dev/null || true

  REG=$(curl -s -X POST "http://localhost:${PORT}/api/sessions/register" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${SESSION_ID}\",\"cwd\":\"${PROJECT_DIR}\"}")
  if echo "$REG" | grep -q '"ok":true'; then ok "register"; else not_ok "register: $REG"; fi

  LIST=$(curl -s "http://localhost:${PORT}/api/sessions")
  if echo "$LIST" | grep -q "$SESSION_ID"; then ok "list contains session"; else not_ok "list missing session: $LIST"; fi

  UNREG=$(curl -s -X POST "http://localhost:${PORT}/api/sessions/unregister" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${SESSION_ID}\"}")
  if echo "$UNREG" | grep -q '"ok":true'; then ok "unregister"; else not_ok "unregister: $UNREG"; fi

  LIST2=$(curl -s "http://localhost:${PORT}/api/sessions")
  if ! echo "$LIST2" | grep -q "$SESSION_ID"; then ok "session removed from list"; else not_ok "session still in list"; fi
else
  skipped "tmux not available — 3 subtests skipped"
fi

# ── Test 2: Two sessions, both visible ──────────────────────────────
echo "[2/5] Two sessions register, both visible"
if $TMUX_OK; then
  ID_A="integtest-$(date +%s)-$$-a"
  ID_B="integtest-$(date +%s)-$$-b"
  tmux new-session -d -s "airprompt-${ID_A}" 2>/dev/null || true
  tmux new-session -d -s "airprompt-${ID_B}" 2>/dev/null || true

  curl -s -X POST "http://localhost:${PORT}/api/sessions/register" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${ID_A}\",\"cwd\":\"/tmp/a\"}" > /dev/null
  curl -s -X POST "http://localhost:${PORT}/api/sessions/register" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${ID_B}\",\"cwd\":\"/tmp/b\"}" > /dev/null

  LIST=$(curl -s "http://localhost:${PORT}/api/sessions")
  if echo "$LIST" | grep -q "$ID_A" && echo "$LIST" | grep -q "$ID_B"; then
    ok "both sessions visible"
  else
    not_ok "missing sessions in list: $LIST"
  fi

  curl -s -X POST "http://localhost:${PORT}/api/sessions/unregister" \
    -H "Content-Type: application/json" -d "{\"sessionId\":\"${ID_A}\"}" > /dev/null
  curl -s -X POST "http://localhost:${PORT}/api/sessions/unregister" \
    -H "Content-Type: application/json" -d "{\"sessionId\":\"${ID_B}\"}" > /dev/null
  ok "both sessions unregistered"
else
  skipped "tmux not available"
fi

# ── Test 3: Session unregistered on exit ────────────────────────────
echo "[3/5] Session unregister removes from list"
if $TMUX_OK; then
  ID_M="integtest-$(date +%s)-$$-marker"
  tmux new-session -d -s "airprompt-${ID_M}" 2>/dev/null || true

  curl -s -X POST "http://localhost:${PORT}/api/sessions/register" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${ID_M}\",\"cwd\":\"${PROJECT_DIR}\"}" > /dev/null
  curl -s -X POST "http://localhost:${PORT}/api/sessions/unregister" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${ID_M}\"}" > /dev/null

  LIST=$(curl -s "http://localhost:${PORT}/api/sessions")
  if ! echo "$LIST" | grep -q "$ID_M"; then ok "session gone from API"; else not_ok "session still in API"; fi
else
  skipped "tmux not available"
fi

# ── Test 4: Server survives invalid requests (no tmux needed) ───────
echo "[4/5] Server survives invalid requests"
INVALID=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "http://localhost:${PORT}/api/sessions/register" \
  -H "Content-Type: application/json" \
  -d 'not-json')
if [ "$INVALID" != "000" ]; then ok "invalid JSON handled ($INVALID)"; else not_ok "server crashed on invalid JSON"; fi

CHECK=$(curl -s "http://localhost:${PORT}/api/sessions")
if echo "$CHECK" | grep -q '^\['; then
  ok "server alive after invalid request"
else
  not_ok "server unresponsive: $CHECK"
fi

# ── Test 5: Duplicate registration rejected ─────────────────────────
echo "[5/5] Duplicate registration rejected"
if $TMUX_OK; then
  ID_D="integtest-$(date +%s)-$$-dup"
  tmux new-session -d -s "airprompt-${ID_D}" 2>/dev/null || true

  FIRST=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "http://localhost:${PORT}/api/sessions/register" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${ID_D}\",\"cwd\":\"${PROJECT_DIR}\"}")
  SECOND=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "http://localhost:${PORT}/api/sessions/register" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${ID_D}\",\"cwd\":\"${PROJECT_DIR}\"}")
  if [ "$FIRST" = "200" ] && [ "$SECOND" = "409" ]; then
    ok "duplicate rejected (200 then 409)"
  else
    not_ok "expected 200 then 409, got $FIRST then $SECOND"
  fi

  curl -s -X POST "http://localhost:${PORT}/api/sessions/unregister" \
    -H "Content-Type: application/json" -d "{\"sessionId\":\"${ID_D}\"}" > /dev/null
else
  skipped "tmux not available"
fi

# ── Summary ──────────────────────────────────────────────────────────
echo ""
echo "Integration tests: $pass passed, $fail failed, $skip skipped"
[ "$fail" -eq 0 ] && exit 0 || exit 1
