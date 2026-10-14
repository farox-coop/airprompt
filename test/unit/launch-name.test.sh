#!/bin/bash
set -euo pipefail

# airprompt-launch — `--name` forwarding to the IDE's own session-name flag.
#
# The launcher is driven with a fake `tmux` first on PATH that records the argv
# it is handed, one element per line (`ARG<i>=<value>`) up to an `END` line, so
# the assertions can tell one argument from two (`-n "dev six"` vs `-n dev six`).
# The IDE invocation rides inside that argv (launch_tmux_capture passes "$@" to
# `bash -c … _ "$@"`), after the `_` marker. Nothing is really started: no
# daemon, no tmux session, no IDE. Isolation follows the repo's test rules — a
# temp AIRPROMPT_SESSIONS_DIR, self-install off, and TMPDIR inside the temp dir
# so the launcher's own mktemp capture file is removed with everything else.

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"
REPO_ROOT="$(repo_root)"
LAUNCH="$REPO_ROOT/bin/airprompt-launch"
if [ ! -f "$LAUNCH" ]; then
  echo "Error: $LAUNCH not found" >&2
  exit 1
fi

TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

FAKE_BIN="$TEST_DIR/bin"
# A bin dir holding the fake tmux plus only the utilities the launcher needs on
# PATH — and deliberately no `node`, so the "no node at all" case exercises the
# launcher's `command -v node` guard on any host (a PATH of `/usr/bin:/bin`
# would instead find a distro-installed node and test the opposite).
NODE_FREE_BIN="$TEST_DIR/node-free-bin"
# A node that exists but cannot run.
NO_NODE_BIN="$TEST_DIR/no-node"
TMUX_LOG="$TEST_DIR/tmux.argv"
mkdir -p "$FAKE_BIN" "$NODE_FREE_BIN" "$NO_NODE_BIN"

# Records every tmux invocation, one ARG line per argument. FAKE_TMUX_NO_SESSION
# makes `has-session` fail, steering the launcher onto the
# resume-by-IDE-session-id path (no such tmux session → resume the IDE's);
# FAKE_TMUX_DEAD makes `list-panes` report a dead pane, steering it onto the
# respawn path; FAKE_TMUX_RESPAWN_FAIL makes that respawn fail, steering it onto
# the fallback that replaces the session.
cat > "$FAKE_BIN/tmux" <<'FAKETMUX'
#!/bin/bash
if [ "$1" = "has-session" ] && [ -n "${FAKE_TMUX_NO_SESSION:-}" ]; then exit 1; fi
# The name the launcher reads back for the pane it is already in. Answered and
# NOT recorded: the launcher captures this stdout, so log lines would be read as
# part of the name. `-` not `:-`, so an explicitly empty value stays empty and
# the "no name to mark" case is reachable.
if [ "$1" = "display-message" ]; then
  case "${3:-}" in
    '#{session_group}') printf '%s\n' "${FAKE_TMUX_GROUP-fake-group}" ;;
    *)                  printf '%s\n' "${FAKE_TMUX_SESSION-fake-session}" ;;
  esac
  exit 0
fi
# Matches the real `-F '#{pane_id} #{pane_dead}'`: the launcher resolves the
# DEAD pane's id (a bare session target would hit the session's ACTIVE pane).
if [ "$1" = "list-panes" ] && [ -n "${FAKE_TMUX_DEAD:-}" ]; then printf '%%9 1\n'; exit 0; fi
if [ "$1" = "list-panes" ]; then printf '%%9 0\n'; exit 0; fi
if [ "$1" = "respawn-pane" ] && [ -n "${FAKE_TMUX_RESPAWN_FAIL:-}" ]; then exit 1; fi
i=0
for a in "$@"; do
  printf 'ARG%d=<%s>\n' "$i" "$a" >> "$TMUX_LOG"
  i=$((i + 1))
done
printf 'END\n' >> "$TMUX_LOG"
exit 0
FAKETMUX
chmod +x "$FAKE_BIN/tmux"

# The node-free PATH: the real coreutils the launcher uses, the fake tmux, and
# no node.
for tool in env mktemp mkdir dirname basename readlink date tr grep cat; do
  tool_path="$(command -v "$tool" || true)"
  if [ -z "$tool_path" ]; then
    echo "Error: test setup needs '$tool' on PATH" >&2
    exit 1
  fi
  ln -s "$tool_path" "$NODE_FREE_BIN/$tool"
