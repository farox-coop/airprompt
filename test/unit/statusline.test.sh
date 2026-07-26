#!/bin/bash
set -euo pipefail

# Try deployed hook first, fall back to copying from known location
HOOK="${HOME}/.claude/hooks/airprompt-statusline.sh"
if [ ! -f "$HOOK" ]; then
  echo "Warning: deployed hook not found, this test requires a deployed airprompt-statusline.sh" >&2
  exit 0
fi
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

export CLAUDE_CONFIG_DIR="$TMPDIR"
MARKER="${TMPDIR}/.airprompt-active"
URL_FILE="${TMPDIR}/.airprompt-url"

STDIN_JSON='{"effort":{"level":"high"},"model":{"display_name":"deepseek-v4-pro[1m]"}}'

pass=0; fail=0

ok() { echo "  PASS: $1"; pass=$((pass + 1)); }
not_ok() { echo "  FAIL: $1"; fail=$((fail + 1)); }

echo "=== Statusline Hook Tests ==="

# 1: No badge when marker absent
echo "[1/6] No badge when marker absent"
rm -f "$MARKER" "$URL_FILE"
OUT=$(printf '%s' "$STDIN_JSON" | bash "$HOOK" 2>/dev/null || true)
if [ -z "$OUT" ]; then ok "empty output"; else not_ok "expected empty, got: $OUT"; fi

# 2: Badge when marker present
echo "[2/6] Badge when marker present"
touch "$MARKER"
echo "http://192.168.1.100:3210" > "$URL_FILE"
OUT=$(printf '%s' "$STDIN_JSON" | bash "$HOOK" 2>/dev/null || true)
if echo "$OUT" | grep -q '\[airprompt: http://'; then ok "badge rendered"; else not_ok "no badge in: $OUT"; fi

# 3: Badge includes full URL (port comes from URL file, not hardcoded)
echo "[3/6] Badge includes URL from file"
touch "$MARKER"
echo "http://10.0.0.1:9999" > "$URL_FILE"
OUT=$(printf '%s' "$STDIN_JSON" | bash "$HOOK" 2>/dev/null || true)
if echo "$OUT" | grep -q '10.0.0.1:9999'; then ok "custom port preserved"; else not_ok "URL missing in: $OUT"; fi

# 4: Refuses symlink marker
echo "[4/6] Refuses symlink marker"
rm -f "$MARKER" "$URL_FILE"
ln -sf "$URL_FILE" "$MARKER"
OUT=$(printf '%s' "$STDIN_JSON" | bash "$HOOK" 2>/dev/null || true)
if [ -z "$OUT" ]; then ok "empty for symlink"; else not_ok "expected empty for symlink, got: $OUT"; fi

# 5: Refuses symlink URL file
echo "[5/6] Refuses symlink URL file"
rm -f "$MARKER" "$URL_FILE"
touch "$MARKER"
ln -sf /etc/hostname "$URL_FILE"
OUT=$(printf '%s' "$STDIN_JSON" | bash "$HOOK" 2>/dev/null || true)
if [ -z "$OUT" ]; then ok "empty for URL symlink"; else not_ok "expected empty for URL symlink, got: $OUT"; fi

# 6: Strips control characters from URL
echo "[6/6] Strips control characters"
rm -f "$MARKER" "$URL_FILE"
touch "$MARKER"
printf 'http://192.168.1.1:3210\x01\x02\x03' > "$URL_FILE"
OUT=$(printf '%s' "$STDIN_JSON" | bash "$HOOK" 2>/dev/null || true)
if ! echo "$OUT" | grep -q $'\x01'; then ok "no control chars"; else not_ok "control chars leaked in: $OUT"; fi
if echo "$OUT" | grep -q '192.168.1.1:3210'; then ok "clean URL preserved"; else not_ok "URL corrupted"; fi

echo ""
echo "Statusline tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ] && exit 0 || exit 1
