# PLAN — Caveman Spirit: One-Command Install for AirPrompt

## Context

Caveman (`github.com/JuliusBrussee/caveman`) ships as a single curl-pipe command
that detects every AI agent on the machine and installs for each. **We reuse its
well-tested installer code directly** — `install.sh`, `install.ps1`, `bin/lib/settings.js`
are adapted from caveman with minimal changes (REPO variable, managed hook basenames).
Its architecture:

```
install.sh ──→ bin/install.js (unified Node installer)
install.ps1 ──→ bin/install.js (unified Node installer)
                    │
                    ├── detect agents (PROVIDERS matrix)
                    ├── install per-agent (plugin / npx skills / native copy)
                    ├── wire hooks into settings.json
                    └── uninstall
```

Key design decisions that make this work:
1. **Shell shims are thin** — only check Node version, detect "local clone vs curl-pipe", delegate to Node.
2. **Single Node installer** (`bin/install.js`) — all logic in one place. Pure stdlib, zero npm deps. Works on macOS, Linux, Windows.
3. **Provider matrix** — one data structure defines all supported agents, their detection rules, and install mechanisms.
4. **Idempotent** — re-running is safe. Skips already-installed pieces. `--force` to overwrite.
5. **Settings management library** — JSONC-tolerant read/write/prune/validate for `settings.json`. Atomic writes (tmp + rename).
6. **Plugin manifest** — `.claude-plugin/plugin.json` + `marketplace.json` so `claude plugin install` works as alternative path.
7. **Managed hook tracking** — knows which hook entries it owns via exact basename match, clean uninstall possible.

AirPrompt currently has none of this. Installation is manual: clone repo, `npm install`, manually wire hooks, manually copy skill/command files. This plan adapts caveman's patterns.

---

## Goal

```
# One command. Installs AirPrompt for Claude Code. Auto-starts daemon. Wires everything.
curl -fsSL https://raw.githubusercontent.com/diegomanuel/airprompt/main/install.sh | bash
```

After this single command:
- Repo cloned to `~/.airprompt/` (or `npm install -g airprompt` path)
- `npm install` run
- Claude Code plugin installed (`claude plugin install airprompt@airprompt`)
- Hooks wired: SessionStart (auto-register), Stop (auto-unregister), statusline badge
- Skill + command files in place
- Daemon auto-starts on first SessionStart hook fire

`/airprompt on` / `/airprompt off` still work as manual toggles. Hooks make it automatic — user opens Claude Code, session auto-registers, phone sees it.

---

## Architecture (Post-Implementation)

```
curl | bash
    │
    ▼
install.sh (thin shim)
    │  • Checks Node ≥ 18
    │  • Detects local clone vs curl-pipe
    │  • Delegates to bin/install.js
    ▼
bin/install.js (unified installer, pure stdlib)
    │
    ├── 1. Clone/verify repo at target dir
    ├── 2. npm install (deps: express, ws, node-pty, qrcode-terminal)
    ├── 3. Install Claude Code plugin (claude plugin install)
    ├── 4. Copy hook files to ~/.claude/hooks/
    ├── 5. Wire hooks into ~/.claude/settings.json:
    │       • SessionStart → airprompt-activate.js
    │       • Stop          → airprompt-deactivate.js
    │       • StatusLine    → airprompt-statusline.sh
    ├── 6. Copy skill + command files to ~/.claude/
    └── 7. --uninstall removes everything
```

---

## New Files to Create

