#!/usr/bin/env bash
set -euo pipefail
# ── sync.sh unit tests ────────────────────────────────────────────────

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
REPO_ROOT="$(repo_root)"
SYNC_SH="$REPO_ROOT/.claude/skills/sync-claude/sync.sh"

ok()  { echo "  PASS: $1"; }
not_ok() { echo "  FAIL: $1"; ((FAILS++)) || true; }
FAILS=0

echo "=== sync.sh unit tests ==="

# ── Test 1: script has valid bash syntax ────────────────────────────
echo "[1/8] Syntax check"
if bash -n "$SYNC_SH" 2>&1; then ok "valid bash syntax"; else not_ok "syntax error"; fi

# ── Test 2: no hardcoded user home path ─────────────────────────────
echo "[2/8] No hardcoded user home path"
if grep -nE '/home/[a-z]+' "$SYNC_SH" 2>/dev/null; then
  not_ok "found a hardcoded /home/<user> path in sync.sh"
else
  ok "no hardcoded home path"
fi

# ── Test 3: no hardcoded farox-coop publisher ──────────────────────
echo "[3/8] No hardcoded farox-coop in CACHE_BASE"
# The CACHE_BASE line must use glob discovery, not hardcode farox-coop
if grep -n 'CACHE_BASE=' "$SYNC_SH" | grep -q 'farox-coop'; then
  not_ok "CACHE_BASE hardcodes farox-coop"
else
  ok "CACHE_BASE is dynamic (glob-based)"
fi

# ── Test 4: REPO detection uses git rev-parse (not hardcoded) ───────
echo "[4/8] REPO uses git rev-parse"
if grep -n 'REPO=' "$SYNC_SH" | grep -q 'git rev-parse'; then
  ok "REPO detected via git rev-parse"
else
  not_ok "REPO not using git rev-parse"
fi

# ── Test 5: zero caches is a noop (not a fatal error) ──────────────
echo "[5/8] Zero plugin caches is not fatal"
if grep -q 'no plugin caches' "$SYNC_SH" && grep -q 'plugins/cache/' "$SYNC_SH"; then
  ok "zero caches handled gracefully (noop, not fatal error)"
else
  not_ok "sync.sh must handle zero caches (search for 'no plugin caches' + 'plugins/cache/')"
fi

# ── Test 6: HOOKS and BINS arrays match repo files ──────────────────
echo "[6/8] HOOKS+BINS arrays reference existing files"
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

# ── Test 7: script runs successfully from repo root (fresh HOME) ──────
# Isolate HOME so sync.sh must create the config dir itself — a fresh machine
# (or CI runner) has none. CLAUDE_CONFIG_DIR must be pinned too: sync.sh honours
# it, so an exported value would make it sync (and prune) the developer's REAL
# config dir, HOME or no HOME. Also avoids mutating ~/bin as a side effect.
echo "[7/8] End-to-end sync from repo root (fresh HOME)"
cd "$REPO_ROOT"
FAKE_HOME=$(mktemp -d)
OUT=$(HOME="$FAKE_HOME" CLAUDE_CONFIG_DIR="$FAKE_HOME/.claude" bash "$SYNC_SH" 2>&1) && rc=$? || rc=$?
rm -rf "$FAKE_HOME"
if [ "$rc" -eq 0 ] && echo "$OUT" | grep -q "SYNCED OK"; then
  ok "sync completed ($(echo "$OUT" | grep 'SYNCED OK' | head -1))"
else
  not_ok "sync failed (rc=$rc): $(echo "$OUT" | head -3)"
fi

# ── Test 8: prune never deletes the dir Claude Code records ─────────
# `installed_plugins.json` pins an installPath. Deleting that dir is what
# produces `Plugin "airprompt" not cached at <path>` in /plugin. Asserted by
# running the prune against a fabricated cache — a grep for the guard would
# stay green with the guard reduced to dead code.
echo "[8/8] Prune protects the recorded installPath + in-use dirs"
FAKE_HOME=$(mktemp -d)
CACHE="$FAKE_HOME/.claude/plugins/cache/fake-airprompt/airprompt"
mkdir -p "$FAKE_HOME/.claude/plugins" "$CACHE"
for d in a b c d e; do mkdir -p "$CACHE/$d/src/hooks" "$CACHE/$d/src/providers" "$CACHE/$d/src/hooks/core" "$CACHE/$d/bin" "$CACHE/$d/commands"; done
mkdir -p "$CACHE/a/.in_use"
printf '{"pid":%s}' "$$" > "$CACHE/a/.in_use/$$"                             # a: live session pid
printf '{"version":2,"plugins":{"airprompt@x":[{"installPath":"%s/b"}]}}' "$CACHE" \
  > "$FAKE_HOME/.claude/plugins/installed_plugins.json"                       # b: recorded
# Stamp mtimes last — creating a/.in_use rewrites a's mtime. a oldest → e newest.
touch -t 202001010001 "$CACHE/a"; touch -t 202001010002 "$CACHE/b"; touch -t 202001010003 "$CACHE/c"
touch -t 202001010004 "$CACHE/d"; touch -t 202001010005 "$CACHE/e"
# A foreign HOME breaks the asdf/mise `node` shim, and sync.sh needs node to
# read the record, so put the real binary's directory in front of PATH.
NODE_DIR=$(dirname "$(node -p 'process.execPath' 2>/dev/null || echo /nonexistent/node)")
( cd "$REPO_ROOT" && HOME="$FAKE_HOME" CLAUDE_CONFIG_DIR="$FAKE_HOME/.claude" PATH="$NODE_DIR:$PATH" bash "$SYNC_SH" >/dev/null 2>&1 ) || true
KEPT_A=$([ -d "$CACHE/a" ] && echo yes || echo no)
KEPT_B=$([ -d "$CACHE/b" ] && echo yes || echo no)
KEPT_E=$([ -d "$CACHE/e" ] && echo yes || echo no)
PRUNED_C=$([ -d "$CACHE/c" ] && echo no || echo yes)
rm -rf "$FAKE_HOME"
if [ "$KEPT_A" = yes ] && [ "$KEPT_B" = yes ] && [ "$KEPT_E" = yes ] && [ "$PRUNED_C" = yes ]; then
  ok "recorded + in-use caches survive; stale dir pruned"
else
  not_ok "prune wrong (in-use=$KEPT_A recorded=$KEPT_B newest=$KEPT_E stale-pruned=$PRUNED_C)"
fi

# ── Result ────────────────────────────────────────────────────────────
echo ""
if [ "$FAILS" -eq 0 ]; then
  echo "sync.sh tests: 8 passed, 0 failed"
else
  echo "sync.sh tests: $((8 - FAILS)) passed, $FAILS failed"
  exit 1
fi
