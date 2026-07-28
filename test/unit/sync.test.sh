#!/usr/bin/env bash
set -euo pipefail
# ── sync.sh unit tests ────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)"
SYNC_SH="$REPO_ROOT/.claude/skills/sync-claude/sync.sh"

ok()  { echo "  PASS: $1"; }
not_ok() { echo "  FAIL: $1"; ((FAILS++)) || true; }
FAILS=0

echo "=== sync.sh unit tests ==="

# ── Test 1: script has valid bash syntax ────────────────────────────
echo "[1/7] Syntax check"
if bash -n "$SYNC_SH" 2>&1; then ok "valid bash syntax"; else not_ok "syntax error"; fi

# ── Test 2: no hardcoded /home/diego paths ──────────────────────────
echo "[2/7] No hardcoded /home/diego paths"
if grep -n '/home/diego' "$SYNC_SH" 2>/dev/null; then
  not_ok "found /home/diego in sync.sh"
else
  ok "no /home/diego hardcoded"
fi

# ── Test 3: no hardcoded diegomanuel publisher ──────────────────────
echo "[3/7] No hardcoded diegomanuel in CACHE_BASE"
# The CACHE_BASE line must use glob discovery, not hardcode diegomanuel
if grep -n 'CACHE_BASE=' "$SYNC_SH" | grep -q 'diegomanuel'; then
  not_ok "CACHE_BASE hardcodes diegomanuel"
else
  ok "CACHE_BASE is dynamic (glob-based)"
fi

# ── Test 4: REPO detection uses git rev-parse (not hardcoded) ───────
echo "[4/7] REPO uses git rev-parse"
if grep -n 'REPO=' "$SYNC_SH" | grep -q 'git rev-parse'; then
  ok "REPO detected via git rev-parse"
else
  not_ok "REPO not using git rev-parse"
fi

# ── Test 5: error message mentions glob pattern ─────────────────────
echo "[5/7] Cache-not-found error message is helpful"
if grep -q 'plugins/cache/\*' "$SYNC_SH" && grep -q 'plugin marketplace add' "$SYNC_SH"; then
  ok "error message shows glob pattern + install hint"
else
  not_ok "error message missing glob or install hint"
fi

# ── Test 6: HOOKS and BINS arrays match repo files ──────────────────
echo "[6/7] HOOKS+BINS arrays reference existing files"
HOOKS=($(grep '^HOOKS=' "$SYNC_SH" | head -1 | sed "s/.*=(//;s/)//" | tr -d '"'))
BINS=($(grep '^BINS=' "$SYNC_SH" | head -1 | sed "s/.*=(//;s/)//" | tr -d '"'))
all_ok=1
for h in "${HOOKS[@]}"; do
  if [ ! -f "$REPO_ROOT/src/hooks/$h" ]; then
    echo "    MISSING: src/hooks/$h"
    all_ok=0
  fi
done
for b in "${BINS[@]}"; do
  if [ ! -f "$REPO_ROOT/bin/$b" ]; then
    echo "    MISSING: bin/$b"
    all_ok=0
  fi
done
if [ "$all_ok" -eq 1 ]; then ok "all ${#HOOKS[@]} hooks + ${#BINS[@]} bins exist"; else not_ok "some files missing"; fi

# ── Test 7: script runs successfully from repo root ──────────────────
echo "[7/7] End-to-end sync from repo root"
cd "$REPO_ROOT"
OUT=$(bash "$SYNC_SH" 2>&1) && rc=$? || rc=$?
if [ "$rc" -eq 0 ] && echo "$OUT" | grep -q "SYNCED OK"; then
  ok "sync completed ($(echo "$OUT" | grep 'SYNCED OK' | head -1))"
else
  not_ok "sync failed (rc=$rc): $(echo "$OUT" | head -3)"
fi

# ── Result ────────────────────────────────────────────────────────────
echo ""
if [ "$FAILS" -eq 0 ]; then
  echo "sync.sh tests: 7 passed, 0 failed"
else
  echo "sync.sh tests: $((7 - FAILS)) passed, $FAILS failed"
  exit 1
fi
