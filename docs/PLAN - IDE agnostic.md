# PLAN — IDE-Agnostic AirPrompt

## Goal

**Final goal**: AirPrompt fully IDE/CLI-agnostic. Core code has zero knowledge of which
IDE or CLI agent invoked it — everything IDE-specific lives behind the `Provider` interface.
Adding a new IDE means writing one provider file + thin hook wrappers. Zero changes to core logic.

**First milestone**: Claude Code running **exactly as it does today** — same hooks, same
daemon, same mobile UI, same plugin install path. Claude becomes the first `Provider`
implementation and the **proof that the agnostic refactoring is correct**. If Claude works
identically after the refactoring, the abstraction is right.

**After Claude**: the remaining IDEs/CLIs (Codex → Cursor → Windsurf → Gemini CLI
investigation) ship in **separate follow-up PRs**, each as a new provider file
auto-discovered by the registry. These only land after this PR is merged to `main`
and Claude is confirmed working correctly — Claude is the gate.

```
Before (current):                    Phase 1 (milestone):                Phase 2+ (future):
                                      Claude as provider —                 multi-IDE ready
┌──────────────────┐                 ┌──────────────────┐                 ┌──────────────────┐
│   base code      │                 │   base code      │                 │   base code      │
│   (hardwired to  │                 │   (provider-     │                 │   (provider-     │
│    Claude paths,  │                 │    agnostic)     │                 │    agnostic)     │
│    hooks, env)    │                 └────────┬─────────┘                 └────────┬─────────┘
└──────────────────┘                          │                                   │
                                    ┌─────────┴─────────┐              ┌─────────┼─────────┐
                                    │ ClaudeProvider    │              │         │         │
                                    │ (Claude = same    │        ClaudeProvider  │  CursorProvider
                                    │  as today,        │              │         │         │
                                    │  first proof)     │        CodexProvider   │ WindsurfProvider
                                    └───────────────────┘                             ...
```

---

## 1. Provider Adapter Interface

Each IDE implements this contract. Base code never references IDE names directly — it calls
`provider.method()`.

```js
// src/providers/provider.js — interface definition (JSDoc, no runtime enforcement)

/** @typedef {{
 *   id: string,              // 'claude' | 'codex' | 'cursor' | ...
 *   label: string,           // 'Claude Code' | 'Codex CLI' | ...
 *   mech: string,            // install mechanism description
 *   detect: string,          // 'command:claude' | 'command:codex||macapp:Cursor' | ...
 *   profile: string|null,    // skills.sh profile slug (null for native plugin installs)
 *
 *   // ---- Config resolution ----
 *   configDir(): string,                    // ~/.claude, ~/.codex, ~/.cursor, ...
 *   sessionsDir(): string,                 // where per-session marker files live
 *   hooksDir(): string,                    // where hook scripts are installed
 *   hooksConfigPath(): string,             // path to hook config file (settings.json | hooks.json | config.toml)
 *   skillsDir(): string,                   // where SKILL.md files go
 *   commandsDir(): string,                 // where command files go
 *   rulesDir(): string | null,             // where .md rules go (null if not supported)
 *
 *   // ---- Hook system ----
 *   hookEvents: {                           // event names this IDE supports
 *     sessionStart: string | null,          // 'SessionStart' | 'sessionStart' | null
 *     stop: string | null,                  // 'Stop' | 'stop' | null
 *     statusLine: string | null,            // 'StatusLine' | null (most IDEs: null)
 *   },
 *   commandPrefix: string,                  // '/' for Claude/Cursor, '$' for Codex
 *
 *   // ---- Detection ----
 *   detectMatch(spec: string): boolean,     // resolves ||-separated detection probes (command:, macapp:, vscode-ext:, etc.)
 *
 *   // ---- Hook I/O (adapter pattern) ----
 *   parseHookStdin(input: string): HookContext,   // normalize IDE-specific stdin → common format
 *   formatHookOutput(output: HookResult): string,  // common format → IDE-specific stdout
 *
 *   // ---- Settings/hook wiring ----
 *   buildHookEntry(event: string, scriptPath: string, timeout: number): object,  // generate hook entry for hookEvents.sessionStart/stop
 *   buildStatusLineEntry?(scriptPath: string): object | null,  // Claude-specific: top-level statusLine key. Returns null if IDE doesn't support it.
 *
 *   // ---- Install / Uninstall ----
 *   install(ctx: InstallContext): Promise<void>,
 *   uninstall(ctx: InstallContext): Promise<void>,
 *
 *   // ---- File manifests ----
 *   getHookFiles(): {src: string, dest: string}[],     // hook scripts to copy
 *   getSkillFiles(): {src: string, dest: string}[],    // SKILL.md files to copy
 *   getCommandFiles(): {src: string, dest: string}[],  // command files to copy
 *   getRuleFiles(): {src: string, dest: string}[],     // rule .md files to copy
 * }} Provider
 */
```