done
ln -s "$FAKE_BIN/tmux" "$NODE_FREE_BIN/tmux"

# Stands in for the IDE where the launcher execs it directly (already inside
# tmux) — the exec'd binary's stdout is the only record of that argv. The
# counting variant makes "ran with no args at all" distinguishable from "never
# ran", which an empty argv cannot show.
cat > "$FAKE_BIN/recorder" <<'RECORDER'
#!/bin/bash
printf '%s ' "$@"
RECORDER
cat > "$FAKE_BIN/recorder-count" <<'RECORDER'
#!/bin/bash
printf 'argc=%s' "$#"
RECORDER
chmod +x "$FAKE_BIN/recorder" "$FAKE_BIN/recorder-count"

# A node that exists but cannot run: the flag lookup is best-effort and must not
# take the launch down with it.
cat > "$NO_NODE_BIN/node" <<'NO_NODE'
#!/bin/bash
exit 127
NO_NODE
chmod +x "$NO_NODE_BIN/node"

export TMUX_LOG
export TMPDIR="$TEST_DIR"
export PATH="$FAKE_BIN:$PATH"
export AIRPROMPT_NO_SELF_INSTALL=1
export AIRPROMPT_SESSIONS_DIR="$TEST_DIR/sessions"
# The launcher takes a different path inside a real tmux session (case 14) and
# this suite may well be running inside one; the rest of the cases want the
# tmux-creating path. AIRPROMPT_IDE_NAME_FLAG is the override this feature
# documents, so an exported one would otherwise redirect every case, and an
# exported AIRPROMPT_DEBUG would silence case 15's "quiet by default" check.
unset TMUX
unset TMUX_PANE
unset AIRPROMPT_IDE_NAME_FLAG
unset AIRPROMPT_DEBUG

FAILURES=0

# The arguments the launcher handed to the IDE — those after the `_` marker of
# `bash -c … _ "$@"`, from the one invocation that carries it — one per line.
# The environment the launcher forwards into that argv is dropped: it is not
# what these cases assert, and it carries credentials. A value containing a
# newline would be read as two elements, and one equal to `_` would end the scan
# early; no case passes either, and neither is worth a NUL-delimited protocol
# here.
ide_elements() {
  local line val seen=0
  while IFS= read -r line; do
    case "$line" in
      END)
        if [ "$seen" = 1 ]; then break; fi
        ;;
      ARG*=*)
        val="${line#ARG*=}"
        val="${val#<}"
        val="${val%>}"
        if [ "$seen" = 1 ]; then
          printf '%s\n' "$val"
        elif [ "$val" = "_" ]; then
          seen=1
        fi
        ;;
    esac
  done < "$TMUX_LOG"
}

# The same, as one command line, for the substring assertions.
ide_argv() {
  local joined
  joined="$(ide_elements | tr '\n' ' ')"
  printf '%s' "${joined% }"
}

# Run the launcher, then report the IDE command line it invoked.
launch() {
  : > "$TMUX_LOG"
  "$LAUNCH" "$@" >/dev/null 2>&1 || true
  ide_argv
}

# Run the launcher keeping its stdout — the already-inside-tmux path execs the
# IDE, so the IDE's own output is the record.
launch_stdout() {
  : > "$TMUX_LOG"
  "$LAUNCH" "$@" 2>/dev/null || true
}

# Run the launcher keeping its stderr — the diagnostic channel, while stdout
# stays out of the way.
launch_stderr() {
  local err_file="$TEST_DIR/stderr.log"
  : > "$TMUX_LOG"
  "$LAUNCH" "$@" >/dev/null 2>"$err_file" || true
  cat "$err_file"
}

# The name file under the marker dir the launcher keys on the tmux session
# (`<provider>-airprompt-<name>`, per save_session_marker) — written before the
# IDE starts, so it proves the launcher reached the launch.
marker_name() { # marker_name <marker-dir>
  cat "$AIRPROMPT_SESSIONS_DIR/$1/name" 2>/dev/null || true
}

expect() { # expect <substring> <argv> <label>
  case "$2" in
    *"$1"*) printf 'ok   — %s\n' "$3" ;;
    *) printf 'FAIL — %s\n  expected to find: %s\n  in: %s\n' "$3" "$1" "$2"; FAILURES=$((FAILURES + 1)) ;;
  esac
}

