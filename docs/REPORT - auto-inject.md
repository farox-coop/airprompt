# AirPrompt Auto-Inject Investigation

**Date:** 2026-08-05
**Status:** Report complete — awaiting decision on implementation path

---

## Executive Summary

**Problem:** When user runs `claude` directly (bypassing `airprompt-launch`), AirPrompt's web UI shows a raw bash shell, not Claude's TUI.

**Root cause:** SessionStart hook fires AFTER Claude Code's TUI already renders. The hook detects no tmux session, creates an empty `airprompt-*` tmux session, and registers that empty shell — not the running Claude process.

**Recommended fix (Phase 1):** Create `~/bin/claude` wrapper (PATH interception) that delegates to `airprompt-launch`. Same proven pattern as existing `~/bin/airprompt-claude`. Zero user behavior change.

**Long-term fix:** The existing [holdpty vendoring plan](./PLAN%20-%20holdpty%20vendoring.md) removes tmux entirely — when implemented, the auto-inject problem disappears because holdpty owns the PTY from process start.

---

## 1. Problem Statement

When user runs `claude` directly (not through `airprompt-claude` or `airprompt-launch`), AirPrompt's web UI shows a **raw bash terminal** instead of the Claude session.

### Root cause

AirPrompt mirrors IDE sessions by connecting to a **tmux session** via `node-pty` + `tmux attach-session`. The web UI creates a grouped tmux session (`airprompt-web-*`) that mirrors the real session, attaches node-pty to it, and streams terminal output to xterm.js over WebSocket.

When `claude` is launched directly:

1. Claude runs **outside tmux** (no `$TMUX` env var)
2. The `SessionStart` hook fires → `airprompt-activate.js` runs
3. `detectTmux()` returns empty string (line 74-87, `src/hooks/core/activate.js`)
4. `activateSession()` creates a **new empty `airprompt-*` tmux session** (line 246-250)
5. This empty session runs `bash`, not Claude
6. Web UI connects → user sees an empty bash prompt, **can type arbitrary shell commands**

This is a security gap AND a broken UX.

### Why the SessionStart hook can't fix this alone

**Claude Code's SessionStart hook fires AFTER the TUI renders.** Official docs confirm hooks are deferred ~500ms to reduce time-to-interactive ([source](https://github.com/anthropics/claude-code/issues/27432)). By the time `airprompt-activate.js` runs, Claude's TUI is already painted on the user's terminal OUTSIDE any tmux session. The hook can create a new tmux session (which it does — an empty one), but it cannot retroactively capture Claude's already-running TUI into that session.

**There is no pre-launch hook.** Claude Code's hook system has no event that fires before the TUI initializes. `SessionStart` is the earliest session hook. No hook can "wrap" the process before it starts rendering.

This means: **any solution that relies solely on hooks is architecturally impossible.** We must intercept BEFORE Claude's process starts, not during/after.

### Claude Code's own `$TMUX` behavior

