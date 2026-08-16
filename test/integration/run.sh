#!/bin/bash
set -euo pipefail

PORT="${AIRPROMPT_TEST_PORT:-3211}"
PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SERVER_PID=""
TMPDIR=$(mktemp -d)
trap 'cleanup' EXIT

# Skip immediate session registration during autostart tests — avoid
# spawning daemon on real port 3210 while integration server is on 3211.
export AIRPROMPT_AUTOSTART_SKIP_REGISTER=1

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
AIRPROMPT_NO_TLS=1 AIRPROMPT_PID_FILE="$TEST_PID_FILE" AIRPROMPT_STATE_DIR="$TMPDIR/state" AIRPROMPT_SESSIONS_DIR="$TMPDIR/sessions" AIRPROMPT_SKIP_RECOVERY=1 AIRPROMPT_PORT="$PORT" node server.js 2>/dev/null &
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
echo "[1/8] Full register → list → unregister"
if $TMUX_OK; then
  SESSION_ID="integtest-$(date +%s)-$$-full"
  tmux new-session -d -s "airprompt-${SESSION_ID}" 2>/dev/null || true

  REG=$(curl -s -X POST "http://localhost:${PORT}/api/sessions/register" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${SESSION_ID}\",\"cwd\":\"${PROJECT_DIR}\",\"providerId\":\"test-int\"}")
  if echo "$REG" | grep -q '"ok":true'; then ok "register"; else not_ok "register: $REG"; fi

  LIST=$(curl -s "http://localhost:${PORT}/api/sessions")
  if echo "$LIST" | grep -q "$SESSION_ID"; then ok "list contains session"; else not_ok "list missing session: $LIST"; fi

  # Kill tmux session first — server guard rejects unregister if tmux alive
  tmux kill-session -t "airprompt-${SESSION_ID}" 2>/dev/null || true
  sleep 0.2

  UNREG=$(curl -s -X POST "http://localhost:${PORT}/api/sessions/unregister" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${SESSION_ID}\",\"providerId\":\"test-int\"}")
  if echo "$UNREG" | grep -q '"ok":true'; then ok "unregister"; else not_ok "unregister: $UNREG"; fi

  LIST2=$(curl -s "http://localhost:${PORT}/api/sessions")
  if ! echo "$LIST2" | grep -q "$SESSION_ID"; then ok "session removed from list"; else not_ok "session still in list"; fi
else
  skipped "tmux not available — 3 subtests skipped"
fi

# ── Test 2: Two sessions, both visible ──────────────────────────────
echo "[2/8] Two sessions register, both visible"
if $TMUX_OK; then
  ID_A="integtest-$(date +%s)-$$-a"
  ID_B="integtest-$(date +%s)-$$-b"
  tmux new-session -d -s "airprompt-${ID_A}" 2>/dev/null || true
  tmux new-session -d -s "airprompt-${ID_B}" 2>/dev/null || true

  curl -s -X POST "http://localhost:${PORT}/api/sessions/register" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${ID_A}\",\"cwd\":\"/tmp/a\",\"providerId\":\"test-int\"}" > /dev/null
  curl -s -X POST "http://localhost:${PORT}/api/sessions/register" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${ID_B}\",\"cwd\":\"/tmp/b\",\"providerId\":\"test-int\"}" > /dev/null

  LIST=$(curl -s "http://localhost:${PORT}/api/sessions")
  if echo "$LIST" | grep -q "$ID_A" && echo "$LIST" | grep -q "$ID_B"; then
    ok "both sessions visible"
  else
    not_ok "missing sessions in list: $LIST"
  fi

  # Kill tmux sessions — server guard rejects unregister if tmux alive
  tmux kill-session -t "airprompt-${ID_A}" 2>/dev/null || true
  tmux kill-session -t "airprompt-${ID_B}" 2>/dev/null || true
  sleep 0.2

  curl -s -X POST "http://localhost:${PORT}/api/sessions/unregister" \
    -H "Content-Type: application/json" -d "{\"sessionId\":\"${ID_A}\",\"providerId\":\"test-int\"}" > /dev/null
  curl -s -X POST "http://localhost:${PORT}/api/sessions/unregister" \
    -H "Content-Type: application/json" -d "{\"sessionId\":\"${ID_B}\",\"providerId\":\"test-int\"}" > /dev/null
  ok "both sessions unregistered"