# The whole IDE command line has to match: a substring assertion would accept a
# wrong extra flag appended to it, which is the failure this suite exists to catch.
expect_exact() { # expect_exact <argv> <actual> <label>
  if [ "$1" = "$2" ]; then
    printf 'ok   — %s\n' "$3"
  else
    printf 'FAIL — %s\n  expected exactly: %s\n  got: %s\n' "$3" "$1" "$2"
    FAILURES=$((FAILURES + 1))
  fi
}

reject() { # reject <substring> <argv> <label>
  case "$2" in
    *"$1"*) printf 'FAIL — %s\n  did not expect: %s\n  in: %s\n' "$3" "$1" "$2"; FAILURES=$((FAILURES + 1)) ;;
    *) printf 'ok   — %s\n' "$3" ;;
  esac
}

# `grep -qxF` reads a process substitution — neither a pipeline nor a command
# substitution, and both halves of that matter. Not a pipeline: `grep -q` exits
# at the first match, and `set -o pipefail` would turn the producer's resulting
# SIGPIPE into a false FAIL. Not a command substitution: `$( )` strips TRAILING
# newlines, so an empty argument in last position — exactly where a dropped empty
# one shows up — would vanish before `grep` ever saw it.
expect_element() { # expect_element <exact argument> <label>
  if grep -qxF -- "$1" < <(ide_elements); then
    printf 'ok   — %s\n' "$2"
  else
    printf 'FAIL — %s\n  expected one whole argv element: <%s>\n  got: %s\n' "$2" "$1" "$(ide_argv)"
    FAILURES=$((FAILURES + 1))
  fi
}

reject_element() { # reject_element <exact argument> <label>
  if grep -qxF -- "$1" < <(ide_elements); then
    printf 'FAIL — %s\n  did not expect the whole argv element: <%s>\n  got: %s\n' "$2" "$1" "$(ide_argv)"
    FAILURES=$((FAILURES + 1))
  else
    printf 'ok   — %s\n' "$2"
  fi
}

# The command tmux is handed as the pane's process — the `bash -c` string. That
# string is where the environment work happens, so it is what these two read.
# Read from the raw log, never from `ide_elements`: that helper starts at the `_`
# marker, which is further along.
pane_command() {
  awk '
    /^ARG[0-9]+=<bash>$/ { at_bash = 1; next }
    /^ARG[0-9]+=<-c>$/ { if (at_bash) want = 1; at_bash = 0; next }
    /^ARG[0-9]+=</ {
      if (want) { sub(/^ARG[0-9]+=</, ""); sub(/>$/, ""); print; exit }
      at_bash = 0
    }
  ' "$TMUX_LOG"
}

# Both of these assert the SHAPE of the pane command, not the presence of a
# substring. A grep for `env -i` or for the literal `TMUX=$TMUX` is satisfied by
# a command that merely mentions them — e.g. one that echoes the three vars and
# then execs `env -i "$@"` with no hand-back at all, which is exactly the
# regression they exist to catch. Anchoring costs nothing and closes that.
expect_env_cleared() { # expect_env_cleared <label>
  if grep -qE '^exec env -i ' <<<"$(pane_command)"; then
    printf 'ok   — %s\n' "$1"
  else
    printf 'FAIL — %s\n  the pane command does not begin with `exec env -i`: the tmux server environment would reach the session\n  got: %s\n' "$1" "$(pane_command)"
    FAILURES=$((FAILURES + 1))
  fi
}

expect_tmux_vars_kept() { # expect_tmux_vars_kept <label>
  # The whole command, anchored: `env -i` must be handed the pane-owned values
  # as its first three operands, in order, and then the caller's `"$@"`. tmux
  # injects TMUX, TMUX_PANE and TERM into the pane's process and they are in no
  # forwarded list, so the pane command is the only place still holding them —
  # without the first two the IDE reports "not inside tmux" while it is
  # demonstrably inside one, and without TERM it addresses a terminal it is not
  # talking to.
  local cmd
  cmd="$(pane_command)"
  if grep -qE '^exec env -i "TMUX=\$TMUX" "TMUX_PANE=\$TMUX_PANE" "TERM=\$TERM" "\$@"$' <<<"$cmd"; then
    printf 'ok   — %s\n' "$1"
  else
    printf 'FAIL — %s\n  the pane command does not hand TMUX/TMUX_PANE/TERM to `env -i`\n  got: %s\n' "$1" "$cmd"
    FAILURES=$((FAILURES + 1))
  fi
}