Claude Code checks `$TMUX` for its own nested-session detection (it sets `CLAUDECODE=1` and refuses to start if that's already set). It does NOT auto-create tmux sessions — it just uses whatever terminal it's launched in.

---

## 2. Current Architecture (Relevant Parts)

```
┌──────────────────────────────────────────────────────┐
│  PATH: ~/bin/claude  exists?                         │
│    NO → user runs ~/.local/bin/claude directly       │
│    YES → airprompt-claude → airprompt-launch → tmux  │
│                                                      │
│  SessionStart hook → airprompt-activate.js           │
│    → detectTmux(): check process.env.TMUX            │
│    → NO tmux: create empty airprompt-* session       │
│       (BUG: Claude runs OUTSIDE this session)        │
│    → YES tmux: register normally                     │
│                                                      │
│  Web UI → WS → node-pty → tmux attach-session        │
│    → mirrors the REAL tmux session (or empty one)    │
└──────────────────────────────────────────────────────┘
```

Key files:

- `bin/airprompt-launch` (295 lines) — creates tmux session, runs claude inside it
- `src/hooks/core/activate.js` (309 lines) — SessionStart handler, `detectTmux()` at line 74
- `server.js` (608 lines) — `spawnPty()` at line 349 creates grouped web session
- `bin/airprompt-attach.sh` (150 lines) — reptyr-based manual attach (exists but requires explicit PID)
- `~/bin/airprompt-claude` → 3-line wrapper calling `airprompt-launch --provider claude`

Current PATH order: `~/.local/bin` (position 5) before `~/bin` (position 6). Real `claude` at `~/.local/bin/claude`.

---

## 3. Solution Options

### Option A: PATH Interception via Shell Wrapper ⭐ RECOMMENDED

**What:** Create `~/bin/claude` wrapper that calls `airprompt-launch --provider claude "$@"`, and ensure `~/bin` is before `~/.local/bin` in `$PATH`.

**Implementation:**

1. Create `~/bin/claude` wrapper (see section 6.1 below for full injection strategy — guard blocks, recursion fix, all four cases)
2. Add to `~/.bashrc` / `~/.zshrc` (via install script):
   ```bash
   # AirPrompt: ensure ~/bin is before ~/.local/bin for claude wrapper
   export PATH="$HOME/bin:$PATH"
   ```
3. Add same for `codex`, `cursor`, `windsurf` (already have `~/bin/airprompt-*` wrappers)

**Pros:**

- Zero user behavior change — they keep typing `claude`
- Already-proven pattern (the `airprompt-claude` wrapper exists and works)
- Works for all providers (claude, codex, cursor, windsurf)
- Simple, reliable, no race conditions
- Easy to install/uninstall (just add/remove the wrapper file)
- Works in tmux detection: `airprompt-launch` line 277-281 → if already inside tmux, just `exec`s the real binary in-place (no double-wrapping)

**Cons & risks (with mitigations):**

| Risk                                                                                                    | Severity    | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Recursion loop**: `~/bin/claude` → `airprompt-launch` → `command -v claude` → finds wrapper again → ∞ | 🔴 CRITICAL | Fix `airprompt-launch` binary resolution to skip `~/bin` when searching PATH. OR pass `--binary $(PATH minus ~/bin which claude)` from wrapper. **Must fix before shipping.**                                                                                                                                                                                                                                             |
| **Pre-existing `~/bin/claude`**: user already has a `~/bin/claude` (symlink, script, or whatever)       | 🟡 Medium   | **Minimal invasive injection — never overwrite.** Append AirPrompt's logic at top of existing file, inside marked guard block (`### AIRPROMPT BEGIN` / `### AIRPROMPT END`). Original user code runs after our guard returns. Uninstall/off/clean strips only the guard block, leaves user's original untouched. If file is binary or symlink: rename to `~/bin/claude.real`, create wrapper script that exec's original. |
| **Claude updates overwrite?**                                                                           | 🟢 None     | Claude's installer only touches `~/.local/bin/claude` and `~/.local/share/claude/versions/`. Our wrapper lives at `~/bin/claude` — different directory. Never gets touched.                                                                                                                                                                                                                                               |
| **Absolute path bypass**: `~/.local/bin/claude` or `/usr/local/bin/claude`                              | 🟡 Medium   | Uncommon for interactive terminal use. Desktop shortcuts / IDE integrations may use absolute paths.                                                                                                                                                                                                                                                                                                                       |
| **`~/bin` before `~/.local/bin` shadows other tools**                                                   | 🟡 Medium   | Only shadows tools that exist in BOTH `~/bin` and `~/.local/bin`. Installer lists conflicts. User can opt out.                                                                                                                                                                                                                                                                                                            |

**Success rate:** ~95% for interactive terminal use. Non-interactive (scripts, IDE launchers, desktop shortcuts) may bypass.

---

### Option B: reptyr Auto-Attach in SessionStart Hook

**What:** When `activateSession()` detects no tmux session, use `reptyr` to steal the running Claude process into a newly-created tmux session.

**Implementation:**

1. In `detectTmux()` failure path, find the Claude PID via `process.ppid` chain
2. Create tmux session: `tmux new-session -d -s airprompt-$PID`
3. Steal the process: `reptyr $CLAUDE_PID` (from within the tmux session)
4. Register normally

**Existing code:** `bin/airprompt-attach.sh` already implements this pattern for manual use.

**Pros:**

- Works regardless of how claude was launched (absolute path, alias, desktop shortcut)
- No PATH manipulation needed
- Already partially implemented (`airprompt-attach.sh`)

**Cons:**

- `reptyr` uses `ptrace(2)` — requires:
  - `kernel.yama.ptrace_scope=0` (default is 1 on Ubuntu, only allows child tracing)
  - OR `sudo` (unacceptable for a user tool)
  - OR `CAP_SYS_PTRACE` capability
- The `-T` (TTY-stealing) mode doesn't use ptrace but has other limitations
- Race condition: hook fires after Claude TUI is already rendering — terminal state may be corrupted
- Claude's parent bash wrapper captures pane output on exit — reptyr would break this
- Linux-only (`reptyr` has no macOS support)
- Fragile across kernel versions and security configurations

**Success rate:** ~60-70% on Linux with ptrace_scope=0. Near-zero on default Ubuntu configs without manual sysctl change.

---

### Option C: Shell preexec Hook (bash DEBUG trap / zsh preexec)

**What:** Hook into the shell's command execution pipeline to detect `claude` invocations and rewrite them to `airprompt-launch`.

**Implementation (bash):**

```bash
# In ~/.bashrc
airprompt_intercept() {
  local cmd="$BASH_COMMAND"
  case "$cmd" in
    claude\ *|claude)
      # Kill the DEBUG trap temporarily to avoid recursion
      trap - DEBUG
      airprompt-launch --provider claude ${cmd#claude }
      trap airprompt_intercept DEBUG
      # Prevent original command from running
      kill -INT 0
      ;;
  esac
}
trap airprompt_intercept DEBUG
```

**Implementation (zsh):**

```zsh
airprompt_preexec() {
  if [[ "$1" =~ ^claude(\ |$) ]]; then
    airprompt-launch --provider claude ${1#claude }
    # Return 1 to prevent original execution
    return 1
  fi
}
```

**Pros:**

- No PATH tricks needed
- Shell-native, no ptrace dependencies
- Cross-platform (bash/zsh on any OS)

**Cons:**

- Shell-specific — needs bash AND zsh AND fish versions
- `DEBUG` trap is fragile — other tools may fight over it
- Only works in interactive shells
- Non-interactive execution (scripts, IDE launch buttons, desktop shortcuts) bypass
- `kill -INT 0` to abort the original command is a hack
- The hook fires for EVERY command, adding overhead
- Complex edge cases (piped claude, background claude, `nohup claude`, etc.)

**Success rate:** ~85% for interactive terminal use. Bash-only or zsh-only.

---

### Option D: Claude Code Plugin Pre-Launch Binary Rename

**What:** Move the real `claude` binary to `claude-real`, install a wrapper script at the original location that delegates to `airprompt-launch`.

**Implementation:**

```bash
# During install:
mv ~/.local/bin/claude ~/.local/bin/claude-real
cat > ~/.local/bin/claude << 'EOF'
#!/bin/bash
exec airprompt-launch --provider claude --binary ~/.local/bin/claude-real "$@"
EOF
chmod +x ~/.local/bin/claude
```

**Pros:**

- 100% coverage — catches ALL invocations (absolute paths, scripts, aliases, everything)
- No shell hooks needed
- No PATH changes needed

**Cons:**

- **Invasive** — modifies Claude Code's installation directory
- **Breaks on Claude updates** — `claude update` or `npm update` may overwrite the wrapper
- Claude Code manages its own installation (`~/.local/share/claude/versions/...`) with symlinks
- Feels "hacky" and user-hostile
- Install/uninstall is destructive (need to carefully restore original binary)
- May trigger security warnings or integrity checks

**Success rate:** 100% (until the next Claude update undoes it).

**Verdict:** ❌ NOT RECOMMENDED. Too invasive, too fragile on updates.

---

### Option E: AirPrompt PTY Direct Connection (No tmux)

**What:** Instead of requiring the IDE to run inside tmux, have AirPrompt connect directly to the terminal's PTY master/slave pair.

**Implementation sketch:**

1. At SessionStart, find the Claude process's controlling terminal: `/proc/$PID/fd/0`
2. Open the PTY master (requires root or special permissions)
3. Stream PTY output to the web UI
4. Inject input into the PTY

**Pros:**

- No tmux dependency at all
- Works for any terminal-based app
- Cleaner architecture long-term

**Cons:**

- **Massive architectural change** — rewrites core of server.js (lines 349-435)
- Requires `root` or `CAP_SYS_ADMIN` to access another process's PTY master
- Terminal ownership conflict — both local user AND web user fight over stdin
- Local terminal breaks when web client sends keystrokes
- Can't "detach" from the session — closing the local terminal kills the process
- Loses tmux's session persistence (daemon restart recovery)
- No macOS equivalent (`/proc` is Linux-only)

**Verdict:** ❌ NOT RECOMMENDED for PoC. Fundamental redesign. Only viable as v2 with root privileges.

This is essentially what the [holdpty vendoring plan](./PLAN%20-%20holdpty%20vendoring.md) aims to do long-term — replace tmux with node-pty, where AirPrompt OWNS the PTY from process creation. When holdpty lands, the auto-inject problem disappears entirely because there's no tmux to inject into.

---

### Option F: tmux `session-created` Global Hook

**What:** Add `set-hook -g session-created 'run-shell ...'` to `~/.tmux.conf` so AirPrompt auto-registers ANY new tmux session, regardless of how it was created.

**Implementation:**

```tmux
# In ~/.tmux.conf
set-hook -g session-created 'run-shell "~/.airprompt/bin/airprompt-on-session.sh #{session_name}"'
```

The script detects whether the session contains an IDE process and auto-registers it.

**Pros:**

- Captures sessions created by ANY means (manual `tmux new-session`, other tools, scripts)
- No shell hooks or PATH tricks needed
- tmux-native mechanism (since tmux 2.4)

**Cons:**

- Only works if user already has `claude` running inside SOME tmux session
- Does NOT solve the core problem — if user runs `claude` outside tmux, no tmux session exists to hook
- Complements rather than replaces PATH wrapper approach
- Requires modifying user's `~/.tmux.conf` (invasive for tmux power-users)
- Each session-created hook runs `run-shell`, adding overhead

**Success rate:** 0% for the core problem (claude outside tmux). ~100% for claude-inside-tmux-already.

**Verdict:** Useful as defense-in-depth for Phase 2, not a Phase 1 solution. Users who already use tmux get auto-registration; users who don't still need Option A.

---

## 4. Comparative Matrix

| Criterion | A: PATH Wrapper | B: reptyr Hook | C: Shell Hook | D: Binary Rename | E: PTY Direct | F: tmux Hook |
|---|---|---|---|---|---|---|---|
| Success rate | ~95% | ~60% | ~85% | 100%* | ~80% | 0%¹ |
| Cross-platform | ✅ | ❌ Linux-only | ✅ | ✅ | ❌ Linux-only | ✅ |
| No user behavior change | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Survives Claude updates | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| Non-invasive install | ✅ | ⚠️ (ptrace) | ✅ | ❌ | ❌ (root) | ⚠️ (.tmux.conf) |
| Implementation effort | Low | Medium | Medium | Low | Very High | Low |
| Maintenance burden | Low | High | Medium | High | Very High | Low |
| Security risk | None | ptrace | None | Tampering | Root daemon | None |
| Solves core problem² | ✅ | ⚠️ Fragile | ✅ | ✅ | ❌ | ❌ |

¹ Option F captures sessions already in tmux — not claude running outside tmux.
² Core problem: claude launched directly outside tmux → web UI shows bash, not Claude.

---

## 5. Recommended Path: Staged Rollout

### Phase 1 (Now): PATH Wrapper + SessionStart Enhancement

1. **Create `~/bin/claude` wrapper** (same pattern as existing `airprompt-claude`)
2. **Update install script** (`bin/install.js`) to:
   - Create `~/bin/claude`, `~/bin/codex`, `~/bin/cursor`, `~/bin/windsurf` wrappers
   - Add PATH adjustment to shell profile (`export PATH="$HOME/bin:$PATH"`)
3. **Enhance SessionStart hook** with a warning when no tmux detected:
   - Log: "WARNING: claude running outside tmux — web UI unavailable. Run `claude` through airprompt-launch."
   - Send notification to existing web UI clients
4. **Add `airprompt doctor` command** that diagnoses:
   - Is `~/bin` before `~/.local/bin` in PATH?
   - Is the `claude` wrapper in place?
   - Is the real `claude` binary accessible?

### Phase 2 (Next): reptyr Fallback in SessionStart

1. Add `reptyr` detection to `detectTmux()` failure path
2. If `reptyr` available AND `ptrace_scope=0`, auto-attach the Claude process
3. If `reptyr` unavailable, log a clear error with install instructions
4. Document the `ptrace_scope` requirement

### Phase 3 (Future): Process Monitor Daemon

1. AirPrompt daemon watches `/proc` for new `claude`/`codex`/etc. processes
2. Detects processes outside tmux
3. Sends "orphan session" notification to iOS/Android app
4. One-tap "Capture session" button on mobile that runs reptyr

---

## 6. Implementation Details — Phase 1

### 6.1 Injection strategy: minimal, reversible, non-destructive

**Principle:** NEVER overwrite user files. Always inject minimally. Always undo cleanly.

#### Case A: `~/bin/claude` does NOT exist

Create it fresh with the full wrapper:

```bash
#!/bin/bash
### AIRPROMPT BEGIN — auto-inject wrapper (do not edit manually)
# Wraps claude inside tmux for AirPrompt remote mobile access.
# Removed by: airprompt uninstall / airprompt clean / airprompt off
set -euo pipefail

# Find real claude — skip ~/bin to avoid recursion
_real_claude=""
_clean_path=""
for _d in $(echo "${PATH}" | tr ':' '\n'); do
  [ "$_d" = "$HOME/bin" ] && continue
  _clean_path="${_clean_path}${_clean_path:+:}${_d}"
done
_real_claude="$(PATH="$_clean_path" command -v claude 2>/dev/null || true)"
[ -z "$_real_claude" ] && _real_claude="claude"

exec airprompt-launch --provider claude --binary "$_real_claude" "$@"
### AIRPROMPT END
```

#### Case B: `~/bin/claude` EXISTS (regular file, NOT an airprompt wrapper)

**Do NOT overwrite.** Inject the AirPrompt guard block at the top, delegate to user's original logic as fallback:

```bash
#!/bin/bash
### AIRPROMPT BEGIN
# If inside airprompt env, delegate. Otherwise fall through to user code below.
if airprompt-launch --provider claude --binary "$_real_claude" "$@"; then
  exit 0
fi
### AIRPROMPT END
# ── Original user code below (untouched by AirPrompt) ──
...existing content...
```

The guard runs first. If `airprompt-launch` succeeds (daemon running, session registered), it takes over. If it fails (daemon down, uninstall in progress), execution falls through to the user's original `~/bin/claude` code.

**Injection algorithm:**

1. Read existing file
2. If guard block already present → idempotent, skip
3. If `#!/bin/bash` or `#!/bin/sh` shebang exists → insert guard after shebang
4. If no shebang → prepend guard at line 1, add shebang
5. Write modified file

**Removal algorithm (`uninstall`/`off`/`clean`):**

1. Read file
2. Strip everything between `### AIRPROMPT BEGIN` and `### AIRPROMPT END` (inclusive)
3. If result is empty file (was Case A) → delete file
4. If result has content (was Case B) → write original content back, delete `#!/bin/bash` if we added it
5. Result: file is bit-for-bit identical to pre-install state

#### Case C: `~/bin/claude` is a SYMLINK

Cannot inject into a symlink. Strategy:

1. Record symlink target: `~/bin/claude → /some/path`
2. Rename symlink: `mv ~/bin/claude ~/bin/claude.real`
3. Create wrapper script at `~/bin/claude`:

```bash
#!/bin/bash
### AIRPROMPT BEGIN
set -euo pipefail
_real_claude="$HOME/bin/claude.real"  # renamed original symlink
exec airprompt-launch --provider claude --binary "$_real_claude" "$@"
### AIRPROMPT END
```

4. **Removal:** delete `~/bin/claude`, rename `claude.real` back to `claude`

#### Case D: `~/bin/claude` is a BINARY (not a script)

Cannot inject. Same strategy as symlink:

1. Rename: `mv ~/bin/claude ~/bin/claude.real`
2. Create wrapper script (same as Case C)
3. **Removal:** delete wrapper, rename `.real` back

### 6.1b What triggers injection (all new — implemented in Phase 0)

| Command                  | Action                                                                  |
| ------------------------ | ----------------------------------------------------------------------- |
| `airprompt install`      | Inject guard into `~/bin/{claude,codex,cursor,windsurf}` (Case A/B/C/D) |
| `airprompt on`           | Verify guard exists, inject if missing (idempotent)                     |
| `airprompt autostart on` | Same as `on` — verify + inject                                          |
| `airprompt doctor`       | Diagnose only: guard present? PATH correct? real binary accessible?     |

### 6.1c What triggers removal — undo injection (all new — implemented in Phase 0)

**Current state:** `clean.sh` removes `~/bin/airprompt-{provider}` wrappers only (line 83 of clean.sh — NOT `claude`/`codex`/etc. base names). `off.sh` has NO guard-strip logic. Both need extension in Phase 0.

**After Phase 0:**

| Command               | Action                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `airprompt uninstall` | Strip guard from ALL injected files, restore originals bit-for-bit                                   |
| `airprompt clean`     | Same as uninstall — strip all guards, restore all originals                                          |
| `airprompt off`       | Strip guard only for current provider (e.g., only `~/bin/claude` guard removed, `~/bin/codex` stays) |

**Invariant:** After any of these commands, `~/bin/claude` is bit-for-bit identical to its pre-AirPrompt state. User never loses their customizations.

### 6.1d Fix `airprompt-launch` binary resolution (defense-in-depth)

In addition to the wrapper passing `--binary`, `airprompt-launch`'s own resolution (line 62-76) should skip `~/bin` as defense-in-depth:

```bash
# When --binary is not given, resolve from PATH minus ~/bin
if [ -z "$REAL_BINARY" ]; then
  _clean_path=""
  for _d in $(echo "${PATH}" | tr ':' '\n'); do
    [ "$_d" = "$HOME/bin" ] && continue
    _clean_path="${_clean_path}${_clean_path:+:}${_d}"
  done
  if PATH="$_clean_path" command -v "$PROVIDER_ID" >/dev/null 2>&1; then
    REAL_BINARY="$(PATH="$_clean_path" command -v "$PROVIDER_ID")"
  elif ...
fi
```

### 6.2 Shell profile injection

Add to `~/.bashrc` and `~/.zshrc` (idempotent, marked with comment guards):

```bash
# >>> AirPrompt >>> ensure ~/bin wrappers have priority
export PATH="$HOME/bin:$PATH"
# <<< AirPrompt <<<
```

### 6.3 `airprompt doctor` command

New `bin/airprompt-doctor.sh` that checks:

```bash
# 1. Is ~/bin in PATH before ~/.local/bin?
# 2. Does ~/bin/claude exist?
# 3. Is the real claude binary accessible?
# 4. Is ptrace_scope permissive? (bonus check for Phase 2)
# 5. Are tmux/node/curl available?
```

### 6.4 Changes to existing code

| File                         | Change                                                                                                                                                                                                            | Status   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `bin/airprompt`              | Add `doctor` command dispatch                                                                                                                                                                                     | New      |
| `bin/airprompt-doctor.sh`    | NEW — diagnostic script                                                                                                                                                                                           | New      |
| `bin/install.js`             | Add base-name provider wrappers: `~/bin/{claude,codex,cursor,windsurf}` with guard-block injection                                                                                                                | Modified |
| `src/hooks/core/activate.js` | Warning message when no tmux detected (line 246-250)                                                                                                                                                              | Modified |
| `src/providers/claude.js`    | `install()` at line 408 creates `airprompt-claude` but NOT `claude` — extend to create base-name wrapper too. `uninstall()` at line 569 removes `airprompt-*` but must also strip guard blocks from `claude`/etc. | Modified |
| `bin/airprompt-clean.sh`     | Line 83 removes `airprompt-{provider}` wrappers — extend to also strip guard blocks from `~/bin/{claude,codex,cursor,windsurf}` (base names) and restore originals per Case A/B/C/D                               | Modified |
| `bin/airprompt-off.sh`       | Add guard-strip logic for current provider (currently has no wrapper removal at all)                                                                                                                              | Modified |
| `bin/airprompt-launch`       | Fix binary resolution to skip `~/bin` as defense-in-depth (section 6.1d)                                                                                                                                          | Modified |
| `bin/lib/protocol.sh`        | `_ensure_bin_symlinks` (line 54-83) restores symlinks + wrappers after clean — extend to handle base-name guard-block injection                                                                                   | Modified |

### 6.5 Rollback (undo injection)

All AirPrompt management commands auto-undo:

```bash
# Undo for single provider (strips guard from ~/bin/claude, restores original)
airprompt off

# Undo everything (all providers, all guards, full original state)
airprompt clean
airprompt uninstall
```

**Manual rollback** (if automated undo fails):

```bash
# If you have the .real backup (symlink/binary case):
mv ~/bin/claude.real ~/bin/claude

# If injection was into a script (Case B):
# Strip lines between ### AIRPROMPT BEGIN and ### AIRPROMPT END manually
# If file is empty after stripping → was Case A → delete it

# Remove PATH guards from shell profiles
# Strip lines between # >>> AirPrompt >>> and # <<< AirPrompt <<<
```

---

## 7. What Happens When User Runs `claude` After Phase 1

```
User types: claude
  → Shell resolves PATH: ~/bin/claude found (before ~/.local/bin/claude)
  → Wrapper runs: exec airprompt-launch --provider claude
    → airprompt-launch detects not-in-tmux
    → Creates tmux session: airprompt-$$-$TS
    → env FORWARD_ENV... bash -c 'claude; tmux capture-pane...'
    → tmux attach-session (user sees Claude TUI inside tmux)
  → SessionStart hook fires
    → detectTmux() finds the tmux session ✓
    → Registers with daemon normally ✓
  → User opens web UI → sees Claude session ✓
```

Edge cases handled:

- **Already inside tmux**: `airprompt-launch` line 277-281 → `exec claude` directly (no double-wrapping)
- **`--resume` flag**: `airprompt-launch` line 236-274 → resumes dead pane or reattaches
- **`\claude` (bypass)**: Shell escapes disable alias/function lookup. Wrappers are regular executables, not aliases, so `\claude` still resolves through PATH. Only absolute paths bypass.

---

## 8. Open Questions & Resolved

| #   | Question                                                                           | Status                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Other provider binaries — `codex`, `cursor`, `windsurf` — same wrapper pattern?    | **Resolved:** Yes. Same guard-block injection for all four: `~/bin/{claude,codex,cursor,windsurf}`                                                          |
| 2   | Non-interactive launches — VS Code "Open in Claude Code" button, desktop shortcuts | **Open:** PATH-only solution won't catch these. Out of scope for Phase 1. Phase 3 (process monitor) may address.                                            |
| 3   | `npx claude` — does it invoke the local `claude` binary?                           | **Open.** If `npx` uses full PATH resolution, our `~/bin/claude` wrapper catches it. If `npx` uses npm's own resolution, it bypasses.                       |
| 4   | PATH ordering conflict — `~/bin` before `~/.local/bin` shadows other tools         | **Open:** Installer lists conflicts. User opts out. Mitigation: `PATH="$HOME/bin:$PATH"` is only injected into interactive shell profiles, not system-wide. |
| 5   | `airprompt-launch` not found in PATH after `clean`                                 | **Resolved:** `lib/protocol.sh` `_ensure_bin_symlinks()` restores symlinks on next invocation. Clean → immediate re-use works.                              |

### Out of scope for Phase 1 (noted for future)

- `airprompt-attach.sh` (reptyr) — manual tool, not affected by auto-inject. Becomes **obsolete after holdpty Phase 5** (no tmux = no reptyr needed).
- `airprompt` dispatcher has no `attach` command mapping — `airprompt-attach.sh` exists but is only runnable directly. Not added to dispatcher in Phase 1.
- Nested tmux detection (`CLAUDECODE=1` unset) — `airprompt-launch` already handles this correctly (line 277-281).