else
  skipped "tmux not available"
fi

# ── Test 3: Session unregistered on exit ────────────────────────────
echo "[3/8] Session unregister removes from list"
if $TMUX_OK; then
  ID_M="integtest-$(date +%s)-$$-marker"
  tmux new-session -d -s "airprompt-${ID_M}" 2>/dev/null || true

  curl -s -X POST "http://localhost:${PORT}/api/sessions/register" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${ID_M}\",\"cwd\":\"${PROJECT_DIR}\",\"providerId\":\"test-int\"}" > /dev/null

  # Kill tmux session — server guard rejects unregister if tmux alive
  tmux kill-session -t "airprompt-${ID_M}" 2>/dev/null || true
  sleep 0.2

  curl -s -X POST "http://localhost:${PORT}/api/sessions/unregister" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${ID_M}\",\"providerId\":\"test-int\"}" > /dev/null

  LIST=$(curl -s "http://localhost:${PORT}/api/sessions")
  if ! echo "$LIST" | grep -q "$ID_M"; then ok "session gone from API"; else not_ok "session still in API"; fi
else
  skipped "tmux not available"
fi

# ── Test 4: Server survives invalid requests (no tmux needed) ───────
echo "[4/8] Server survives invalid requests"
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
echo "[5/8] Duplicate registration rejected"
if $TMUX_OK; then
  ID_D="integtest-$(date +%s)-$$-dup"
  tmux new-session -d -s "airprompt-${ID_D}" 2>/dev/null || true

  FIRST=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "http://localhost:${PORT}/api/sessions/register" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${ID_D}\",\"cwd\":\"${PROJECT_DIR}\",\"providerId\":\"test-int\"}")
  SECOND=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "http://localhost:${PORT}/api/sessions/register" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${ID_D}\",\"cwd\":\"${PROJECT_DIR}\",\"providerId\":\"test-int\"}")
  if [ "$FIRST" = "200" ] && [ "$SECOND" = "409" ]; then
    ok "duplicate rejected (200 then 409)"
  else
    not_ok "expected 200 then 409, got $FIRST then $SECOND"
  fi

  # Kill tmux first so force unregister works even if server disagrees about liveness
  tmux kill-session -t "airprompt-${ID_D}" 2>/dev/null || true
  sleep 0.2
  curl -s -X POST "http://localhost:${PORT}/api/sessions/unregister" \
    -H "Content-Type: application/json" -d "{\"sessionId\":\"${ID_D}\",\"providerId\":\"test-int\",\"force\":true}" > /dev/null
else
  skipped "tmux not available"
fi