expect_forwarded_element() { # expect_forwarded_element <NAME=value> <label>
  # The forwarded list reaches tmux as its own argv elements, between the pane
  # command and the wrapper — never inside `pane_command()`, whose text is a
  # fixed literal. So the assertions above cannot see whether anything was
  # forwarded at all: they would all pass with FORWARD_ENV emptied. This is the
  # positive half.
  if grep -qF -- "<$1>" "$TMUX_LOG"; then
    printf 'ok   — %s\n' "$2"
  else
    printf 'FAIL — %s\n  <%s> is not in the tmux argv: the caller environment would not reach the IDE\n' "$2" "$1"
    FAILURES=$((FAILURES + 1))
  fi
}

expect_no_forwarded_tmux() { # expect_no_forwarded_tmux <label>
  # The values tmux owns for a pane — TMUX, TMUX_PANE, TERM — come from tmux and
  # are handed back by the pane command. A copy forwarded from the launcher's own
  # environment is applied AFTER that set and wins (`env` is last-wins): the
  # outer session's values when the launcher itself runs inside tmux, or an empty
  # pair that re-creates the very bug this guards. Nothing tmux owns may appear
  # in the forwarded list. Matched after the `<` so the pane command's own
  # `"TMUX=$TMUX"` cannot count, and only up to the `_` marker: past it lies the
  # IDE's own argv, where an argument that merely reads `TMUX=…` is the user's
  # text, not a forwarded var.
  if awk '
      /^ARG[0-9]+=</ {
        v = $0
        sub(/^ARG[0-9]+=</, "", v)
        sub(/>$/, "", v)
        if (v == "_") done = 1
        if (!done && (v ~ /^TMUX=/ || v ~ /^TMUX_PANE=/ || v ~ /^TERM=/)) found = 1
      }
      END { exit(found ? 1 : 0) }
    ' "$TMUX_LOG"; then
    printf 'ok   — %s\n' "$1"
  else
    printf 'FAIL — %s\n  a caller TMUX/TMUX_PANE/TERM is forwarded and would override the handed-back set\n' "$1"
    FAILURES=$((FAILURES + 1))
  fi
}

expect_no_marker_for() { # expect_no_marker_for <name> <label>
  # A marker keyed on something that is not a tmux session records a tmux name
  # that can never exist — junk the sweep has to reap.
  if [ -d "$AIRPROMPT_SESSIONS_DIR/claude-$1" ]; then
    printf 'FAIL — %s\n  a marker dir was keyed on a non-tmux name: claude-%s\n' "$2" "$1"
    FAILURES=$((FAILURES + 1))
  else
    printf 'ok   — %s\n' "$2"
  fi
}

respawn_target() { # the -t argument of the respawn-pane invocation in the log
  awk '
    /^ARG[0-9]+=<respawn-pane>$/ { in_respawn = 1; next }
    in_respawn && /^ARG[0-9]+=<-t>$/ { want = 1; next }
    want {
      v = $0
      sub(/^ARG[0-9]+=</, "", v)
      sub(/>$/, "", v)
      print v
      exit
    }
  ' "$TMUX_LOG"
}

expect_marker() { # expect_marker <marker-dir> <name> <label>
  local got
  got="$(marker_name "$1")"
  if [ "$got" = "$2" ]; then
    printf 'ok   — %s\n' "$3"
  else
    printf 'FAIL — %s\n  expected the marker name file to hold "%s", got "%s"\n' "$3" "$2" "$got"
    FAILURES=$((FAILURES + 1))
  fi
}

# The tmux subcommand of the invocation that carries the IDE argv, so a case can
# pin WHICH invocation launched the IDE (a respawn, a new session, …).
ide_verb() {
  local line val verb="" has_marker=0
  while IFS= read -r line; do
    case "$line" in
      END)
        if [ "$has_marker" = 1 ]; then
          printf '%s' "$verb"
          return 0
        fi
        verb=""
        has_marker=0
        ;;
      ARG0=*)
        val="${line#ARG0=}"
        val="${val#<}"
        val="${val%>}"
        if [ -z "$verb" ]; then verb="$val"; fi
        ;;
      ARG*=*)
        val="${line#ARG*=}"
        val="${val#<}"
        val="${val%>}"
        if [ "$val" = "_" ]; then has_marker=1; fi
        ;;
    esac
  done < "$TMUX_LOG"
}

