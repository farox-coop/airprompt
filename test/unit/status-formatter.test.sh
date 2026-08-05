#!/bin/bash
set -euo pipefail

# Resolve formatter location
FORMATTER=""
for d in "${AIRPROMPT_INSTALL_DIR:-}" "$HOME/.airprompt" "$HOME/projects/airprompt"; do
  if [ -f "$d/src/status-formatter.js" ]; then FORMATTER="$d/src/status-formatter.js"; break; fi
done
if [ -z "$FORMATTER" ]; then
  echo "SKIP: status-formatter.js not found (needs sync-claude or dev checkout)" >&2
  exit 0
fi

pass=0; fail=0

ok() { echo "  PASS: $1"; pass=$((pass + 1)); }
not_ok() { echo "  FAIL: $1"; fail=$((fail + 1)); }

echo "=== Status Formatter Tests ==="

# 1: Empty array
echo "[1/6] Empty array"
OUT=$(echo '[]' | node "$FORMATTER" 2>/dev/null || true)
if echo "$OUT" | grep -q 'none registered'; then ok "shows none registered"; else not_ok "expected none registered, got: $OUT"; fi

# 2: Malformed JSON
echo "[2/6] Malformed JSON"
OUT=$(echo '{bad' | node "$FORMATTER" 2>/dev/null || true)
if echo "$OUT" | grep -q 'unparseable'; then ok "shows unparseable"; else not_ok "expected unparseable, got: $OUT"; fi

# 3: Mirror session
echo "[3/6] Mirror session type"
OUT=$(echo '[{"id":"t1","cwd":"/tmp","name":"Test","tmuxSession":"airprompt-t1","createdAt":"2026-07-31T19:00:00.000Z","isMirror":true,"isActive":true,"tmuxAlive":true,"attachedClients":2,"lastActivity":null}]' | node "$FORMATTER" 2>/dev/null)
if echo "$OUT" | grep -q 'MIRROR'; then ok "shows MIRROR type"; else not_ok "expected MIRROR, got: $OUT"; fi
if echo "$OUT" | grep -q 'Clients attached: 2'; then ok "shows client count"; else not_ok "expected Clients attached: 2, got: $OUT"; fi

# 4: Real session
echo "[4/6] Real session type"
OUT=$(echo '[{"id":"t2","cwd":"/home","name":null,"tmuxSession":"claude-real","createdAt":"2026-07-30T10:00:00.000Z","isMirror":false,"isActive":true,"tmuxAlive":true,"attachedClients":0,"lastActivity":null}]' | node "$FORMATTER" 2>/dev/null)
if echo "$OUT" | grep -q 'REAL'; then ok "shows REAL type"; else not_ok "expected REAL, got: $OUT"; fi
if echo "$OUT" | grep -q '(unnamed)'; then ok "shows (unnamed) for null name"; else not_ok "expected (unnamed), got: $OUT"; fi

# 5: Dead tmux
echo "[5/6] Dead tmux session"
OUT=$(echo '[{"id":"t3","cwd":"/tmp","name":"Dead","tmuxSession":"airprompt-t3","createdAt":"2026-07-31T00:00:00.000Z","isMirror":true,"isActive":false,"tmuxAlive":false,"attachedClients":0,"lastActivity":null}]' | node "$FORMATTER" 2>/dev/null)
if echo "$OUT" | grep -q 'DEAD'; then ok "shows DEAD liveness"; else not_ok "expected DEAD, got: $OUT"; fi
if echo "$OUT" | grep -q 'Statusline badge: no'; then ok "shows badge no"; else not_ok "expected Statusline badge: no, got: $OUT"; fi

# 6: Missing fields use defaults
echo "[6/6] Missing fields"
OUT=$(echo '[{"id":"t4","cwd":"/tmp","tmuxSession":"airprompt-t4","createdAt":"bad-date"}]' | node "$FORMATTER" 2>/dev/null)
if echo "$OUT" | grep -q 'Tmux alive:   DEAD'; then ok "defaults tmuxAlive to DEAD"; else not_ok "expected DEAD default, got: $OUT"; fi
if echo "$OUT" | grep -q 'Last activity: ?'; then ok "defaults idle to ?"; else not_ok "expected ?, got: $OUT"; fi

echo ""
echo "Status formatter tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ] && exit 0 || exit 1