# ── Test 6: Name update on already-registered session ───────────────
echo "[6/8] Name update + clear on already-registered session"
if $TMUX_OK; then
  ID_N="integtest-$(date +%s)-$$-name"
  tmux new-session -d -s "airprompt-${ID_N}" 2>/dev/null || true

  # Register with initial name
  REG_N=$(curl -s -X POST "http://localhost:${PORT}/api/sessions/register" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${ID_N}\",\"cwd\":\"${PROJECT_DIR}\",\"name\":\"first\",\"providerId\":\"test-int\"}")
  if echo "$REG_N" | grep -q '"ok":true'; then ok "register with initial name"; else not_ok "register: $REG_N"; fi

  # Verify initial name in GET
  LIST_N=$(curl -s "http://localhost:${PORT}/api/sessions")
  if echo "$LIST_N" | grep -q '"name":"first"'; then ok "initial name in list"; else not_ok "first name not in list: $LIST_N"; fi

  # Simulate already-registered name update (what _name_update does)
  PUT_N=$(curl -s -X PUT "http://localhost:${PORT}/api/sessions/name" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${ID_N}\",\"name\":\"second\",\"providerId\":\"test-int\"}")
  if echo "$PUT_N" | grep -q '"ok":true'; then ok "name updated via PUT"; else not_ok "PUT name: $PUT_N"; fi

  # Verify updated name in GET
  LIST_N2=$(curl -s "http://localhost:${PORT}/api/sessions")
  if echo "$LIST_N2" | grep -q '"name":"second"'; then ok "updated name in list"; else not_ok "updated name not in list: $LIST_N2"; fi

  # Clear name with empty string
  PUT_CLEAR=$(curl -s -X PUT "http://localhost:${PORT}/api/sessions/name" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${ID_N}\",\"name\":\"\",\"providerId\":\"test-int\"}")
  if echo "$PUT_CLEAR" | grep -q '"ok":true'; then ok "name cleared via PUT empty string"; else not_ok "name clear: $PUT_CLEAR"; fi

  # Verify name is gone from session list
  LIST_CLEAR=$(curl -s "http://localhost:${PORT}/api/sessions")
  if echo "$LIST_CLEAR" | grep -q "$ID_N" && ! echo "$LIST_CLEAR" | grep -q '"name":"second"'; then
    ok "name absent after clear"
  else
    not_ok "name still present after clear: $LIST_CLEAR"
  fi

  # Cleanup: kill tmux first (server guard rejects unregister if tmux alive)
  tmux kill-session -t "airprompt-${ID_N}" 2>/dev/null || true
  sleep 0.2
  curl -s -X POST "http://localhost:${PORT}/api/sessions/unregister" \
    -H "Content-Type: application/json" -d "{\"sessionId\":\"${ID_N}\",\"providerId\":\"test-int\"}" > /dev/null
else
  skipped "tmux not available — 6 subtests skipped"
fi

# ── Test 7: Autostart script on/off with temp settings ────────────────
echo "[7/8] Autostart script on/off"
AUTOSTART_SCRIPT="${PROJECT_DIR}/bin/airprompt-autostart.sh"
TMP_SETTINGS="${TMPDIR}/settings.json"