# Any tmux invocation carrying this subcommand (marker-bearing or not), for the
# paths that attach to a session instead of launching an IDE.
expect_tmux_verb() { # expect_tmux_verb <subcommand> <label>
  if grep -qxF "ARG0=<$1>" "$TMUX_LOG"; then
    printf 'ok   — %s\n' "$2"
  else
    printf 'FAIL — %s\n  expected a tmux invocation of: %s\n  log: %s\n' "$2" "$1" "$(tr '\n' ' ' < "$TMUX_LOG" | head -c 200)"
    FAILURES=$((FAILURES + 1))
  fi
}

expect_stderr() { # expect_stderr <substring> <stderr> <label>
  case "$2" in
    *"$1"*) printf 'ok   — %s\n' "$3" ;;
    *) printf 'FAIL — %s\n  expected on stderr: %s\n  in: %s\n' "$3" "$1" "$2"; FAILURES=$((FAILURES + 1)) ;;
  esac
}

# 1. claude declares `-n` — the name is forwarded, ahead of the user's args.
argv="$(launch --provider claude --binary /bin/echo --name dev-1 --foo)"
expect_exact "/bin/echo -n dev-1 --foo" "$argv" "claude: --name forwarded as the provider's flag, ahead of the user's args"
expect_element "-n" "claude: the flag is its own argv element"
expect_element "dev-1" "claude: the name is its own argv element"

# 2. No --name — nothing is forwarded.
argv="$(launch --provider claude --binary /bin/echo --foo)"
expect_exact "/bin/echo --foo" "$argv" "claude: the IDE still starts with the user's args"
reject_element "-n" "claude: no --name means no forwarded flag"

# 3. A provider that declares no flag is left alone — an unknown flag would
#    abort its start. With no IDE args of its own this is also the case whose
#    `args` list is empty — the state that aborts the launch on bash 3.2 (macOS
#    /bin/bash) under `set -u`; CI runs bash 5, so what is pinned here is the
#    empty-list path, not the 3.2 crash.
argv="$(launch --provider codex --binary /bin/echo --name dev-2)"
expect_exact "/bin/echo" "$argv" "codex: the IDE still starts"
reject_element "-n" "codex: no declared flag means nothing is forwarded"

# 4. The env var overrides the provider's flag (a provider whose flag is not
#    declared here yet).
argv="$(AIRPROMPT_IDE_NAME_FLAG=--label launch --provider codex --binary /bin/echo --name dev-3)"
expect_exact "/bin/echo --label dev-3" "$argv" "AIRPROMPT_IDE_NAME_FLAG overrides the provider's flag"

# 5. An empty env var disables the forwarding even where the provider has one.
#    The marker is checked too: an argv that never got built must not be able to
#    satisfy the `reject` below by looking like "forwarding disabled".
argv="$(AIRPROMPT_IDE_NAME_FLAG='' launch --provider claude --binary /bin/echo --name dev-4)"
expect_exact "/bin/echo" "$argv" "claude: the IDE still starts when forwarding is off"
reject_element "-n" "AIRPROMPT_IDE_NAME_FLAG='' disables the forwarding"
expect_marker "claude-airprompt-dev-4" "dev-4" "the AirPrompt marker carries the name when forwarding is off"

# 6. `--resume <ide-session-id>` — not a tmux session, so the IDE's own session
#    is resumed. The forwarded name and the user's own args both have to reach
#    that IDE invocation.
argv="$(FAKE_TMUX_NO_SESSION=1 launch --provider claude --binary /bin/echo --resume ide-abc-123 --name dev-5 --model opus)"
expect_exact "/bin/echo --resume ide-abc-123 -n dev-5 --model opus" "$argv" "claude: --resume <ide-session-id> keeps the user's args and forwards the name"

# 7. `--continue <session-id>` is AirPrompt's resume path, exactly like
#    `--resume <session-id>`; bare, `--continue` is the IDE's own flag and
#    reaches it as typed.
argv="$(FAKE_TMUX_NO_SESSION=1 launch --provider claude --binary /bin/echo --continue ide-xyz --name dev-6)"
expect_exact "/bin/echo --resume ide-xyz -n dev-6" "$argv" "claude: --continue <session-id> resumes the session and forwards the name"
argv="$(launch --provider claude --binary /bin/echo --continue --name dev-6b)"
expect_exact "/bin/echo -n dev-6b --continue" "$argv" "claude: a bare --continue reaches the IDE as its own flag"

# 8. A node that exists but fails — the lookup degrades to "no flag".
argv="$(PATH="$NO_NODE_BIN:$PATH" launch --provider claude --binary /bin/echo --name dev-7)"
expect_exact "/bin/echo" "$argv" "failing node: the IDE still starts"
reject_element "-n" "failing node: nothing is forwarded"
expect_marker "claude-airprompt-dev-7" "dev-7" "failing node: the AirPrompt marker still carries the name"

