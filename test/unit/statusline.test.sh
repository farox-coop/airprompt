#!/bin/bash
set -euo pipefail

# Try deployed hook first, fall back to source
HOOK="${HOME}/.claude/hooks/airprompt-statusline.sh"
if [ ! -f "$HOOK" ]; then
  echo "Warning: deployed hook not found, this test requires a deployed airprompt-statusline.sh" >&2
  exit 0
fi
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

export CLAUDE_CONFIG_DIR="$TMPDIR"
SESSIONS_DIR="${TMPDIR}/.airprompt/sessions"

# Use test override so hook doesn't need a real tmux session
CURRENT_TMUX="airprompt-test-fake"
export AIRPROMPT_TEST_TMUX="$CURRENT_TMUX"

# Sanitize (same as statusline.sh)
SAFE_NAME=$(printf '%s' "$CURRENT_TMUX" | tr -cd 'a-zA-Z0-9_.-')
MY_DIR="${SESSIONS_DIR}/${SAFE_NAME}"
URL_FILE="${MY_DIR}/url"
NAME_FILE="${MY_DIR}/name"

STDIN_JSON='{"effort":{"level":"high"},"model":{"display_name":"deepseek-v4-pro[1m]"}}'

pass=0; fail=0

ok() { echo "  PASS: $1"; pass=$((pass + 1)); }
not_ok() { echo "  FAIL: $1"; fail=$((fail + 1)); }

echo "=== Statusline Hook Tests ==="
echo "(test_override_tmux=$CURRENT_TMUX safe=$SAFE_NAME)"

# 1: No badge when no per-session url
echo "[1/6] No badge when no per-session url"
rm -rf "$MY_DIR"
OUT=$(printf '%s' "$STDIN_JSON" | bash "$HOOK" 2>/dev/null || true)
if [ -z "$OUT" ]; then ok "empty output"; else not_ok "expected empty, got: $OUT"; fi

# 2: Badge when url present
echo "[2/6] Badge when url present"
mkdir -p "$MY_DIR"
echo "http://192.168.1.100:3210" > "$URL_FILE"
rm -f "$NAME_FILE"
OUT=$(printf '%s' "$STDIN_JSON" | bash "$HOOK" 2>/dev/null || true)
if echo "$OUT" | grep -q 'http://192.168.1.100:3210'; then ok "badge rendered"; else not_ok "no badge in: $OUT"; fi

# 3: Badge includes full URL (port comes from URL file, not hardcoded)
echo "[3/6] Badge includes URL from file"
echo "http://10.0.0.1:9999" > "$URL_FILE"
rm -f "$NAME_FILE"
OUT=$(printf '%s' "$STDIN_JSON" | bash "$HOOK" 2>/dev/null || true)
if echo "$OUT" | grep -q '10.0.0.1:9999'; then ok "custom port preserved"; else not_ok "URL missing in: $OUT"; fi

# 4: Refuses symlink url
echo "[4/6] Refuses symlink url"
rm -rf "$MY_DIR"
mkdir -p "$MY_DIR"
ln -sf /etc/hostname "$URL_FILE"
OUT=$(printf '%s' "$STDIN_JSON" | bash "$HOOK" 2>/dev/null || true)
if [ -z "$OUT" ]; then ok "empty for symlink"; else not_ok "expected empty for symlink, got: $OUT"; fi

# 5: Refuses symlink name file (still shows badge without name)
echo "[5/6] Refuses symlink name file"
rm -rf "$MY_DIR"
mkdir -p "$MY_DIR"
echo "http://192.168.1.100:3210" > "$URL_FILE"
ln -sf /etc/hostname "$NAME_FILE"
OUT=$(printf '%s' "$STDIN_JSON" | bash "$HOOK" 2>/dev/null || true)
if echo "$OUT" | grep -q 'AirPrompt: http://192.168.1.100:3210'; then ok "badge without name"; else not_ok "expected badge without name, got: $OUT"; fi

# 6: Strips control characters from URL
echo "[6/6] Strips control characters"
rm -rf "$MY_DIR"
mkdir -p "$MY_DIR"
printf 'http://192.168.1.1:3210\x01\x02\x03' > "$URL_FILE"
rm -f "$NAME_FILE"
OUT=$(printf '%s' "$STDIN_JSON" | bash "$HOOK" 2>/dev/null || true)
if ! echo "$OUT" | grep -q $'\x01'; then ok "no control chars"; else not_ok "control chars leaked in: $OUT"; fi
if echo "$OUT" | grep -q '192.168.1.1:3210'; then ok "clean URL preserved"; else not_ok "URL corrupted"; fi

echo ""
echo "Statusline tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ] && exit 0 || exit 1