| File | Source | Purpose |
|------|--------|---------|
| `install.sh` | **Copied from caveman** (3 changes) | Shell shim — curl-pipe entry point |
| `install.ps1` | **Copied from caveman** (3 changes) | PowerShell shim — Windows entry point |
| `bin/install.js` | **Adapted from caveman** (keep structure, swap install/uninstall logic) | Unified Node installer. All logic. Pure stdlib. |
| `bin/lib/settings.js` | **Copied verbatim from caveman** (only MANAGED_HOOK_BASENAMES changed) | JSONC-tolerant settings.json read/write/validate |
| `.claude-plugin/plugin.json` | New (pattern from caveman's) | Claude Code plugin manifest — hooks definition |
| `.claude-plugin/marketplace.json` | New (pattern from caveman's) | Marketplace entry so `claude plugin install` finds it |
| `src/hooks/airprompt-activate.js` | New (replaces `bin/airprompt-register.sh` core logic) | SessionStart hook. Ensures daemon running, registers session |
| `src/hooks/airprompt-deactivate.js` | New (replaces `bin/airprompt-unregister.sh` core logic) | Stop hook. Unregisters session from daemon |
| `src/hooks/airprompt-statusline.sh` | **Moved** from `~/.claude/hooks/` into repo | Statusline badge |
| `src/hooks/package.json` | New | Empty `{}` for Node module resolution |

---

## Files to Modify

| File | Change |
|------|--------|
| `bin/airprompt-register.sh` | Refactor: extract core logic into `airprompt-activate.js`. Shell script becomes thin wrapper. |
| `bin/airprompt-unregister.sh` | Refactor: extract core logic into `airprompt-deactivate.js`. Shell script becomes thin wrapper. |
| `package.json` | Add `"bin": { "airprompt": "./bin/install.js" }`, add `"files": [...]` for npm publish. |
| `.claude/skills/airprompt.md` | Update to document automatic hook behavior alongside manual `/airprompt on/off`. |
| `.claude/commands/airprompt.md` | Same — document auto-register via hooks. |

---

## `install.sh` Design — reused from caveman

**Strategy**: Copy caveman's `install.sh` verbatim (54 lines, extremely well-tested across macOS/Linux/WSL/Git Bash). Only 3 changes needed:

| Line | Caveman original | AirPrompt change |
|------|-----------------|------------------|
| `REPO="JuliusBrussee/caveman"` | Caveman repo | `REPO="diegomanuel/airprompt"` |
| `exec npx -y "github:$REPO" "$@"` | npx delegation (zero npm deps) | `git clone --depth 1 "https://github.com/${REPO}.git" "$TMP_DIR" && exec node "$TMP_DIR/bin/install.js" "$@"` (clone then exec — airprompt has runtime npm deps) |
| Error messages say `caveman:` | Brand prefix | `airprompt:` |

**Why npx doesn't work for curl-pipe path**: Caveman has zero runtime npm deps (`bin/install.js` is pure stdlib), so `npx -y github:...` works instantly. AirPrompt HAS runtime deps (`express`, `ws`, `node-pty`, `qrcode-terminal`). `npx` would download the package but NOT run `npm install` for its dependencies. So curl-pipe path must shallow-clone the repo + let `bin/install.js` handle `npm install`.

Everything else stays identical — the `BASH_SOURCE` local-clone detection, the Node ≥18 check, the `set -euo pipefail`, the `npx` fallback note, the `"$@"` forwarding. All battle-tested.

### Full `install.sh` (with changes annotated)

```bash
#!/usr/bin/env bash
# airprompt — installer shim (adapted from caveman's install.sh).
#
# Thin wrapper around bin/install.js (the unified Node installer). Every flag
# you'd pass to bin/install.js can be passed here; we just forward them.
#
# One-line install:
#   curl -fsSL https://raw.githubusercontent.com/diegomanuel/airprompt/main/install.sh | bash
#
# Local clone:
#   bash install.sh [flags]

set -euo pipefail

REPO="diegomanuel/airprompt"                         # ← CHANGED from JuliusBrussee/caveman

# Require Node ≥18
if ! command -v node >/dev/null 2>&1; then
  echo "airprompt: Node.js (≥18) required. Install:" >&2    # ← CHANGED prefix
  echo "  macOS:  brew install node" >&2
  echo "  Linux:  see https://nodejs.org or use nvm (https://github.com/nvm-sh/nvm)" >&2
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "airprompt: Node $NODE_MAJOR too old. Need Node ≥18." >&2  # ← CHANGED prefix
  echo "  Upgrade: https://nodejs.org" >&2
  exit 1
fi

# Local clone → run installer directly (unchanged from caveman)
here="$(cd "$(dirname "${BASH_SOURCE[0]:-}")" 2>/dev/null && pwd)" || here=""
if [ -n "$here" ] && [ -f "$here/bin/install.js" ]; then
  exec node "$here/bin/install.js" "$@"
fi

# Curl-pipe path: shallow clone then exec installer.
# ← CHANGED: caveman uses `exec npx -y "github:$REPO" "$@"` here.
# We can't — airprompt has runtime npm deps (express, ws, node-pty, qrcode-terminal)
# that npx won't install. Clone + let bin/install.js handle npm install.
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT
git clone --depth 1 "https://github.com/${REPO}.git" "$TMP_DIR" 2>/dev/null
exec node "$TMP_DIR/bin/install.js" "$@"
```

---

## `install.ps1` Design — reused from caveman

Same strategy as `install.sh`. Copy caveman's `install.ps1` verbatim (79 lines). Same 3 change points:

| Element | Caveman original | AirPrompt change |
|---------|-----------------|------------------|
| `$Repo` | `"JuliusBrussee/caveman"` | `"diegomanuel/airprompt"` |
| Curl-pipe fallback | `& npx -y "github:$Repo" @InstallerArgs` | `git clone --depth 1 "https://github.com/$Repo.git" $tmp; & node "$tmp/bin/install.js" @InstallerArgs` |
| Error messages | `caveman:` prefix | `airprompt:` |

---

## `bin/install.js` Design — adapted from caveman

Reuses caveman's `bin/install.js` structure (1531 lines, battle-tested). Pure stdlib (`fs`, `path`, `os`, `child_process`, `crypto`). No npm deps.

**What we keep from caveman verbatim**:
- `parseArgs()` — CLI flag parsing with identical flags (`--dry-run`, `--force`, `--only`, `--list`, `--no-color`, `--non-interactive`, `--uninstall`, `-h/--help`, `--`)
- `die()`, `makeChalk()`, `checkWslWindowsNode()`, `checkNodeVersion()` — env guards
- `hasCmd()`, `shellEscape()`, `expandHome()`, `detectMatch()`, `safeStat()` — detection functions
- `quoteWinArg()`, `spawnXplat()`, `runSpawn()`, `captureSpawn()`, `spawnOk()`, `absoluteNodePath()` — run helpers
- `downloadTo()`, `sha256File()`, `loadRemoteHookChecksums()`, `copyDirRecursive()` — I/O utilities
- `pad()`, `printHelp()`, `printList()`, `promptForOnly()` — UI helpers
- `main()` — entry point with detection loop, per-provider dispatch, summary

**What we adapt**:
- `REPO` → `'diegomanuel/airprompt'`
- `PROVIDERS` → starts with just `claude` (extensible for future agents)
- `HOOK_FILES` → airprompt hook files
- `installClaude()` → airprompt's plugin install + hook wiring + daemon setup
- `uninstall()` → airprompt cleanup (stop daemon, remove markers)
- Remove providers we don't use yet: gemini, opencode, openclaw, codex, cursor, hermes, etc.
- Remove `runInit()` — no per-repo init files for airprompt (yet)
- Remove `installMcpShrink()` — not needed

### Flags

| Flag | Action |
|------|--------|
| `--dry-run` | Print what would happen, do nothing. |
| `--force` | Re-install even if already installed. |
| `--uninstall`, `-u` | Remove airprompt from this machine. |
| `--no-hooks` | Skip hooks wiring (plugin manifest handles it). |
| `--with-hooks` | Force hooks wiring even if plugin installed. |
| `--only <agent>` | Install only for named agent. Repeatable. |
| `--list` | Print supported agents and exit. |
| `--no-color` | Disable ANSI colors. |
| `--config-dir <path>` | Override Claude Code config dir. |
| `--target-dir <path>` | Where to clone/install the repo. Default: `~/.airprompt/`. |
| `--port <n>` | Daemon port. Default: 3210. |
| `-h`, `--help` | Print help. |

### Install Steps

```
install()
  1. Resolve target dir (~/.airprompt/ or --target-dir)
  2. If not a git repo, clone from GitHub
  3. If deps missing (no node_modules/), run npm install
  4. Install Claude Code plugin:
     claude plugin marketplace add diegomanuel/airprompt
     claude plugin install airprompt@airprompt
  5. Copy hook files to ~/.claude/hooks/:
     - airprompt-activate.js
     - airprompt-deactivate.js
     - airprompt-statusline.sh
     - package.json
  6. Wire settings.json:
     - SessionStart → airprompt-activate.js
     - Stop          → airprompt-deactivate.js
     - StatusLine    → airprompt-statusline.sh
  7. Copy skill + command files to ~/.claude/ (if not already via plugin)
  8. Print summary + next steps
```

### Uninstall Steps

```
uninstall()
  1. Remove hook entries from settings.json
  2. Delete hook files from ~/.claude/hooks/
  3. claude plugin uninstall airprompt@airprompt
  4. Remove skill + command files
  5. Stop daemon if running (kill PID from /tmp/airprompt-server.pid)
  6. Optional: remove ~/.airprompt/ (ask or --force)
```

### Provider Matrix

Start minimal — just Claude Code. Extensible data structure for future agents.

```js
const PROVIDERS = [
  {
    id: 'claude',
    label: 'Claude Code',
    mech: 'claude plugin install',
    detect: 'command:claude',
  },
  // Future:
  // { id: 'codex',  label: 'Codex CLI', mech: 'npx skills add', detect: 'command:codex', profile: 'codex' },
  // { id: 'cursor', label: 'Cursor',    mech: 'npx skills add', detect: 'command:cursor||macapp:Cursor', profile: 'cursor' },
];
```

### Detection Functions (from caveman, adapted)

```js
function hasCmd(cmd)       // command -v on unix, where on windows
function detectMatch(spec) // parse ||-separated detection rules
```

---

## `bin/lib/settings.js` Design — copied verbatim from caveman

Caveman's `bin/lib/settings.js` (361 lines) is a standalone library with zero caveman-specific business logic. It's pure JSONC-tolerant settings I/O. We copy it verbatim with one change:

| Change | Caveman | AirPrompt |
|--------|---------|-----------|
| `MANAGED_HOOK_BASENAMES` | `caveman-activate.js`, `caveman-mode-tracker.js`, `caveman-stats.js`, `caveman-statusline.sh`, `caveman-statusline.ps1` | `airprompt-activate.js`, `airprompt-deactivate.js`, `airprompt-statusline.sh` |

Same API surface:

| Function | Purpose |
|----------|---------|
| `readSettings(path)` | JSONC-tolerant read. Returns object, `{}`, or `null` on hard failure. |
| `writeSettings(path, obj)` | Atomic write (tmp + rename, mode 0600). |
| `validateHookFields(settings)` | Drop malformed hook entries so Zod doesn't discard entire file. |
| `addCommandHook(settings, event, opts)` | Idempotent push of `{hooks: [{type:'command', command:'...'}]}`. |
| `removeManagedHooks(settings, basenames)` | Strip entries whose command references our managed scripts. |
| `pruneOrphanedHooks(settings, configDir)` | Remove entries pointing at scripts that no longer exist on disk. |

Managed hook basenames for airprompt:
- `airprompt-activate.js`
- `airprompt-deactivate.js`
- `airprompt-statusline.sh`

---

## Plugin Manifest Design

### `.claude-plugin/plugin.json`

```json
{
  "name": "airprompt",
  "description": "Remote control and voice dictation for Claude Code via web terminal",
  "author": { "name": "Farox", "url": "https://github.com/diegomanuel" },
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "node \"${CLAUDE_PLUGIN_ROOT}/src/hooks/airprompt-activate.js\"",
        "timeout": 10,
        "statusMessage": "Registering AirPrompt session..."
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "node \"${CLAUDE_PLUGIN_ROOT}/src/hooks/airprompt-deactivate.js\"",
        "timeout": 5,
        "statusMessage": "Unregistering AirPrompt session..."
      }]
    }]
  }
}
```

### `.claude-plugin/marketplace.json`

```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "airprompt",
  "description": "Remote control and voice dictation for Claude Code. Control sessions from your phone.",
  "owner": { "name": "Farox", "url": "https://github.com/diegomanuel" },
  "plugins": [{
    "name": "airprompt",
    "description": "Watch and control Claude Code sessions from mobile with voice dictation",
    "source": "./",
    "category": "productivity"
  }]
}
```

---

## Hook Scripts Design

### `src/hooks/airprompt-activate.js` (SessionStart)

Replaces `bin/airprompt-register.sh`. Called every time a Claude Code session starts.

```
1. Check if daemon running (probe PID file + kill -0)
2. If not, start daemon: spawn 'node server.js' from install dir
3. Generate session ID: <timestamp>-<pid>-<cwd-basename>
4. Detect existing tmux session (if TMUX env var set) or create new one
5. POST to localhost:<port>/api/sessions/register
6. Write marker files: ~/.claude/.airprompt-active, ~/.claude/.airprompt-url
7. Print Mobile URL to stdout (visible in session start output)
```

Pure Node.js — no bash dependency for core logic. Uses `child_process` for `tmux`, `curl` (or Node `http` module).

### `src/hooks/airprompt-deactivate.js` (Stop)

Replaces `bin/airprompt-unregister.sh`. Called when Claude Code session ends.

```
1. Read session ID from ~/.claude/.airprompt-session
2. POST to localhost:<port>/api/sessions/unregister
3. Remove marker files
```

### `src/hooks/airprompt-statusline.sh`

Largely unchanged from current `~/.claude/hooks/airprompt-statusline.sh`. Reads stdin JSON, checks marker file, outputs badge.

---

## Settings.json Wiring

After install, `~/.claude/settings.json` gains:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "node \"${HOME}/.airprompt/src/hooks/airprompt-activate.js\"",
        "timeout": 10,
        "statusMessage": "Registering AirPrompt session..."
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "node \"${HOME}/.airprompt/src/hooks/airprompt-deactivate.js\"",
        "timeout": 5,
        "statusMessage": "Unregistering AirPrompt session..."
      }]
    }]
  },
  "statusLine": {
    "type": "command",
    "command": "bash \"${HOME}/.claude/hooks/airprompt-statusline.sh\""
  }
}
```

Plugin manifest also wires `SessionStart` + `Stop`. When plugin install succeeds, standalone hook wiring is skipped (same dedup logic as caveman) to avoid double-firing.

---

## User-Facing Changes

### Before (current)
```
# Manual multi-step install
git clone <repo>
cd airprompt
npm install
make setup
# Manually copy hook files
# Manually edit settings.json
# Manually copy skill/command files
# Manually add statusline hook to aggregator
```

### After
```
# One command
curl -fsSL https://raw.githubusercontent.com/diegomanuel/airprompt/main/install.sh | bash