# 9. No node on PATH at all — the `command -v node` guard, which is a different
#    branch from case 8. The PATH is built from the fake tmux plus the utilities
#    the launcher needs, so it holds no node on any host.
argv="$(PATH="$NODE_FREE_BIN" launch --provider claude --binary /bin/echo --name dev-8)"
expect_exact "/bin/echo" "$argv" "no node on PATH: the IDE still starts"
reject_element "-n" "no node on PATH: nothing is forwarded"
expect_marker "claude-airprompt-dev-8" "dev-8" "no node on PATH: the AirPrompt marker still carries the name"

# 10. A dead pane is respawned with the IDE's args — the path that re-runs the
#     IDE inside the session it was resumed into.
argv="$(FAKE_TMUX_DEAD=1 launch --provider claude --binary /bin/echo --resume airprompt-dev-10 --name dev-10 --foo)"
expect_exact "/bin/echo -n dev-10 --foo" "$argv" "claude: a dead pane is respawned with the name and the user's args"
expect "respawn-pane" "$(ide_verb)" "claude: that launch is the respawn, not a replacement session"
# Respawn the DEAD pane by id. A bare session target resolves to the session's
# ACTIVE pane, so on a session with a dead pane and a live one it would replace
# the live pane — killing the process the user is coming back to.
expect_exact "%9" "$(respawn_target)" "claude: the respawn targets the dead pane's id, not the session"
# The marker is written for a resumed tmux session as well as a fresh one. Its
# absence is invisible to the id-resume case (which asserts only that no marker
# is keyed on the id), so a regression that drops the call needs this positive.
expect_marker "claude-airprompt-dev-10" "dev-10" "claude: the resume-tmux path still writes its marker"

# 11. A launch with no IDE args of its own: the forwarded pair is the whole
#     argument list.
argv="$(launch --provider claude --binary /bin/echo --name dev-11)"
expect_exact "/bin/echo -n dev-11" "$argv" "claude: no IDE args of its own still reach the IDE"

# 12. A name with spaces is one argument — the tmux session name is sanitized,
#     but the IDE must receive the name unsplit.
argv="$(launch --provider claude --binary /bin/echo --name 'dev six')"
expect_exact "/bin/echo -n dev six" "$argv" "claude: a name with spaces is forwarded"
expect_element "dev six" "claude: the name with spaces arrives as ONE argument"

# 13. A `--` among the user's args ends the IDE's option parsing, so the
#     forwarded pair has to precede it — behind one it would be read as text.
argv="$(launch --provider claude --binary /bin/echo --name dev-12 -- --weird-prompt)"
expect_exact "/bin/echo -n dev-12 -- --weird-prompt" "$argv" "claude: the forwarded pair precedes a user -- terminator"

# 14. Already inside tmux the launcher execs the IDE directly — the name and the
#     user's args reach it there too, with no tmux invocation in between.
out="$(TMUX=/tmp/fake,1,0 launch_stdout --provider claude --binary "$FAKE_BIN/recorder" --foo --name dev-13)"
out="${out% }"
expect_exact "-n dev-13 --foo" "$out" "inside tmux: the forwarded name and the user's args reach the IDE"

# 15. A provider with no flag says so on stderr when AIRPROMPT_DEBUG=1 — and
#     says nothing without it.
err="$(AIRPROMPT_DEBUG=1 launch_stderr --provider codex --binary /bin/echo --name dev-14)"
expect_stderr "no session-name flag resolved" "$err" "AIRPROMPT_DEBUG=1: the unforwarded name is reported"
expect_stderr "dev-14" "$err" "AIRPROMPT_DEBUG=1: the report names the session"
reject "no session-name flag resolved" "$(launch_stderr --provider codex --binary /bin/echo --name dev-14)" "silent without AIRPROMPT_DEBUG"

# 16. The tmux session exists and its pane is alive — the launcher attaches to
#     it and starts no IDE, so there is nothing to forward. The empty-argv
#     assertion is the positive control: attaching still logs `attach-session`,
#     so only "no IDE command line at all" separates attach from a relaunch.
launch --provider claude --binary /bin/echo --resume airprompt-dev-15 --name dev-15 --foo >/dev/null
expect_tmux_verb "attach-session" "claude: a live pane is attached to, not relaunched"
expect_exact "" "$(ide_argv)" "claude: attaching starts no IDE at all"
reject_element "-n" "claude: attaching starts no IDE, so nothing is forwarded"

