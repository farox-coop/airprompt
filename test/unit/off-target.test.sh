#!/usr/bin/env bash
set -euo pipefail
# ── airprompt-off.sh target-resolution unit tests ──────────────────────
# `airprompt off <sessionId>` must tear down the session it NAMES: unregister
# that id, and remove that session's local marker dir. The caller's own dir is
# resolved from $TMUX, so naming a session from inside a live pane used to
# remove the CALLER's markers while leaving the target's behind.
#
# curl and tmux are stubbed, so no daemon and no real tmux session is involved.
# The sessions dir must keep "airprompt" in its path — the script's own
# _safe_rm_rf guard refuses anything else, and that refusal is what makes the
# sweep a no-op rather than a disaster.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
REPO_ROOT="$(repo_root)"
OFF="$REPO_ROOT/bin/airprompt-off.sh"

OKS=0
ok()  { echo "  PASS: $1"; ((OKS++)) || true; }
not_ok() { echo "  FAIL: $1"; ((FAILS++)) || true; }
FAILS=0

echo "=== airprompt-off.sh target-resolution unit tests ==="

WORLD_PARENT="$(mktemp -d)"
WORLD="$WORLD_PARENT/airprompt-world"
mkdir -p "$WORLD/sessions" "$WORLD/uploads" "$WORLD/bin"
trap 'rm -rf "$WORLD_PARENT"' EXIT

UNREG_LOG="$WORLD/unregistered.txt"
: > "$UNREG_LOG"

# Records the body of every `-d <json>` curl is handed. Answers ok, unless the
# case asks for a refusal (FAKE_CURL_REPLY) or an unreachable daemon
# (FAKE_CURL_FAIL), which are the two branches the script's warning paths take.
cat > "$WORLD/bin/curl" <<CURL
#!/bin/bash
prev=""
for a in "\$@"; do
  [ "\$prev" = "-d" ] && printf '%s\n' "\$a" >> "$UNREG_LOG"
  prev="\$a"
done
[ -n "\${FAKE_CURL_FAIL:-}" ] && exit 7
printf '%s' "\${FAKE_CURL_REPLY:-{\"ok\":true}}"
CURL

# BOTH sessions are live. The target must be, or its dir would disappear for the
# wrong reason: the script's own dead-dir sweep reaps every dir whose tmux is
# gone, so a dead target would be removed whether or not the id ever resolved to
# it — and assertion [3/6] would pass against the pre-fix script too.
cat > "$WORLD/bin/tmux" <<'TMUX'
#!/bin/bash
case "$1" in
  display-message)
    case "${3:-}" in
      '#{session_group}') printf '%s\n' "${FAKE_GROUP:-}" ;;
      *)                  printf '%s\n' "${FAKE_SESSION:-airprompt-caller}" ;;
    esac
    exit 0
    ;;
  has-session)
    case "${3:-}" in
      airprompt-caller | airprompt-target | airprompt-web-fake | airprompt-real) exit 0 ;;
      *) exit 1 ;;
    esac
    ;;
esac
exit 0
TMUX
chmod +x "$WORLD/bin/curl" "$WORLD/bin/tmux"

# The caller is a live pane, so its dir is what $TMUX resolves to; the target is
# a different session, named on the command line.
seed_world() { # (re)create both session dirs, and forget the last run
  for pair in "caller:caller-session-id:CALLER" "target:target-session-id:TARGET"; do
    local dir="${pair%%:*}" rest="${pair#*:}"
    local id="${rest%%:*}" label="${rest#*:}"
    mkdir -p "$WORLD/sessions/claude-airprompt-$dir"
    printf '%s\n' "$id"          > "$WORLD/sessions/claude-airprompt-$dir/session"
    printf 'airprompt-%s\n' "$dir" > "$WORLD/sessions/claude-airprompt-$dir/tmux"
    printf 'name: %s\n' "$label"   > "$WORLD/sessions/claude-airprompt-$dir/name"
  done
  : > "$UNREG_LOG"
}

