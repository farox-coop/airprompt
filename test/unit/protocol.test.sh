#!/usr/bin/env bash
set -euo pipefail
# ── protocol.sh portable-helper unit tests ─────────────────────────────
# Verifies the Linux branch of the macOS-portability helpers. The macOS-only
# branches are exercised deterministically: `ipconfig getifaddr` via function
# stubs, `md5 -q` via a PATH shim that hides `md5sum`.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
REPO_ROOT="$(repo_root)"
source "$REPO_ROOT/bin/lib/protocol.sh"

ok()  { echo "  PASS: $1"; }
not_ok() { echo "  FAIL: $1"; ((FAILS++)) || true; }
FAILS=0

echo "=== protocol.sh helper unit tests ==="

# ── 1. _md5: Linux md5sum path matches `md5sum | awk` ────────────────
echo "[1/8] _md5 matches md5sum"
TMP=$(mktemp)
printf 'airprompt test payload\n' > "$TMP"
expected=$(md5sum "$TMP" | awk '{print $1}')
got=$(_md5 "$TMP")
rm -f "$TMP"
if [ -n "$got" ] && [ "$got" = "$expected" ]; then
  ok "_md5 = $got"
else
  not_ok "_md5 mismatch: got=[$got] expected=[$expected]"
fi

# ── 2. _md5: macOS `md5 -q` fallback (md5sum hidden via PATH shim) ────
echo "[2/8] _md5 md5 -q fallback"
TMPBIN=$(mktemp -d)
printf '#!/bin/bash\nprintf "deadbeefdeadbeef\\n"\n' > "$TMPBIN/md5"
chmod +x "$TMPBIN/md5"
TMPF=$(mktemp)
printf 'x\n' > "$TMPF"
got=$(PATH="$TMPBIN" _md5 "$TMPF")
if [ "$got" = "deadbeefdeadbeef" ]; then
  ok "_md5 md5 -q fallback = deadbeefdeadbeef"
else
  not_ok "_md5 md5 -q fallback got [$got]"
fi
rm -rf "$TMPBIN" "$TMPF"

# ── 3. _is_airprompt_pid: positive (live `node server.js`) ────────────
# COLUMNS=15 simulates a narrow tmux pane — the helper must override ps
# truncation so a live daemon still matches.
echo "[3/8] _is_airprompt_pid positive (node server.js, COLUMNS=15)"
TMPDIR=$(mktemp -d)
printf 'setTimeout(() => {}, 30000);\n' > "$TMPDIR/server.js"
node "$TMPDIR/server.js" & NODE_PID=$!
sleep 0.5
if COLUMNS=15 _is_airprompt_pid "$NODE_PID"; then
  ok "_is_airprompt_pid($NODE_PID) = true"
else
  not_ok "_is_airprompt_pid($NODE_PID) should be true (cmd: $(COLUMNS=9999 ps -p "$NODE_PID" -o command= 2>/dev/null))"
fi
kill "$NODE_PID" 2>/dev/null || true
rm -rf "$TMPDIR"

# ── 4. _is_airprompt_pid: negative (sleep, no server.js) ──────────────
echo "[4/8] _is_airprompt_pid negative (sleep)"
sleep 30 & SLEEP_PID=$!
if _is_airprompt_pid "$SLEEP_PID"; then
  not_ok "_is_airprompt_pid($SLEEP_PID) should be false"
else
  ok "_is_airprompt_pid($SLEEP_PID) = false"
fi
kill "$SLEEP_PID" 2>/dev/null || true

# ── 5. _is_airprompt_pid: empty + dead pid ────────────────────────────
echo "[5/8] _is_airprompt_pid empty + dead pid"
if _is_airprompt_pid ""; then not_ok "empty pid should be false"; else ok "empty pid = false"; fi
if _is_airprompt_pid "999999999"; then not_ok "dead pid should be false"; else ok "dead pid = false"; fi

# ── 6. _lan_ip: returns a non-empty value on this host ─────────────────
echo "[6/8] _lan_ip returns non-empty"
ip=$(_lan_ip)
if [ -n "$ip" ]; then ok "_lan_ip = $ip"; else not_ok "_lan_ip returned empty"; fi

# ── 7. _lan_ip: macOS fallback branch (ipconfig getifaddr) ────────────
# Stub out hostname (Linux path fails) + ipconfig (macOS path) to force the
# non-Linux branches deterministically on a Linux box.
echo "[7/8] _lan_ip ipconfig fallback + localhost fallback"
hostname() { return 1; }
ipconfig() { echo "10.20.30.40"; }
got=$(_lan_ip)
if [ "$got" = "10.20.30.40" ]; then ok "ipconfig fallback = 10.20.30.40"; else not_ok "ipconfig fallback got [$got]"; fi
ipconfig() { return 1; }
got=$(_lan_ip)
if [ "$got" = "localhost" ]; then ok "localhost fallback"; else not_ok "localhost fallback got [$got]"; fi
unset -f hostname ipconfig

# ── 8. resolver: dispatcher resolves itself through a symlink ──────────
# The macOS-breaking case: `~/bin/airprompt` is a symlink to repo/bin. The
# portable resolver must follow it so `source $SELF_DIR/lib/protocol.sh`
# succeeds and `_ensure_bin_symlinks` runs (creates $HOME/bin/airprompt).
echo "[8/8] dispatcher resolves self through symlink"
LINKDIR=$(mktemp -d)
FAKE_HOME=$(mktemp -d)
ln -s "$REPO_ROOT/bin/airprompt" "$LINKDIR/airprompt"
HOME="$FAKE_HOME" bash "$LINKDIR/airprompt" help >/dev/null 2>&1 || true
if [ -L "$FAKE_HOME/bin/airprompt" ] && [ "$(readlink "$FAKE_HOME/bin/airprompt")" = "$REPO_ROOT/bin/airprompt" ]; then
  ok "resolver followed symlink (protocol.sh sourced, ~/bin/airprompt created)"
else
  not_ok "resolver failed — $FAKE_HOME/bin/airprompt missing or wrong target"
fi
rm -rf "$LINKDIR" "$FAKE_HOME"

# ── Result ────────────────────────────────────────────────────────────
echo ""
if [ "$FAILS" -eq 0 ]; then
  echo "protocol.sh helper tests: 8 passed, 0 failed"
else
  echo "protocol.sh helper tests: $((8 - FAILS)) passed, $FAILS failed"
  exit 1
fi