# 17. The respawn fails — the launcher replaces the session, and that launch
#     still carries the forwarded pair and the user's args.
argv="$(FAKE_TMUX_DEAD=1 FAKE_TMUX_RESPAWN_FAIL=1 launch --provider claude --binary /bin/echo --resume airprompt-dev-16 --name dev-16 --foo)"
expect_exact "/bin/echo -n dev-16 --foo" "$argv" "claude: a failed respawn falls back to a new session, name and args kept"
expect "new-session" "$(ide_verb)" "claude: the fallback is a fresh tmux session"

# 18-20. The resume paths with NOTHING to forward: no `--name`, no user args, so
#        `args` is empty where the IDE is launched. Those are the remaining
#        `${args[@]+"${args[@]}"}` sites — empty there is exactly the state that
#        aborts the launch on bash 3.2 (macOS /bin/bash), which CI cannot run.
argv="$(FAKE_TMUX_DEAD=1 launch --provider claude --binary /bin/echo --resume airprompt-dev-17)"
expect_exact "/bin/echo" "$argv" "claude: a respawn with nothing to forward launches the IDE bare"
expect "respawn-pane" "$(ide_verb)" "claude: that empty-args launch is the respawn"

argv="$(FAKE_TMUX_NO_SESSION=1 launch --provider claude --binary /bin/echo --resume ide-nothing)"
expect_exact "/bin/echo --resume ide-nothing" "$argv" "claude: a resume-by-id with nothing to forward keeps the resume flag"

argv="$(FAKE_TMUX_DEAD=1 FAKE_TMUX_RESPAWN_FAIL=1 launch --provider claude --binary /bin/echo --resume airprompt-dev-18)"
expect_exact "/bin/echo" "$argv" "claude: the respawn fallback with nothing to forward launches the IDE bare"
expect "new-session" "$(ide_verb)" "claude: that empty-args fallback is a fresh tmux session"

# 21. The last empty-`args` site: the direct exec, inside tmux, with nothing to
#     forward. The counter proves the IDE really ran (an empty argv cannot).
out="$(FAKE_TMUX_SESSION='' TMUX=/tmp/fake,1,0 launch_stdout --provider claude --binary "$FAKE_BIN/recorder-count")"
expect_exact "argc=0" "$out" "inside tmux: a direct exec with nothing to forward runs the IDE bare"
# The fast path marks the session it is already in — but only once it has that
# session's name. A TMUX whose server is gone yields none (the fake answers with
# nothing here), and marking anyway would file the dir under
# save_session_marker's `airprompt-unknown` fallback.
expect_no_marker_for "airprompt-unknown" "inside tmux: no marker is filed on the unknown-session fallback"

# 22. The IDE's environment is the caller's and nothing else. A tmux session
#     starts as a copy of the SERVER's environment — whichever client happened to
#     start that server — so any var in the server and not in this launch (a
#     per-project git scope, a port, a Docker project name, a token meant for one
#     session) would reach the IDE silently and outlive whatever set it. `env -i`
#     is what stops that, and it is pinned on both paths that start a process.
argv="$(launch --provider claude --binary /bin/echo --name dev-22)"
expect_env_cleared "a new session clears the environment before starting the IDE"
expect_tmux_vars_kept "a new session keeps the pane-owned TMUX/TMUX_PANE/TERM"
argv="$(FAKE_TMUX_DEAD=1 launch --provider claude --binary /bin/echo --resume airprompt-dev-22)"
expect_env_cleared "a respawn clears the environment before starting the IDE"
expect_tmux_vars_kept "a respawn keeps them too"

# 23. `--resume` takes either a tmux session name or the IDE's own session id,
#     and only a real tmux session may get a marker. Keyed on an id, the marker
#     records a tmux name that can never exist — the junk dir the sweep reaps.
argv="$(FAKE_TMUX_NO_SESSION=1 launch --provider claude --binary /bin/echo --resume 3be36f4d-8c08-440b-9610-208bec85c887)"
expect "3be36f4d-8c08-440b-9610-208bec85c887" "$argv" "resume by IDE id still reaches the IDE"
expect_no_marker_for "3be36f4d-8c08-440b-9610-208bec85c887" "resume by IDE id writes no marker keyed on that id"