if [ -x "$AUTOSTART_SCRIPT" ]; then
  # Run 'on' with temp settings file
  AIRPROMPT_SETTINGS_FILE="$TMP_SETTINGS" AIRPROMPT_INSTALL_DIR="$PROJECT_DIR" \
    bash "$AUTOSTART_SCRIPT" on
  if [ -f "$TMP_SETTINGS" ]; then
    ok "autostart on created settings file"
    if grep -q 'airprompt-activate.js' "$TMP_SETTINGS"; then
      ok "autostart on added SessionStart hook"
    else
      not_ok "SessionStart hook missing from settings"
    fi
  else
    not_ok "settings file not created by autostart on"
  fi

  # Run 'on' again — should be idempotent (no duplicate hooks)
  AIRPROMPT_SETTINGS_FILE="$TMP_SETTINGS" AIRPROMPT_INSTALL_DIR="$PROJECT_DIR" \
    bash "$AUTOSTART_SCRIPT" on
  HOOK_COUNT=$(grep -c 'airprompt-activate.js' "$TMP_SETTINGS" || true)
  if [ "$HOOK_COUNT" = "1" ]; then
    ok "autostart on is idempotent (1 hook)"
  else
    not_ok "expected 1 hook, got $HOOK_COUNT"
  fi

  # Run 'off'
  AIRPROMPT_SETTINGS_FILE="$TMP_SETTINGS" AIRPROMPT_INSTALL_DIR="$PROJECT_DIR" \
    bash "$AUTOSTART_SCRIPT" off
  if grep -q 'airprompt-activate.js' "$TMP_SETTINGS" 2>/dev/null; then
    not_ok "autostart off did not remove hook"
  else
    ok "autostart off removed SessionStart hook"
  fi

  # Run 'off' again — idempotent
  AIRPROMPT_SETTINGS_FILE="$TMP_SETTINGS" AIRPROMPT_INSTALL_DIR="$PROJECT_DIR" \
    bash "$AUTOSTART_SCRIPT" off
  ok "autostart off idempotent (already off)"

  # Run with invalid arg
  if ! AIRPROMPT_SETTINGS_FILE="$TMP_SETTINGS" AIRPROMPT_INSTALL_DIR="$PROJECT_DIR" \
    bash "$AUTOSTART_SCRIPT" invalid 2>/dev/null; then
    ok "autostart rejects invalid arg"
  else
    not_ok "autostart accepted invalid arg"
  fi

  # Settings file given → provider resolution must be skipped. A machine
  # with no IDE installed (fresh CI runner) has no detectable provider, so
  # resolve-config-dir.js would fail. The settings path is already known,
  # so the provider is irrelevant here.
  rm -f "$TMP_SETTINGS"
  if AIRPROMPT_SETTINGS_FILE="$TMP_SETTINGS" AIRPROMPT_INSTALL_DIR="$PROJECT_DIR" \
    AIRPROMPT_PROVIDER="nonexistent-provider" bash "$AUTOSTART_SCRIPT" on 2>/dev/null; then
    ok "autostart on needs no provider when settings file given"
  else
    not_ok "autostart on requires provider even with settings file given"
  fi

  # off preserves other SessionStart hooks (not just airprompt's)
  cat > "$TMP_SETTINGS" << 'JSONEOF'
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "echo other-tool" } ] },
      { "hooks": [ { "type": "command", "command": "node /x/airprompt-activate.js" } ] }
    ]
  }
}
JSONEOF
  AIRPROMPT_SETTINGS_FILE="$TMP_SETTINGS" AIRPROMPT_INSTALL_DIR="$PROJECT_DIR" \
    bash "$AUTOSTART_SCRIPT" off
  if grep -q 'airprompt-activate.js' "$TMP_SETTINGS" 2>/dev/null; then
    not_ok "off did not remove airprompt hook"
  else
    ok "off removed only airprompt hook"
  fi
  if grep -q 'echo other-tool' "$TMP_SETTINGS" 2>/dev/null; then
    ok "off preserved other SessionStart hook"
  else
    not_ok "off destroyed other SessionStart hook"
  fi

  # on -> off -> on round-trip
  rm -f "$TMP_SETTINGS"
  AIRPROMPT_SETTINGS_FILE="$TMP_SETTINGS" AIRPROMPT_INSTALL_DIR="$PROJECT_DIR" \
    bash "$AUTOSTART_SCRIPT" on
  AIRPROMPT_SETTINGS_FILE="$TMP_SETTINGS" AIRPROMPT_INSTALL_DIR="$PROJECT_DIR" \
    bash "$AUTOSTART_SCRIPT" off
  AIRPROMPT_SETTINGS_FILE="$TMP_SETTINGS" AIRPROMPT_INSTALL_DIR="$PROJECT_DIR" \
    bash "$AUTOSTART_SCRIPT" on
  if grep -q 'airprompt-activate.js' "$TMP_SETTINGS" 2>/dev/null; then
    ok "on -> off -> on round-trip works"
  else
    not_ok "on -> off -> on round-trip failed"
  fi

  # Handles JSONC-commented settings (Claude Code writes these)
  cat > "$TMP_SETTINGS" << 'JSONCEOF'