### Shared types

```js
/** @typedef {{
 *   sessionId: string,
 *   cwd: string,
 *   tmuxSession: string | null,
 *   providerId: string,
 *   raw: object,          // original stdin JSON from the IDE
 * }} HookContext
 */

/** @typedef {{
 *   status: 'ok' | 'error',
 *   message: string,
 *   url: string | null,
 *   sessionId: string | null,
 * }} HookResult
 */

/** @typedef {{
 *   dryRun: boolean,
 *   force: boolean,
 *   targetDir: string,
 *   port: number,
 *   configDir: string | null,
 *   provider: Provider,
 * }} InstallContext
 */
```

---

## 2. What Gets Extracted (Claude-specific → ClaudeProvider)

### 2.1 Files to create

| File | Purpose |
|------|---------|
| `src/providers/provider.js` | Interface definition (JSDoc types, constants) |
| `src/providers/claude.js` | ClaudeProvider — all Claude-specific logic extracted here |
| `src/providers/registry.js` | Loads provider by id, lists all available providers |

### 2.2 Files to modify

| File | Current (Claude-hardwired) | After (provider-agnostic) |
|------|---------------------------|---------------------------|
| `bin/install.js` | `PROVIDERS = [{id:'claude',...}]` only. Loop hardcodes `if claude`. Settings path hardcoded to `~/.claude`. | `PROVIDERS` populated from registry. Loop dispatches via `prov.install(ctx)`. Settings path via `provider.configDir()`. |
| `src/utils.js:10` | `CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR \|\| path.join(os.homedir(), '.claude')` | `getConfigDir(providerId)` — looks up provider, returns its config dir |
| `src/utils.js:12` | `SESSIONS_DIR` inside `~/.claude/.airprompt/` | `SESSIONS_DIR` = `~/.airprompt/sessions/`. Each session file prefixed: `{providerId}-{tmuxName}` |
| `src/hooks/airprompt-activate.js` | Hardcoded Claude stdin parsing, `CLAUDE_PLUGIN_ROOT` env var, `~/.claude` paths | Core logic extracted into `src/hooks/core/activate.js`. This file becomes a thin Claude wrapper (~20 lines) that parses stdin, calls core, formats stdout. Filename preserved for backward-compat with plugin.json + existing hook entries. |
| `src/hooks/airprompt-deactivate.js` | Same — Claude-specific stdin, env vars, paths | Same extraction pattern. |
| `bin/airprompt` | `CLAUDE_PLUGIN_ROOT` → `~/.airprompt` fallback | `AIRPROMPT_INSTALL_DIR` env var (set by installer). Fallback to `~/.airprompt`. No Claude reference. |
| `bin/airprompt-claude` | Hardcoded `~/.local/bin/claude`. Only Claude. | Rename to `bin/airprompt-launch`. Accepts `--provider <id>` flag. Claude is one of many. |
| `bin/lib/settings.js` | `claudeConfigDir()` only | `configDirFor(providerId)` — generic. `MANAGED_HOOK_BASENAMES` stays same (script names don't depend on IDE). |
| `.claude-plugin/plugin.json` | Only plugin manifest format | Stays. This IS the Claude-specific artifact — it's a data file, not code. Each provider gets its own plugin/extension manifest. |

### 2.3 What stays unchanged (conceptually generic — implementation still needs migration)

| File | Why | Notes |
|------|-----|-------|
| `server.js` | Session IDs are opaque strings. REST API + WS protocol are IDE-agnostic. | **Must still change**: `recoverSessionsFromDisk()` reads old `~/.claude/.airprompt/sessions` path. `sessionToJSON()` keys by sanitized tmux name, needs provider-prefix awareness. certs/`daemon.json`/`project-names.json` also live under old `~/.claude/.airprompt/` and need a new home. Covered in Stage 6b. |
| `public/index.html` + `public/client.js` | Mobile UI. Completely IDE-agnostic. | No changes needed. `grep` for `claude` across `public/` confirms zero hits. |
| `public/notify.js`, `public/keybar.js` | Same — pure web UI. | No changes needed. |
| WebSocket protocol | No IDE references. | No changes needed. |
| REST API endpoints | `/api/sessions/register`, `/api/sessions/unregister`, etc. — no IDE coupling. | No changes needed. |
| `bin/airprompt-on.sh`, `bin/airprompt-off.sh`, etc. | Shell scripts are tmux/session-based, not IDE-based. | **Currently do NOT accept `--provider`** — that flag is added in Stage 7. Internal session logic stays same; only config-dir resolution changes. |
| `Makefile` | Dev workflow. | **Must change**: `clean` target removes old `~/.claude/.airprompt/` path. `lint` names pre-rename hook files. Covered in Stage 10. |
| Test suite | Test logic is valid. | **Must update**: `server.test.js` sets old `CLAUDE_CONFIG_DIR` and session paths. `statusline.test.sh` installs to old hooks dir. `integration/run.sh` bakes current layout. Covered in Stage 11. |

---

## 3. Architecture: How the Adapter Pattern Works

### 3.1 Hook execution flow (SessionStart example)

```
IDE fires SessionStart hook
        │
        ▼
┌──────────────────────────────────────────┐
│  src/hooks/airprompt-activate.js         │  ← thin Claude wrapper (~20 lines)
│                                          │
│  1. Read stdin (Claude format)           │
│  2. provider.parseHookStdin(stdin)       │
│  3. Call core: activateSession(ctx)      │
│  4. provider.formatHookOutput(result)    │
│  5. Write stdout (Claude format)         │
└──────────────┬───────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────┐
│  src/hooks/core/activate.js              │  ← shared core logic (~200 lines)
│                                          │
│  1. Ensure daemon running                │
│  2. Detect tmux session                  │
│  3. POST /api/sessions/register          │
│  4. Write per-session marker files       │
│  5. Return HookResult                    │
└──────────────────────────────────────────┘
```

The wrapper file is the only thing that changes per IDE. The core never changes.

### 3.2 Install flow

```
bin/install.js main()
        │
        │  for each provider in registry:
        ▼
┌──────────────────────────────────────────┐
│  provider.install(ctx)                   │  ← ClaudeProvider, CodexProvider, etc.
│                                          │
│  1. Clone/verify repo (shared)           │
│  2. npm install (shared)                 │
│  3. Generate TLS cert (shared)           │
│  4. provider-specific:                   │
│     - Claude: claude plugin install      │
│     - Codex: npx skills add -a codex     │
│     - Cursor: npx skills add -a cursor   │
│  5. Copy hook files to provider.hooksDir │
│  6. Wire settings.json (provider-specific│
│     hook entry format)                   │
│  7. Copy skill + command files           │
└──────────────────────────────────────────┘
```

### 3.3 Session directory layout

```
Before (Claude-only):
~/.claude/.airprompt/
  sessions/
    AirPrompt/            ← tmux session name
      active
      url
      session

After (multi-IDE):
~/.airprompt/
  sessions/
    claude-AirPrompt/     ← provider prefix + tmux session name
      active
      url
      session
    codex-dev-work/
      active
      url
      session
    cursor-myproject/
      active
      url
      session
```

Daemon reads `~/.airprompt/sessions/` — no IDE awareness needed. Session ID format:
`{providerId}-{tmuxSessionName}`.

---

## 4. Implementation Stages

### Stage 1: Define Provider Interface (`src/providers/provider.js`)

- Write JSDoc type definitions for `Provider`, `HookContext`, `HookResult`, `InstallContext`
- Define utility: `resolveInstallDir()` (from `AIRPROMPT_INSTALL_DIR` env var or `~/.airprompt`)
- Define utility: `sessionsRootDir()` → `~/.airprompt/sessions/`
- Define utility: `sessionDir(providerId, sessionName)` → `~/.airprompt/sessions/{providerId}-{sessionName}/`

**Files**: `src/providers/provider.js` (new, ~40 lines)

### Stage 2: Implement ClaudeProvider (`src/providers/claude.js`)

Extract ALL Claude-specific logic from existing files into one adapter:

- `configDir()` → `CLAUDE_CONFIG_DIR \|\| ~/.claude`
- `hooksDir()` → `{configDir}/hooks`
- `skillsDir()` → `{configDir}/skills`
- `commandsDir()` → `{configDir}/commands`
- `rulesDir()` → `null` (Claude doesn't use `.cursor/rules/` pattern)
- `hookEvents` → `{ sessionStart: 'SessionStart', stop: 'Stop', statusLine: 'StatusLine' }`
- `commandPrefix` → `'/'`
- `parseHookStdin(input)` → parse Claude's hook stdin format
- `formatHookOutput(output)` → JSON.stringify (Claude reads stdout as JSON)
- `buildHookEntry(event, script)` → `{ hooks: [{ type: 'command', command: 'node ...', timeout: 10 }] }`
- `install(ctx)` → current `installClaude()` logic moved here
- `uninstall(ctx)` → current `uninstall()` Claude-specific parts moved here
- `getHookFiles()` → manifest of hook scripts to copy
- `getSkillFiles()` → manifest of skill files to copy
- `getCommandFiles()` → manifest of command files to copy

**Files**: `src/providers/claude.js` (new, ~150 lines). Existing code in `bin/install.js`,
`src/utils.js`, `src/hooks/` gets the Claude-specific parts removed.

### Stage 3: Create Provider Registry (`src/providers/registry.js`)

- `loadProvider(id)` → returns `Provider` instance or throws
- `listProviders()` → returns array of all available provider ids
- `detectInstalledProviders()` → runs `detectMatch()` against each provider's `detect` string
- `defaultProvider()` → first detected, or `'claude'` as fallback

**Files**: `src/providers/registry.js` (new, ~30 lines)

### Stage 4: Extract Hook Core Logic

Split `airprompt-activate.js` and `airprompt-deactivate.js`. The existing files BECOME
the Claude wrappers (preserving backward-compat with plugin.json paths). The core logic
is extracted into shared modules.

```
Before:
src/hooks/airprompt-activate.js    (316 lines, Claude-hardwired)
src/hooks/airprompt-deactivate.js  (285 lines, Claude-hardwired)

After:
src/hooks/airprompt-activate.js    ← BECOMES thin Claude wrapper (~20 lines, delegates to core)
src/hooks/airprompt-deactivate.js  ← BECOMES thin Claude wrapper (~20 lines)
src/hooks/core/activate.js         ← shared core (~200 lines, extracted from original)
src/hooks/core/deactivate.js       ← shared core (~180 lines, extracted from original)
```

This preserves backward compatibility: `.claude-plugin/plugin.json` and existing
`settings.json` hook entries still point at `airprompt-activate.js` / `airprompt-deactivate.js`
— those files still exist, they're just thin wrappers now.

Future IDEs get their own wrappers at `src/hooks/codex/activate.js`, `src/hooks/cursor/activate.js`,
etc. — each is a new file, never touching the Claude wrappers.

The wrapper (airprompt-activate.js becomes this):
```js
#!/usr/bin/env node
const provider = require('../providers/claude.js');
const { activateSession } = require('./core/activate.js');

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const ctx = provider.parseHookStdin(Buffer.concat(chunks).toString());
  const result = await activateSession({ ...ctx, provider });
  process.stdout.write(provider.formatHookOutput(result));
  process.exit(result.status === 'ok' ? 0 : 1);
}
main();
```

**Files**: `src/hooks/core/activate.js`, `src/hooks/core/deactivate.js` (new).
`src/hooks/airprompt-activate.js`, `src/hooks/airprompt-deactivate.js` (rewritten as thin wrappers).
`src/hooks/package.json` (new, `{}` — was planned but never created).

### Stage 5: Migrate `bin/install.js` to Provider Dispatch

- Replace hardcoded `PROVIDERS` array with `registry.listProviders()`
- Replace `if (prov.id === 'claude')` with `await prov.install(ctx)`
- Replace `claudeConfigDir()` with `provider.configDir()`
- Replace hardcoded `~/.claude/hooks/` with `provider.hooksDir()`
- Port `installViaSkills()` from caveman (generic `npx skills add` installer)
- Add `--provider <id>` flag alongside existing `--only <id>`

**Files**: `bin/install.js` (modified extensively)

### Stage 6: Migrate `src/utils.js` and `bin/lib/settings.js`

- `src/utils.js`: Replace `CLAUDE_CONFIG_DIR` with `getConfigDir(providerId)`. Replace
  hardcoded sessions dir with `~/.airprompt/sessions/{providerId}-{name}`.
- `src/utils.js`: Update `sessionToJSON()` to accept `providerId` parameter and prefix
  tmux session names with `{providerId}-` when building session dirs.
- `bin/lib/settings.js`: Replace `claudeConfigDir()` with `configDirFor(providerId)`.
  Rename `claudeConfigDir`
  Add `settingsPath(provider)` → renamed to `hooksConfigPath(provider)` — resolves
  `{configDir}/settings.json` (Claude) or `{configDir}/hooks.json` (Codex/Cursor) per provider.

**Files**: `src/utils.js`, `bin/lib/settings.js` (modified)

### Stage 6b: Migrate `server.js` + Daemon State Files

`server.js` is conceptually IDE-agnostic (session IDs are opaque strings) but its
implementation has hardcoded paths that must change when sessions move.

- `server.js`: Update `recoverSessionsFromDisk()` to read from `~/.airprompt/sessions/`
  instead of `{CLAUDE_CONFIG_DIR}/.airprompt/sessions`.
- `server.js`: Move `daemon.json`, TLS certs, and `project-names.json` from
  `~/.claude/.airprompt/` to `~/.airprompt/state/`. The daemon has zero IDE awareness —
  it just reads a configurable state dir.
- Add `AIRPROMPT_STATE_DIR` env var (default: `~/.airprompt/state/`) for daemon state.
  `~/.airprompt/` remains the install dir. State is separate: `~/.airprompt/state/` contains
  `daemon.json`, `certs/`, `project-names.json`. Uninstall leaves `~/.airprompt/state/`
  alone (user data) but removes `~/.airprompt/` code dir.
- `bin/lib/protocol.sh`: Update daemon.json/cert discovery to use `AIRPROMPT_STATE_DIR`
  instead of `CLAUDE_CONFIG_DIR/.airprompt/`.
- `server.js:168-181`: Fix session dedup logic — currently **overwrites** same-tmux
  sessions (`sessions.delete(existingId)`). After fix: allow multiple sessions per tmux
  when they have different `providerId` prefixes.

**Files**: `server.js`, `bin/lib/protocol.sh` (modified)

### Stage 7: Migrate Shell Scripts

All 11 shell scripts in `bin/` must be audited and migrated:

**Core dispatcher + sub-commands (already listed in plan):**
- `bin/airprompt` dispatcher: replace `CLAUDE_PLUGIN_ROOT` fallback with
  `AIRPROMPT_INSTALL_DIR` env var. Add `--provider` passthrough to sub-scripts.
- `bin/airprompt-on.sh`: accept `--provider <id>` flag. Use provider-aware session naming
  (`{providerId}-{tmuxName}`).
- Same for `off.sh`, `status.sh`, `clean.sh`, `restart.sh`, `name.sh`.

**Launcher:**
- `bin/airprompt-claude`: rename to `bin/airprompt-launch`. Add `--provider <id>` flag.
  Accept `--binary <path>` to override the IDE binary (was hardcoded `~/.local/bin/claude`).
  Keep backward-compat symlink `airprompt-claude` → `airprompt-launch --provider claude`.
  Document that non-tmux/GUI IDEs (Cursor desktop app) cannot use this launcher — it requires
  tmux for terminal capture. Those IDEs use hook-based daemon management instead.

**Previously omitted scripts:**
- `bin/airprompt-autostart.sh`: Hardcodes `~/.claude/settings.json`, hook paths, and a
  duplicate `MANAGED_HOOK_BASENAMES` list. Replace with provider-aware config dir and
  delegate to `bin/lib/settings.js` for managed hook basenames (single source of truth).
- `bin/airprompt-attach.sh`: Hunts Claude PID via `pgrep`, sends `claude` command to
  tmux. Generalize: accept `--provider <id>`, use provider's `processName` + `attachCommand`.

**Files**: `bin/airprompt`, `bin/airprompt-claude`, `bin/airprompt-on.sh`,
`bin/airprompt-off.sh`, `bin/airprompt-status.sh`, `bin/airprompt-clean.sh`,
`bin/airprompt-restart.sh`, `bin/airprompt-name.sh`, `bin/airprompt-autostart.sh`,
`bin/airprompt-attach.sh` (all modified)

### Stage 7b: Fix Standalone Hook Module Resolution

The current hooks are single-file scripts — when copied to `~/.claude/hooks/`, they work
because they have no internal `require()` dependencies. After Stage 4 extracts core logic
into `src/hooks/core/` + per-provider wrappers under `src/hooks/{provider}/`, the wrappers
use relative `require('../core/activate.js')` + `require('../../providers/claude.js')`.
These break when a single wrapper file is copied standalone to `{configDir}/hooks/`.

**Decision**: Hooks installed via **plugin manifest** use `${CLAUDE_PLUGIN_ROOT}` paths
pointing into the full `src/` tree — they work with no changes. Hooks installed
**standalone** (non-plugin, for IDEs without plugin systems) need a different strategy.

**Strategy for standalone installs**:
- Option A: Copy the full `src/` tree (hooks + providers + core) into `{configDir}/hooks/airprompt/`.
  Wrappers point at the copied tree. Installer copies `src/hooks/` + `src/providers/` wholesale.
- Option B: Bake absolute install-dir paths at install time. Wrapper `require()` paths are
  rewritten by the installer to point at `~/.airprompt/src/`.
- **Choose Option B** — simpler, single source of truth, no stale copies. Installer
  generates thin wrapper files with absolute paths on the fly from templates.

**Files**: `bin/install.js` (installHookFiles updated), `src/hooks/claude/` wrappers
become templates with `{{INSTALL_DIR}}` placeholder (resolved at install time).

### Stage 7c: Generalize `sync-claude` → `airprompt-sync-agent`

- `skills/sync-claude/sync.sh`: Hardcoded `$HOME/.claude/plugins/cache/`, old hook
  basenames, and `BINS` list (includes `airprompt-claude`). Generalize to iterate over
  installed providers, sync to each provider's plugin cache + hooks dir.
- Rename skill dir: `.claude/skills/sync-claude/` → `skills/airprompt-sync-agent/`.
  (The `.claude/` prefix was Claude-specific; the skill itself is generic after refactoring.)
- Add `airprompt-sync-agent` to the installer's skill file manifest.

**Files**: `skills/sync-claude/sync.sh` → `skills/airprompt-sync-agent/sync.sh` (renamed, modified),
`skills/airprompt-sync-agent/SKILL.md` (new)

### Stage 8: Migrate Marker Files (backward-compat)

- On first run after refactoring, check if `~/.claude/.airprompt/sessions/` exists with
  active sessions
- Migrate to `~/.airprompt/sessions/claude-{name}/`
- Remove old dir after migration
- This is one-time migration code — can be removed after a few releases

**Files**: `src/hooks/core/activate.js` (migration logic in session setup)

### Stage 9: Remove Backward-Compat Migration Code

Once Stage 8 migration has run (old `~/.claude/.airprompt/sessions/` → new
`~/.airprompt/sessions/claude-*`), the migration logic itself becomes dead code. Since
AirPrompt currently has a single user (the author), there is no need to keep backward-compat
across releases.

- Delete the migration block from `src/hooks/core/activate.js`
- Remove any `fs.existsSync(...)` checks for the old `~/.claude/.airprompt/` path
- Remove references to the old path from comments and error messages
- Verify no other file references the old `~/.claude/.airprompt/` path

**Files**: `src/hooks/core/activate.js` (remove migration block, ~15 lines deleted)

### Stage 10: Update Installer Files

- `install.sh`: update comments (Claude → multi-IDE), no logic changes
- `install.ps1`: same
- `.claude-plugin/plugin.json`: **stays — no changes needed.** Hook command paths
  (`${CLAUDE_PLUGIN_ROOT}/src/hooks/airprompt-activate.js` and
  `${CLAUDE_PLUGIN_ROOT}/src/hooks/airprompt-deactivate.js`) remain valid because
  Stage 4 preserves those files as Claude wrappers (they become thin wrappers delegating
  to the shared core).
- `.claude-plugin/marketplace.json`: update description to mention multi-IDE support

### Stage 11: Test & Document

- `test/unit/provider-claude.test.js`: ClaudeProvider unit tests
- `test/unit/provider-interface.test.js`: verify all providers satisfy the interface contract
- `test/unit/installer.test.js`: arg parsing, provider dispatch, detection (was planned, never created)
- Update `README.md`: document multi-IDE install paths
- Update `.claude/skills/airprompt.md` + `commands/airprompt.md`: document `--provider` flag

---

## 5. Design Principles

### 5.1 Base code never mentions IDE names

Bad:
```js
if (process.env.CLAUDE_CONFIG_DIR) { ... }
const configDir = path.join(os.homedir(), '.claude');
```

Good:
```js
const configDir = provider.configDir();
```

### 5.2 Provider files are data + thin wrappers

A provider file should have:
- Config paths (data)
- Hook format parsers (thin wrappers — 10-20 lines each)
- Install/uninstall logic (orchestration, delegating to shared helpers)

It should NOT have:
- Core business logic (session registration, daemon management)
- Duplicated code from other providers
- tmux-specific logic (that's shared)

### 5.3 New provider = new file, zero base changes

Adding Codex support should mean:
1. Create `src/providers/codex.js` (implements Provider interface)
2. Create `src/hooks/codex/activate.js` + `deactivate.js` (thin wrappers)
3. Create `.codex-plugin/plugin.json` (if applicable)
4. Done. Provider auto-discovered by registry — no changes to `server.js`, `public/`, core hooks, shell scripts, or `bin/install.js`.

(The registry auto-discovers providers from `src/providers/` directory. No manual `PROVIDERS` row editing.)

### 5.4 Backward compatibility

- Existing Claude Code users must not break
- Old `~/.claude/.airprompt/` markers auto-migrated on first run after refactoring (Stage 8)
- Migration code stays for at least one release cycle to ensure all active sessions are migrated
- Stage 9 (removal of migration code) ships in a **subsequent release** — NOT the same release as Stage 8
- `~/bin/airprompt-claude` symlink keeps working (defaults to provider `claude`)
- `/airprompt on` without `--provider` uses auto-detection or defaults to `claude`

---

## 6. Key Risks

| Risk | Mitigation |
|------|-----------|
| tmux session name collision across IDEs | Prefix with `{providerId}-` in session dir. For CLI-launched IDEs: `bin/airprompt-launch --provider X` creates tmux session `{providerId}-{name}` automatically. For GUI IDEs (Cursor, Windsurf): they don't use tmux — hooks manage daemon lifecycle directly, no tmux naming involved. |
| Same tmux session used by multiple IDEs simultaneously | Each IDE registers separately via different `providerId` prefix. `server.js` session dedup fixed (Stage 6b): multiple sessions per tmux allowed when `providerId` differs. |
| Plugin cache dirs get out of sync | `airprompt-sync-agent` skill (Stage 7c) handles this across all installed providers. |
| Hook format changes in IDE updates | Provider adapter isolates the change — only one small file to update. |
| npm deps not available in all IDE environments | `npm install` runs once at install time. Hook scripts use Node stdlib only. |
| Daemon state mixed with install dir | `~/.airprompt/state/` (daemon.json, certs, project-names.json) separated from `~/.airprompt/` (code). `rm -rf ~/.airprompt` (reinstall) won't destroy session data. Uninstall leaves `state/` alone by default. |
| `airprompt-launch` doesn't work for GUI IDEs | Documented limitation. GUI IDEs (Cursor desktop app, Windsurf) don't run inside tmux — they use hook-based daemon management only (SessionStart → activate, Stop → deactivate). No terminal capture feature for those IDEs (terminal capture requires tmux). |
| Stage 8/9: migration removed too early | Stage 9 ships in a **subsequent release**, not the same release as Stage 8. Ensures all active sessions from the old layout are migrated before code is deleted. |

---

## 7. Stage Notes

Stages 2-4 are the bulk of the work. Stages 5-7c are mechanical but numerous.
Stage 9 ships in a **subsequent release** (not same as Stage 8) to honor backward-compat.

---

## 8. Future: Adding Codex (after agnostic refactor)

Once the refactoring is done, adding Codex is fast:

1. **Create `src/providers/codex.js`** (~150 lines)
   - `configDir()` → `~/.codex`
   - `hooksConfigPath()` → `{configDir}/hooks.json`
   - `detectMatch(spec)` → handles `command:`, `dir:`, etc. (shared base + Codex-specific overrides)
   - `parseHookStdin()` → snake_case JSON → HookContext
   - `formatHookOutput()` → HookResult → `{hookSpecificOutput: {...}}`
   - `buildHookEntry()` → Codex-format hook JSON entry
   - `buildStatusLineEntry()` → `null` (Codex has no StatusLine equivalent — uses `Notification` event instead)
   - `install()` → `npx skills add -a codex` + config templates
   - `uninstall()` → remove skills + hooks

2. **Create `src/hooks/codex/activate.js`** (template, ~20 lines)
   - Resolved at install time with `{{INSTALL_DIR}}` → absolute path to providers + core
   - Thin wrapper: `codex.parseHookStdin()` + `core.activateSession()` + `codex.formatHookOutput()`

3. **Create `src/hooks/codex/deactivate.js`** (template, ~20 lines)

4. **Create `.codex/hooks.json` template** (data file)

5. **Create `.codex/config.toml` template** (data file: `[features] hooks = true`)

6. **Create `SKILL.md` with `$airprompt` prefix** (data file — Codex uses `$` not `/`)

Registry auto-discovers `src/providers/codex.js`. Installer picks it up with zero changes.

---

## Proposed PR Description

### Summary

Refactors AirPrompt from Claude-Code-only to IDE/CLI-agnostic. Every Claude-specific
assumption (`~/.claude`, `CLAUDE_CONFIG_DIR`, `CLAUDE_PLUGIN_ROOT`, hardcoded
`claude` binary path) is extracted into a `ClaudeProvider` adapter that implements
a shared `Provider` interface. Base code (`server.js`, hook core logic, shell
scripts, installer) becomes provider-agnostic — it calls `provider.configDir()`,
`provider.parseHookStdin()`, `provider.install()`, etc. without knowing which IDE
is running.

**Claude Code is the first milestone and the proof that the refactoring is correct.**
After this PR, Claude works **identically to today** — same hooks, same daemon,
same mobile UI, same plugin install path. If Claude passes all existing tests and
behaves exactly as before, the abstraction is validated.

After Claude is stable, the remaining IDEs/CLIs ship in follow-up PRs — each is
one new provider file + thin hook wrappers, auto-discovered by the registry. Zero
changes to core logic.

### Tasks

- [ ] Stage 1 — Define `Provider` adapter interface + shared types (`src/providers/provider.js`)
- [ ] Stage 2 — Implement `ClaudeProvider`: extract all Claude-specific logic (`src/providers/claude.js`)
- [ ] Stage 3 — Create provider registry: load, list, detect, default (`src/providers/registry.js`)
- [ ] Stage 4 — Extract hook core logic: `src/hooks/core/activate.js` + `deactivate.js`. Existing files become thin Claude wrappers (preserved for backward-compat with plugin.json)
- [ ] Stage 5 — Migrate `bin/install.js` to provider dispatch + port `installViaSkills()` from caveman
- [ ] Stage 6 — Migrate `src/utils.js` + `bin/lib/settings.js` to provider-agnostic paths
- [ ] Stage 6b — Migrate `server.js` + daemon state files. Fix session dedup for multiple providers on same tmux. Separate state dir (`~/.airprompt/state/`) from install dir
- [ ] Stage 7 — Migrate all 11 shell scripts: add `--provider` flag, rename `airprompt-claude` → `airprompt-launch`, generalize `autostart.sh` + `attach.sh`
- [ ] Stage 7b — Fix standalone hook module resolution: template-based with `{{INSTALL_DIR}}` placeholders resolved at install time
- [ ] Stage 7c — Generalize `sync-claude` → `airprompt-sync-agent` skill
- [ ] Stage 8 — Migrate marker files: `~/.claude/.airprompt/sessions/` → `~/.airprompt/sessions/claude-{name}/`
- [ ] Stage 9 — Remove backward-compat migration code (ships in subsequent release)
- [ ] Stage 10 — Update installer files + plugin manifest
- [ ] Stage 11 — Add provider tests, update existing tests for new paths, update README + skill docs

### Notes / Out of Scope

- **tmux stays mandatory** — daemon won't run without it. Windows not supported.
- **No new IDE providers in this PR** — this is the foundation refactoring only.
  Codex, Cursor, and Windsurf providers ship in follow-up PRs (each ~1 new file +
  hook wrappers).
- **Stage 9 (remove migration code) ships separately** — keeps backward-compat
  for one release cycle.
- **Backward-compatible**: existing Claude Code users are unaffected. Plugin.json
  paths stay valid (hook files preserved as thin wrappers). `~/bin/airprompt-claude`
  symlink keeps working. Old markers auto-migrated on first run.
- **No changes to `public/` (mobile UI)** — already IDE-agnostic (verified: zero
  Claude references in client.js, index.html, notify.js, keybar.js).
- **No changes to REST API or WebSocket protocol** — session IDs are opaque strings,
  protocol is IDE-agnostic.
- **GUI IDEs (Cursor desktop, Windsurf)**: no terminal capture via `airprompt-launch`
  (requires tmux). They use hook-based daemon management only (SessionStart → activate,
  Stop → deactivate).
- **Gemini CLI** — not included; needs further investigation (no SessionStart hook
  equivalent as of last check). May be discarded.