# 24. Launching from inside tmux must not forward the OUTER session's tmux
#     identity into the new pane — the forwarded copy lands after the handed-back
#     pair and wins, so the IDE would be attributed to the session it left.
TMUX=/tmp/fake,1,0 TMUX_PANE=%9 FAKE_TMUX_DEAD=1 launch --provider claude --binary /bin/echo --resume airprompt-dev-24 >/dev/null
expect_no_forwarded_tmux "inside tmux: the outer tmux identity is not forwarded into the pane"
expect_env_cleared "inside tmux: that pane still clears the environment first"
expect_tmux_vars_kept "inside tmux: that pane still hands the pane-owned set back"

# 25. The other half of that guard: with a name to key on, the marker IS written.
#     Dropping the write altogether would satisfy every negative assertion above.
out="$(TMUX=/tmp/fake,1,0 launch_stdout --provider claude --binary "$FAKE_BIN/recorder-count" --name dev-25)"
expect_marker "claude-fake-session" "dev-25" "inside tmux: the marker is keyed on the session the pane reports"

# 26. An empty --resume value is refused. Falling through instead started a
#     fresh session: no resume, no complaint, and one nobody asked for.
out="$(launch_stderr --provider claude --binary /bin/echo --resume '')"
expect "requires a session name or ID" "$out" "claude: --resume with an empty value is refused"

# 27. A launch from a web-proxy pane is keyed on the session the proxy drives,
#     not on the proxy itself — the same mapping every other call site applies.
#     Keyed on the proxy, the marker is invisible to `airprompt off`/`name`,
#     which resolve the real session from its group.
out="$(FAKE_TMUX_SESSION=airprompt-web-phone FAKE_TMUX_GROUP=airprompt-real TMUX=/tmp/fake,1,0 launch_stdout --provider claude --binary "$FAKE_BIN/recorder-count" --name dev-27)"
expect_marker "claude-airprompt-real" "dev-27" "inside a web-proxy pane: the marker is keyed on the session the proxy drives"

# 28. `--continue` with an empty value consumes it. The empty string would
#     otherwise re-enter the parse loop and reach the IDE as an argument, and
#     for a CLI an empty positional is a prompt — not nothing. The empty
#     element is asserted on the element list, which needs `reject_element`'s
#     sentinel to survive in last position; the joined line would show it too,
#     as the trailing space the exact-match below trips over.
argv="$(launch --provider claude --binary /bin/echo --continue '')"
expect_exact "/bin/echo --continue" "$argv" "claude: --continue with an empty value is not split into two arguments"
reject_element "" "claude: no empty argument reaches the IDE"

# 29. Empty and flag-valued operands are refused for --name and --resume alike.
#     Empty would look like it worked (unnamed session, or a fresh launch that
#     silently is not a resume); a flag would be swallowed as the operand,
#     destroying the flag the user did type.
out="$(launch_stderr --provider claude --binary /bin/echo --name '')"
expect "requires a name" "$out" "claude: --name with an empty value is refused"
out="$(launch_stderr --provider claude --binary /bin/echo --name --resume ideid)"
expect "requires a name" "$out" "claude: --name does not swallow a following flag as its name"
out="$(launch_stderr --provider claude --binary /bin/echo --resume --name x)"
expect "requires a session name or ID" "$out" "claude: --resume does not swallow a following flag as its session"

# 30. An ungrouped session *named* `airprompt-web-…` is not a proxy: mapping it
#     to its (empty) group would drop the marker entirely. `--name web-x`
#     produces exactly such a name.
out="$(FAKE_TMUX_SESSION=airprompt-web-fake FAKE_TMUX_GROUP='' TMUX=/tmp/fake,1,0 launch_stdout --provider claude --binary "$FAKE_BIN/recorder-count" --name dev-31)"
expect_marker "claude-airprompt-web-fake" "dev-31" "an ungrouped airprompt-web-* session keeps its own name as the marker key"

# 32. A caller variable has to reach the pane's argv — the positive half of the
#     environment story. That the environment is CLEARED is asserted three times
#     over; that the caller's own environment still arrives was asserted nowhere,
#     so emptying FORWARD_ENV would leave every one of those assertions green.
R12_FWD_SENTINEL=keepme launch --provider claude --binary /bin/echo --name dev-32 >/dev/null
expect_forwarded_element "R12_FWD_SENTINEL=keepme" "a caller variable is forwarded into the pane's argv"

if [ "$FAILURES" -gt 0 ]; then
  printf '\n%s check(s) failed.\n' "$FAILURES"
  exit 1
fi
printf '\nall launch-name checks passed.\n'