# Run off with the throwaway world in front of it. AIRPROMPT_PID_FILE is
# pointed at that world too: the script's "stop the daemon if no sessions
# remain" tail must not be able to reach the real one at /tmp/airprompt-server.pid.
# run_off [args...] — what the script said lands in $OFF_OUT. It has to be
# captured, not discarded: the branches that differ only in which outcome they
# report (unregistered vs. removed-locally) are otherwise indistinguishable,
# because the local dir comes off unconditionally either way.
OFF_OUT="$WORLD/off.out"
run_off() {
  TMUX=/tmp/fake,1,0 PATH="$WORLD/bin:$PATH" \
    AIRPROMPT_PROVIDER=claude AIRPROMPT_NO_TLS=1 AIRPROMPT_PORT=3211 \
    AIRPROMPT_PID_FILE="$WORLD/fake.pid" \
    AIRPROMPT_SESSIONS_DIR="$WORLD/sessions" AIRPROMPT_UPLOADS_DIR="$WORLD/uploads" \
    bash "$OFF" "$@" >"$OFF_OUT" 2>&1 || true
}

# ── 1. The named id is what reaches the daemon ────────────────────────
echo "[1] the named session is the one unregistered"
seed_world
run_off target-session-id
if grep -qF 'target-session-id' "$UNREG_LOG"; then
  ok "off <id> unregisters [target-session-id]"
else
  not_ok "the named session was not unregistered — log: [$(tr '\n' ' ' < "$UNREG_LOG")]"
fi

# ── 2. The caller's marker dir survives ───────────────────────────────
# This is the assertion the pre-fix script fails: it resolves the dir to
# remove from $TMUX, so naming another session deleted the caller's markers.
echo "[2] the caller's own marker dir is left alone"
if [ -d "$WORLD/sessions/claude-airprompt-caller" ] && [ -f "$WORLD/sessions/claude-airprompt-caller/name" ]; then
  ok "the caller's dir and its files are untouched"
else
  not_ok "off <otherId> removed the caller's marker dir"
fi

# ── 3. The target's own marker dir is the one removed ─────────────────
# The target's tmux is live, so the dead-dir sweep cannot be what removes it:
# only the id-driven resolution can account for this passing.
echo "[3] the target's marker dir is removed (by the id, not by the sweep)"
if [ ! -d "$WORLD/sessions/claude-airprompt-target" ]; then
  ok "the target's dir is gone"
else
  not_ok "the target's dir was left behind"
fi

# ── 4. No argument still means the current session ────────────────────
# The branch that does this was restructured alongside the id-driven one, and
# resolving the id from the marker's `session` file is the only thing that makes
# a bare `off` unregister anything: drop it and the command reports "already
# off" while the session stays registered.
echo "[4] no argument resolves the current session from its marker"
seed_world
run_off
if grep -qF 'caller-session-id' "$UNREG_LOG"; then
  ok "bare off unregisters [caller-session-id], read from the marker dir"
else
  not_ok "bare off unregistered nothing — log: [$(tr '\n' ' ' < "$UNREG_LOG")]"
fi
if [ ! -d "$WORLD/sessions/claude-airprompt-caller" ]; then
  ok "bare off removed the caller's own dir"
else
  not_ok "bare off left the current session's dir behind"
fi

# ── 5. A refusing daemon still tears the local markers down ───────────
# The unregister is best-effort: the dir must go regardless, or a session the
# daemon has already forgotten stays on disk forever.
echo "[5] a refused unregister still removes the local dir"
seed_world
FAKE_CURL_REPLY='{"ok":false,"error":"Session not found"}' run_off target-session-id
if grep -qF 'target-session-id' "$UNREG_LOG"; then
  ok "the refusal was still attempted for [target-session-id]"
else
  not_ok "no unregister was attempted"