# Or local clone
git clone <repo> && cd airprompt && bash install.sh

# Or Claude Code plugin
claude plugin marketplace add diegomanuel/airprompt
claude plugin install airprompt@airprompt

# Or npm (future)
npm install -g airprompt && airprompt install
```

### Session Behavior Change
- **Before**: User must type `/airprompt on` in each session to register.
- **After**: SessionStart hook auto-registers. `/airprompt on` / `/airprompt off` still work as manual toggle for turning it off mid-session.

---

## What Stays the Same

- `server.js` — no changes. Daemon logic is solid.
- `public/index.html` + `public/client.js` — no changes. Mobile UI is solid.
- Port 3210 — unchanged.
- Session registry (in-memory Map) — unchanged.
- WebSocket protocol — unchanged.
- REST API endpoints — unchanged.
- `Makefile` — keep for dev workflow (`make start`, `make test-all`, etc.).
- Test suite — unchanged. Add test for installer (`test/unit/installer.test.js`).

---

## Implementation Steps (Ordered)

### Step 1: Copy `install.sh` + `install.ps1` from caveman
- Copy `/home/diego/projects/caveman/install.sh` → `install.sh`
- Copy `/home/diego/projects/caveman/install.ps1` → `install.ps1`
- Change 3 things in each: `REPO`/`$Repo`, curl-pipe fallback (npx → git clone + exec), error prefix (`caveman:` → `airprompt:`)

### Step 2: Copy `bin/lib/settings.js` from caveman
- Copy `/home/diego/projects/caveman/bin/lib/settings.js` → `bin/lib/settings.js`
- Change `MANAGED_HOOK_BASENAMES` Set to airprompt's hook filenames
- Everything else stays verbatim — JSONC parser, atomic writes, validateHookFields, pruneOrphanedManagedHooks. All already tested.

### Step 3: Create `bin/install.js` (adapt caveman's structure)
- Start from caveman's `bin/install.js` skeleton (parseArgs, helpers, detection, provider loop, main)
- Replace `installClaude()` with airprompt version: clone/npm-install/plugin/hooks/statusline
- Replace `uninstall()` with airprompt version: hooks/settings/plugin/daemon cleanup
- Single provider in matrix: `claude`
- Remove unused providers (gemini, opencode, openclaw, hermes, codex, cursor, etc.)
- Remove `runInit()`, `installMcpShrink()`
- Tests: `test/unit/installer.test.js` for arg parsing, detection, provider matrix

### Step 4: Create Hook Scripts
- `src/hooks/airprompt-activate.js` — SessionStart auto-register. Pure Node.
- `src/hooks/airprompt-deactivate.js` — Stop auto-unregister. Pure Node.
- `src/hooks/airprompt-statusline.sh` — statusline badge (move from `~/.claude/hooks/` to repo).
- `src/hooks/package.json` — `{}`

### Step 5: Refactor Shell Scripts
- `bin/airprompt-register.sh` → thin wrapper around `airprompt-activate.js` core logic.
- `bin/airprompt-unregister.sh` → thin wrapper around `airprompt-deactivate.js` core logic.
- Both keep current CLI for backward compat (`/airprompt on` calls register.sh).

### Step 6: Create Claude Code Plugin Manifests
- `.claude-plugin/plugin.json` — SessionStart + Stop hooks with `${CLAUDE_PLUGIN_ROOT}` paths
- `.claude-plugin/marketplace.json` — plugin listing pointing to `diegomanuel/airprompt`

### Step 7: Update `package.json`
- Add `"bin": { "airprompt": "./bin/install.js" }`.
- Add `"files": [...]` for future npm publish.

### Step 8: Update Skill + Command Files
- Document auto-register behavior (SessionStart hook).
- Document new install path (one command).
- Keep `/airprompt on|off|status` commands.

### Step 9: Update `Makefile`
- Add `install` target: `node bin/install.js`.
- Add `uninstall` target: `node bin/install.js --uninstall`.

### Step 10: Add Installer Tests
- `test/unit/installer.test.js`: settings.js functions, arg parsing, detection
- `test/integration/install.sh`: full `install.sh --dry-run` then uninstall dry-run

### Step 11: Update `README.md`
- One-command install at top.
- Document all install paths (curl-pipe, local clone, plugin).
- Document auto-register behavior.

---

## Future: Multi-Agent Support

Provider matrix already designed for it. After Claude Code is solid:

| Agent | Install Mechanism | Detection |
|-------|-------------------|-----------|
| Codex CLI | `npx skills add` | `command:codex` |
| Cursor | `npx skills add` | `command:cursor` |
| Windsurf | `npx skills add` | `command:windsurf` |
| Gemini CLI | `gemini extensions install` | `command:gemini` |

Each would get its own skill/command files adapted to that agent's format. The installer's provider loop already handles this — caveman's pattern scales to 30+ agents.

---

## What We Explicitly Don't Do (Yet)

- **npm registry publish** — address after initial release. Installer supports both paths.
- **Windows `.ps1` shim** — design for it (`install.ps1` skeleton), full test later.
- **Multi-agent beyond Claude Code** — provider matrix is extensible, but implementation focuses on Claude Code first.
- **Config file** — no `~/.airpromptrc` yet. Port/config-dir via CLI flags + env vars for now. Add config file when demand emerges.
- **Auto-update** — caveman doesn't do this either. User re-runs install command to update.

---

## Implementation Status: COMPLETE (2026-07-27)

All steps (1–11) implemented. Key differences from original plan:

- **Per-session isolation**: marker files moved from global flat files to
  `~/.claude/.airprompt-sessions/{tmux-name}/` directories. Multiple Claude sessions coexist
  without fighting over global files. Legacy global markers cleaned up during migration.
- **Session naming**: `/airprompt name <name>` sets a human-readable label. Shows in
  statusline badge as `[<name>@https://<IP>:3210]` and in web UI session bar/modal.
  `/airprompt on <name>` registers with name in one step. New `PUT /api/sessions/name` endpoint.
- **Unified dispatcher**: `bin/airprompt` as single entrypoint for all subcommands
  (on/off/status/clean/name). Sub-scripts (`airprompt-on.sh`, etc.) are internal only.
- **`airprompt-claude` launcher**: starts Claude inside named tmux session and auto-registers
  with AirPrompt. Supports `--name`, `--continue`, `--resume`.
- **Web UI improvements**: WS auto-reconnect (exponential backoff, max 30s), resize debounce
  (200ms), session bar clickable, named sessions show `{name} ({cwd})` in bar and modal.
- **Deactivate guard hardened**: triple guard (per-session tmux file + legacy files + session
  group check). Respects server 409 response — won't delete local markers if daemon says
  tmux still alive.
- **Clean script hardened**: PID verification via `/proc/PID/cmdline` before killing, force-kill
  after 1s grace period.
- **Web proxy session resolution**: all scripts resolve `airprompt-web-*` tmux sessions to
  parent session group, preventing stale PID-based session ID generation.
- **`activate.js` idempotency**: SessionStart hook skips registration if this tmux session
  already has per-session `active` marker (from `/airprompt on`). Sweeps dead session dirs.
- **Statusline badge format**: named sessions show `[<name>@<url>]`, unnamed show
  `[AirPrompt: <url>]`. Per-session isolation via `~/.claude/.airprompt-sessions/`.
- **`status.sh`**: shows session name when set, cwd fallback otherwise.

Original steps 1–11 all implemented. No steps removed. See git log for full history.
