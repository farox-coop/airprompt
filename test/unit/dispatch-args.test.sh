#!/usr/bin/env bash
set -euo pipefail
# ── airprompt dispatcher argument-forwarding unit tests ────────────────
# The dispatcher picks its install dir from AIRPROMPT_INSTALL_DIR first, so a
# temp install holding stub sub-scripts is enough to observe exactly what it
# passes through — no daemon, no tmux, no real session involved.
#
# `off` needs this coverage more than the rest: airprompt-off.sh reads an
# optional sessionId from $1, and for a long time the dispatcher's catch-all
# branch ran the sub-script with no arguments at all, so `airprompt off
# <sessionId>` silently degraded to "unregister the current session" — which
# then found nothing, because the way to know the current session is $TMUX.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
REPO_ROOT="$(repo_root)"

ok()  { echo "  PASS: $1"; }
not_ok() { echo "  FAIL: $1"; ((FAILS++)) || true; }
FAILS=0

echo "=== dispatcher argument-forwarding unit tests ==="

STUB_DIR="$(mktemp -d)"
FAKE_HOME="$(mktemp -d)"
mkdir -p "$STUB_DIR/bin" "$FAKE_HOME/bin"
for s in on off name auth status clean restart autostart update; do
  printf '#!/bin/bash\nprintf "%%s\\n" "$@"\n' > "$STUB_DIR/bin/airprompt-${s}.sh"
  chmod +x "$STUB_DIR/bin/airprompt-${s}.sh"
done
trap 'rm -rf "$STUB_DIR" "$FAKE_HOME"' EXIT

# TMUX is set because the dispatcher's "not inside tmux" warning goes to STDOUT,
# where it would land in the argv these cases assert on. A non-empty TMUX is also
# the ordinary case: every command here is meant to run inside a session.
dispatch() { # dispatch <args...> — the sub-script's argv, one element per line
  TMUX=/tmp/fake,1,0 HOME="$FAKE_HOME" AIRPROMPT_INSTALL_DIR="$STUB_DIR" \
    AIRPROMPT_PROVIDER=claude \
    bash "$REPO_ROOT/bin/airprompt" "$@" 2>/dev/null || true
}

# Warm-up: the dispatcher restores ~/bin symlinks + wrappers on every run and
# announces each one it creates. Let it do that into the throwaway HOME first,
# so the assertions below see only the sub-script's argv.
dispatch status >/dev/null

# ── 1. off forwards its sessionId ─────────────────────────────────────
echo "[1/4] off <sessionId> reaches the sub-script"
got="$(dispatch off airprompt-1753684-1791935642)"
if [ "$got" = "airprompt-1753684-1791935642" ]; then
  ok "off airprompt-… → sub-script argv [airprompt-…]"
else
  not_ok "off dropped its argument — sub-script argv was [$got]"
fi

# ── 2. off with no argument is still the current-session form ─────────
echo "[2/4] off with no argument passes nothing"
got="$(dispatch off)"
if [ -z "$got" ]; then
  ok "off → sub-script argv [] (it resolves its own session)"
else
  not_ok "off invented an argument: [$got]"
fi

# ── 3. on still maps a positional to --name ───────────────────────────
# The off branch sits next to this one; a stray fallthrough would land here.
echo "[3/4] on <name> still becomes --name <name>"
got="$(dispatch on Roostead)"
expected=$'--name\nRoostead'
if [ "$got" = "$expected" ]; then
  ok "on Roostead → sub-script argv [--name Roostead]"
else
  not_ok "on mangled its name argument: [$(printf '%s' "$got" | tr '\n' ' ')]"
fi

# ── 4. name still forwards as-is ──────────────────────────────────────
echo "[4/4] name forwards its argument unchanged"
got="$(dispatch name Roostead)"
if [ "$got" = "Roostead" ]; then
  ok "name Roostead → sub-script argv [Roostead]"
else
  not_ok "name mangled its argument: [$got]"
fi

# ── Result ────────────────────────────────────────────────────────────
echo ""
if [ "$FAILS" -eq 0 ]; then
  echo "dispatcher argument tests: 4 passed, 0 failed"
else
  echo "dispatcher argument tests: $((4 - FAILS)) passed, $FAILS failed"
  exit 1
fi