fi
if [ ! -d "$WORLD/sessions/claude-airprompt-target" ]; then
  ok "the target's dir was removed locally despite the refusal"
else
  not_ok "a refused unregister left the target's dir behind"
fi
# The dir removal is unconditional, so it proves nothing on its own — and if the
# stub ever stopped refusing, EVERY assertion above would still pass. The
# wording is what separates a refusal from a success.
if grep -qF 'removed locally (daemon refused)' "$OFF_OUT"; then
  ok "and the refusal is what the daemon actually answered"
else
  not_ok "the stub did not refuse — output: [$(tr '\n' ' ' < "$OFF_OUT")]"
fi

# ── 6. An unreachable daemon still tears the local markers down ───────
# Same contract as a refusal, different branch: curl failing outright must not
# leave the session's dir behind either.
echo "[6] an unreachable daemon still removes the local dir, as a success"
seed_world
FAKE_CURL_FAIL=1 run_off target-session-id
if [ ! -d "$WORLD/sessions/claude-airprompt-target" ]; then
  ok "the target's dir was removed locally with the daemon unreachable"
else
  not_ok "an unreachable daemon left the target's dir behind"
fi
# The dir removal alone proves nothing — it happens whatever the curl outcome
# was. The discriminating half is WHICH outcome the script reports: an
# unreachable daemon is the "unregistered anyway" branch, not a refusal.
if grep -qF "session unregistered: target-session-id" "$OFF_OUT"; then
  ok "and it reported the unreachable daemon as a success, not a refusal"
else
  not_ok "the unreachable-daemon branch did not run — output: [$(tr '\n' ' ' < "$OFF_OUT")]"
fi

# ── 7. A pane merely NAMED airprompt-web-… is not a proxy ─────────────
# It has no session group, so its own name is the session's name. Blanking it
# (the bare-assignment form four call sites used to have) leaves `off` with
# nothing to resolve and the session silently un-unregistrable.
echo "[7] an ungrouped airprompt-web-* pane keeps its own name"
seed_world
mkdir -p "$WORLD/sessions/claude-airprompt-web-fake"
printf 'web-session-id\n'     > "$WORLD/sessions/claude-airprompt-web-fake/session"
printf 'airprompt-web-fake\n' > "$WORLD/sessions/claude-airprompt-web-fake/tmux"
: > "$UNREG_LOG"
FAKE_SESSION=airprompt-web-fake FAKE_GROUP='' run_off
if grep -qF 'web-session-id' "$UNREG_LOG"; then
  ok "the ungrouped web-named pane resolved to its own session"
else
  not_ok "an ungrouped web-named pane resolved to nothing — log: [$(tr '\n' ' ' < "$UNREG_LOG")]"
fi

# ── 8. A real proxy resolves to the session it drives ─────────────────
# The other half: with a group present the proxy's name must NOT be used.
echo "[8] a real airprompt-web-* proxy resolves to its session group"
seed_world
mkdir -p "$WORLD/sessions/claude-airprompt-real"
printf 'real-session-id\n' > "$WORLD/sessions/claude-airprompt-real/session"
printf 'airprompt-real\n'  > "$WORLD/sessions/claude-airprompt-real/tmux"
: > "$UNREG_LOG"
FAKE_SESSION=airprompt-web-fake FAKE_GROUP=airprompt-real run_off
if grep -qF 'real-session-id' "$UNREG_LOG"; then
  ok "the proxy resolved to [real-session-id], the session it drives"
else
  not_ok "the proxy did not resolve to its group — log: [$(tr '\n' ' ' < "$UNREG_LOG")]"
fi

# ── Result ────────────────────────────────────────────────────────────
echo ""
if [ "$FAILS" -eq 0 ]; then
  echo "off target-resolution tests: $OKS passed, 0 failed"
else
  echo "off target-resolution tests: $OKS passed, $FAILS failed"
  exit 1
fi