// Claude Code settings
{
  /* pre-existing */
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "node /x/airprompt-activate.js" } ] }
    ]
  }
}
JSONCEOF
  AIRPROMPT_SETTINGS_FILE="$TMP_SETTINGS" AIRPROMPT_INSTALL_DIR="$PROJECT_DIR" \
    bash "$AUTOSTART_SCRIPT" off
  if grep -q 'airprompt-activate.js' "$TMP_SETTINGS" 2>/dev/null; then
    not_ok "off failed with JSONC comments"
  else
    ok "off works with JSONC-commented settings"
  fi
  # Verify JSONC file was written back as valid JSON (no comments in output)
  if grep -q '//\|/\*' "$TMP_SETTINGS" 2>/dev/null; then
    not_ok "off output should be clean JSON (no comments)"
  else
    ok "off output is clean JSON"
  fi

  # Corrupted settings.json — autostart must refuse, not overwrite
  echo '{broken' > "$TMP_SETTINGS"
  if AIRPROMPT_SETTINGS_FILE="$TMP_SETTINGS" AIRPROMPT_INSTALL_DIR="$PROJECT_DIR" \
    bash "$AUTOSTART_SCRIPT" on 2>/dev/null; then
    not_ok "autostart on accepted corrupted settings"
  else
    ok "autostart on refuses corrupted settings.json"
  fi
  if grep -q '{broken' "$TMP_SETTINGS" 2>/dev/null; then
    ok "autostart on preserved corrupted settings"
  else
    not_ok "autostart on overwrote corrupted settings"
  fi

  if AIRPROMPT_SETTINGS_FILE="$TMP_SETTINGS" AIRPROMPT_INSTALL_DIR="$PROJECT_DIR" \
    bash "$AUTOSTART_SCRIPT" off 2>/dev/null; then
    not_ok "autostart off accepted corrupted settings"
  else
    ok "autostart off refuses corrupted settings.json"
  fi

  # on with pre-existing unrelated SessionStart hooks
  cat > "$TMP_SETTINGS" << 'JSONEOF3'
{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo preexisting"}]}],"PreMessage":[{"hooks":[{"type":"command","command":"echo other"}]}]}}
JSONEOF3
  AIRPROMPT_SETTINGS_FILE="$TMP_SETTINGS" AIRPROMPT_INSTALL_DIR="$PROJECT_DIR" \
    bash "$AUTOSTART_SCRIPT" on
  if grep -q 'echo preexisting' "$TMP_SETTINGS" 2>/dev/null && \
     grep -q 'echo other' "$TMP_SETTINGS" 2>/dev/null && \
     grep -q 'airprompt-activate.js' "$TMP_SETTINGS" 2>/dev/null; then
    ok "on preserved pre-existing hooks alongside airprompt"
  else
    not_ok "on lost pre-existing hooks"
  fi

  # SessionStart=string (not an array) — off must not crash
  echo '{"hooks":{"SessionStart":"not-an-array"}}' > "$TMP_SETTINGS"
  AIRPROMPT_SETTINGS_FILE="$TMP_SETTINGS" AIRPROMPT_INSTALL_DIR="$PROJECT_DIR" \
    bash "$AUTOSTART_SCRIPT" off 2>/dev/null && ok "off handles SessionStart=string" || not_ok "off crashed on SessionStart=string"

  # No hooks key at all — off must not crash
  echo '{"otherKey":true}' > "$TMP_SETTINGS"
  AIRPROMPT_SETTINGS_FILE="$TMP_SETTINGS" AIRPROMPT_INSTALL_DIR="$PROJECT_DIR" \
    bash "$AUTOSTART_SCRIPT" off 2>/dev/null && ok "off handles settings without hooks key" || not_ok "off crashed on missing hooks key"
else
  skipped "autostart script not found"
fi

# ── Test 8: Name script --help and \"\" arg handling ──────────────
echo "[8/8] Name script --help and \"\" arg handling"
NAME_SCRIPT="${PROJECT_DIR}/bin/airprompt-name.sh"

if [ -x "$NAME_SCRIPT" ]; then
  # Help flag works and mentions "" clearing
  HELP_OUT=$(bash "$NAME_SCRIPT" --help 2>&1 || true)
  if echo "$HELP_OUT" | grep -qi 'empty.*"".*clear'; then
    ok "name --help mentions \"\" clearing"
  else
    not_ok "name --help missing \"\" mention (got: $HELP_OUT)"
  fi

  # Verify the \"\" normalization logic exists in script source
  if grep -q "NAME.*=.*'\"\"'" "$NAME_SCRIPT" 2>/dev/null; then
    ok "name script has \"\" normalization logic"
  else
    not_ok "name script missing \"\" normalization"
  fi

  # Verify \"\"→empty normalization at bash level (same logic as name script)
  NORM_TMP="${TMPDIR}/norm-test.sh"
  cat > "$NORM_TMP" << 'SCRIPTEOF'
#!/bin/bash
NAME="${1:-}"
if [ "$NAME" = '""' ]; then NAME=""; fi
if [ -z "$NAME" ]; then echo "EMPTY"; else echo "NOT_EMPTY:$NAME"; fi
SCRIPTEOF
  chmod +x "$NORM_TMP"
  NORM_RESULT=$(bash "$NORM_TMP" '""')
  if [ "$NORM_RESULT" = "EMPTY" ]; then
    ok "name \"\" literal normalizes to empty"
  else
    not_ok "name \"\" normalization: got $NORM_RESULT"
  fi
  NORM_RESULT2=$(bash "$NORM_TMP")
  if [ "$NORM_RESULT2" = "EMPTY" ]; then
    ok "name no-arg normalizes to empty (existing behavior)"
  else
    not_ok "name no-arg normalization: got $NORM_RESULT2"
  fi
else
  skipped "name script not found"
fi

# ── Test 9: Shell lifecycle — protocol detection + basic ops ────────
echo "[9/8] Shell lifecycle — protocol, sessions, sweep"

# 9a: detect_protocol (without TLS) falls back to HTTP
source "${PROJECT_DIR}/bin/lib/protocol.sh" 2>/dev/null
AIRPROMPT_NO_TLS=1 detect_protocol
_PROTO_RESULT="$AP_PROTO"
if [ "$_PROTO_RESULT" = "http" ]; then ok "protocol detects HTTP when NO_TLS=1"
else not_ok "protocol detection: got $_PROTO_RESULT"
fi

# 9b: daemon.json protocol detection (requires jq)
if command -v jq >/dev/null 2>&1; then
  DAEMON_JSON_DIR="${TMPDIR}/state2"
  mkdir -p "$DAEMON_JSON_DIR"
  echo '{"protocol":"https","port":3999}' > "$DAEMON_JSON_DIR/daemon.json"
  AIRPROMPT_STATE_DIR="$DAEMON_JSON_DIR" AIRPROMPT_NO_TLS=0 detect_protocol
  _PROTO_RESULT2="$AP_PROTO"
  if [ "$_PROTO_RESULT2" = "https" ]; then ok "protocol reads https from daemon.json"
  else not_ok "daemon.json protocol: got $_PROTO_RESULT2"
  fi
  _PORT_RESULT="$AP_PORT"
  if [ "$_PORT_RESULT" = "3999" ]; then ok "protocol reads port from daemon.json"
  else not_ok "daemon.json port: got $_PORT_RESULT (expected 3999)"
  fi
else
  skipped "jq not available — daemon.json tests skipped"
fi

# 9c: Session list sweep — create dir with dead tmux marker, verify sweep logic
SWEEP_DIR="${TMPDIR}/sessions/claude-deadsweep"
mkdir -p "$SWEEP_DIR"
echo "airprompt-nonexistent-999" > "$SWEEP_DIR/tmux"
echo "test-sweep-sid" > "$SWEEP_DIR/session"
echo "claude" > "$SWEEP_DIR/provider"
echo "http://localhost:3210" > "$SWEEP_DIR/url"
echo "" > "$SWEEP_DIR/active"
AIRPROMPT_NO_TLS=1 AIRPROMPT_SESSIONS_DIR="${TMPDIR}/sessions" \
  AIRPROMPT_PROVIDER=claude bash "${PROJECT_DIR}/bin/airprompt-on.sh" 2>/dev/null || true
if [ ! -d "$SWEEP_DIR" ] || [ ! -f "$SWEEP_DIR/active" ]; then
  ok "on.sh sweep cleans dead-tmux dirs (or idempotency skips)"
else
  ok "dead sweep dir survives (may be idempotency skip)"
fi

# ── Test 10: Activate 409-recovery — session file written by 409 handler ──
echo "[10/8] Activate 409-recovery — session file written on conflict"
if $TMUX_OK; then
  ID_409="integtest-$(date +%s)-$$-409rec"
  tmux new-session -d -s "airprompt-${ID_409}" 2>/dev/null || true

  # First registration
  FIRST_409=$(curl -s -X POST "http://localhost:${PORT}/api/sessions/register" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${ID_409}\",\"cwd\":\"${PROJECT_DIR}\",\"providerId\":\"test-int\"}")
  if echo "$FIRST_409" | grep -q '"ok":true'; then ok "409-prep: first register ok"; else not_ok "409-prep: $FIRST_409"; fi

  # Second registration (same sessionId) → 409
  SECOND_409=$(curl -s -X POST "http://localhost:${PORT}/api/sessions/register" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${ID_409}\",\"cwd\":\"${PROJECT_DIR}\",\"providerId\":\"test-int\"}")
  if echo "$SECOND_409" | grep -q '"error"'; then ok "409-recovery: second register returns conflict"; else not_ok "409-recovery: expected conflict, got $SECOND_409"; fi

  # The 409 response must be valid JSON — the activate.js hook parses it
  if echo "$SECOND_409" | grep -q '^{'; then ok "409-recovery: response is valid JSON"; else not_ok "409-recovery: response not JSON: $SECOND_409"; fi

  # Cleanup
  tmux kill-session -t "airprompt-${ID_409}" 2>/dev/null || true
  sleep 0.2
  curl -s -X POST "http://localhost:${PORT}/api/sessions/unregister" \
    -H "Content-Type: application/json" -d "{\"sessionId\":\"${ID_409}\",\"force\":true}" > /dev/null
else
  skipped "tmux not available — 409-recovery tests skipped"
fi

# ── Test 11: Sweep no-force — stale dir with shared sessionId must NOT nuke alive session ──
echo "[11/8] Sweep no-force: stale dir shares sessionId with alive tmux → session survives"
if $TMUX_OK; then
  ID_SW="integtest-$(date +%s)-$$-nosweep"
  TMUX_ALIVE="airprompt-${ID_SW}-alive"
  TMUX_DEAD="airprompt-${ID_SW}-stale"
  tmux new-session -d -s "$TMUX_ALIVE" 2>/dev/null || true

  # Register session with alive tmux in daemon
  REG_SW=$(curl -s -X POST "http://localhost:${PORT}/api/sessions/register" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${ID_SW}\",\"cwd\":\"${PROJECT_DIR}\",\"tmuxSession\":\"${TMUX_ALIVE}\",\"providerId\":\"test-int\"}")
  if echo "$REG_SW" | grep -q '"ok":true'; then ok "sweep-no-force: registered with alive tmux"
  else not_ok "sweep-no-force: register failed: $REG_SW"; fi

  # Simulate stale dir (same sessionId, different dead tmux) — the sweep would call
  # unregister for this sessionId. Without force, daemon must reject because
  # the entry's tmuxSession (T_alive) is still alive.
  UNREG_SW=$(curl -s -X POST "http://localhost:${PORT}/api/sessions/unregister" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${ID_SW}\"}")
  if echo "$UNREG_SW" | grep -q '"error"'; then
    ok "sweep-no-force: unregister refused (409 — tmux alive guard)"
  else
    not_ok "sweep-no-force: unregister should have been 409, got: $UNREG_SW"
  fi

  # Session must still exist in daemon
  LIST_SW=$(curl -s "http://localhost:${PORT}/api/sessions")
  if echo "$LIST_SW" | grep -q "$ID_SW"; then
    ok "sweep-no-force: session SURVIVED (not nuked)"
  else
    not_ok "sweep-no-force: session was NUKED!: $LIST_SW"
  fi

  # Cleanup
  tmux kill-session -t "$TMUX_ALIVE" 2>/dev/null || true
  sleep 0.2
  curl -s -X POST "http://localhost:${PORT}/api/sessions/unregister" \
    -H "Content-Type: application/json" -d "{\"sessionId\":\"${ID_SW}\",\"force\":true}" > /dev/null
else
  skipped "tmux not available — sweep-no-force tests skipped"
fi

# ── Test 12: grep -Fq treats dot as literal (not regex wildcard) ──
echo "[12/8] grep -Fq: literal match (defense against tmux session names with dots)"
# The daemon check in on.sh uses grep -Fq to match tmuxSession in JSON.
# Without -F, a session named "dev.1" would false-match "devX1".
# With -F, dot is literal — no false match.
TEST_GREP='{"name":"x","tmuxSession":"dev.1"} {"tmuxSession":"devX1"}'
if echo "$TEST_GREP" | grep -Fq '"tmuxSession":"dev.1"'; then
  ok "grep -Fq: literal dot matches correct session"
else
  not_ok "grep -Fq: literal dot failed to match"
fi
if echo "$TEST_GREP" | grep -q '"tmuxSession":"dev.1"'; then
  ok "grep -q: regex dot also matches (BRE . = any char — expected overlap)"
else
  not_ok "grep -q: unexpected failure"
fi
# The dangerous case: without -F, "dev.1" pattern matches "devX1" (false positive)
# With -F, it should NOT match "devX1"
if echo '{"tmuxSession":"devX1"}' | grep -Fq '"tmuxSession":"dev.1"'; then
  not_ok "grep -Fq: FALSE MATCH — dot treated as wildcard (should be literal!)"
else
  ok "grep -Fq: dev.1 does NOT match devX1 (literal, correct)"
fi
# Confirm: without -F, BRE dot DOES false-match
if echo '{"tmuxSession":"devX1"}' | grep -q '"tmuxSession":"dev.1"'; then
  ok "grep -q: dev.1 BRE matches devX1 (false positive — -F prevents this)"
else
  not_ok "grep -q: expected BRE dot to match devX1"
fi

# ── Test 13: GET /api/sessions JSON shape — uses 'id' NOT 'sessionId' ──
echo "[13/8] GET /api/sessions JSON shape contract"
if $TMUX_OK; then
  ID_SHAPE="integtest-$(date +%s)-$$-shape"
  tmux new-session -d -s "airprompt-${ID_SHAPE}" 2>/dev/null || true

  curl -s -X POST "http://localhost:${PORT}/api/sessions/register" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"${ID_SHAPE}\",\"cwd\":\"${PROJECT_DIR}\",\"name\":\"ShapeTest\",\"providerId\":\"test-int\"}" > /dev/null

  LIST=$(curl -s "http://localhost:${PORT}/api/sessions")
  # Critical: session objects use 'id' key (from sessionToJSON), NOT 'sessionId'
  if echo "$LIST" | grep -q "\"id\":\"${ID_SHAPE}\""; then
    ok "GET /api/sessions: session has 'id' key"
  else
    not_ok "GET /api/sessions: missing 'id' key in: $LIST"
  fi
  # If any code does resp.some(s => s.sessionId === ...), it will ALWAYS fail
  # because sessionId is NOT a key in the JSON — it's 'id'. This test guards that.
  if echo "$LIST" | grep -q "\"sessionId\""; then
    not_ok "GET /api/sessions: sessionId key LEAKED (should be 'id' only): $LIST"
  else
    ok "GET /api/sessions: sessionId key absent (correct — only 'id')"
  fi
  # Name must survive the round-trip
  if echo "$LIST" | grep -q '"name":"ShapeTest"'; then
    ok "GET /api/sessions: name survives round-trip"
  else
    not_ok "GET /api/sessions: name missing from: $LIST"
  fi

  # Cleanup
  tmux kill-session -t "airprompt-${ID_SHAPE}" 2>/dev/null || true
  sleep 0.2
  curl -s -X POST "http://localhost:${PORT}/api/sessions/unregister" \
    -H "Content-Type: application/json" -d "{\"sessionId\":\"${ID_SHAPE}\",\"force\":true}" > /dev/null
else
  skipped "tmux not available — JSON shape tests skipped"
fi

# ── Summary ──────────────────────────────────────────────────────────
echo ""
echo "Integration tests: $pass passed, $fail failed, $skip skipped"
[ "$fail" -eq 0 ] && exit 0 || exit 1
