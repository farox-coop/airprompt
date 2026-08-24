# REPORT — AirPrompt Multi-IDE Feasibility

## 1. Current State: Claude Code Only

AirPrompt's installer (`bin/install.js:36-38`) defines exactly **one provider**:

```js
const PROVIDERS = [
  { id: 'claude', label: 'Claude Code', mech: 'claude plugin install', detect: 'command:claude' },
];
```

Provider loop at `bin/install.js:732` hardcodes `if (prov.id === 'claude')` — no dispatch table.
Every layer assumes Claude:

| Layer                                | Claude-only path                           |
| ------------------------------------ | ------------------------------------------ |
| `bin/lib/settings.js:274`            | `claudeConfigDir()` only knows `~/.claude` |
| `src/hooks/airprompt-activate.js:30` | `CLAUDE_PLUGIN_ROOT` env var               |
| `src/utils.js:10`                    | `CLAUDE_CONFIG_DIR \|\| ~/.claude`         |
| `.claude-plugin/plugin.json`         | Claude Code manifest format                |
| `bin/airprompt-claude:20`            | hardcoded `~/.local/bin/claude` binary     |

The extensible `PROVIDERS` matrix and `--only`/`--list` plumbing from caveman survive intact — the
infrastructure for multi-IDE exists, just gutted to one entry. Adding providers means filling rows,
not building new scaffolding.

---

## 2. What Caveman Does (Reference Implementation)

Caveman supports **36 agents** through **5 install mechanisms**:

| Mechanism                     | Agents                                               | How it works                                 |
| ----------------------------- | ---------------------------------------------------- | -------------------------------------------- |
| `claude plugin install`       | Claude Code                                          | Plugin manifest + settings.json hooks        |
| `gemini extensions install`   | Gemini CLI                                           | Extension manifest + GEMINI.md context       |
| Native plugin copy            | OpenCode, Hermes, OpenClaw                           | Copy files into agent config dirs            |
| `npx skills add -a <profile>` | Codex, Cursor, Windsurf, Cline, Copilot, + 25 others | Vercel Skills CLI distributes SKILL.md files |
| Soft probe (`--only`)         | Junie, Qoder, Antigravity                            | Manual opt-in, no auto-detect                |

Caveman is **pure text injection** — it installs skill files that change how the agent writes prose.
Zero runtime dependencies, zero daemon, zero network ports. This is the fundamental difference from
AirPrompt.

---

## 3. AirPrompt's Unique Challenge: The Daemon

AirPrompt is NOT pure text injection. It requires:

- **A running daemon** (`server.js` — Express + WebSocket on port 3210)
- **tmux** for terminal capture/sharing
- **node-pty** for PTY allocation
- **Per-session state** (marker files, session registry)
- **Hook scripts that start/stop the daemon** and register sessions via REST API

Caveman's install is: copy files → done. AirPrompt's install is: clone repo → `npm install` →
generate TLS cert → start daemon → wire hooks that manage daemon lifecycle. Each IDE targeted needs
hooks that can launch and manage this daemon.

---

## 4. Per-IDE Feasibility Analysis

### Evaluation criteria

Each IDE is classified by effort level:

| Effort     | Meaning                                                                            | Decision                                                 |
| ---------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **Low**    | Mechanical — create provider file + config templates (auto-discovered by registry) | Will implement when ready                                |
| **Medium** | Hook format adaptation needed, but session lifecycle exists                        | Evaluate case-by-case at implementation time             |
| **High**   | Native plugin system, no session lifecycle, or fundamentally different model       | **DISCARDED** — kept as backlog for future re-evaluation |

---

### 4.1 Codex CLI — Feasible, MEDIUM effort

**Install path**: `npx skills add farox-coop/airprompt -a codex`

**Hook system**: `.codex/hooks.json` + `~/.codex/config.toml` (`[features] hooks = true`).
Events: `SessionStart`, `Stop`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`,
`PreCompact`, `SubagentStop`.

**What AirPrompt needs**:

| Component             | Status                | Notes                                                                                                                                                                                                                                                                            |
| --------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SKILL.md` files      | Need creation         | `.codex/skills/` or `.agents/skills/`. Codex strict parser: description ≤1024 chars, valid YAML frontmatter. Invocation: `$airprompt` (Codex uses `$` prefix, `/` reserved for built-ins)                                                                                        |
| Hook scripts          | Need adaptation       | Codex hooks receive **snake_case JSON on stdin** (different from Claude Code). Output must nest under `hookSpecificOutput`. Block/continue decisions are top-level. Strict schema — extra fields invalidate entire output. `airprompt-activate.js` must parse Codex-format stdin |
| Daemon lifecycle      | Works same            | SessionStart starts daemon, Stop unregisters. Same logic, different JSON wrapper                                                                                                                                                                                                 |
| StatusLine equivalent | `Notification` hook   | Codex has `Notification` event — could show AirPrompt URL there, but not a persistent statusline                                                                                                                                                                                 |
| tmux dependency       | Required (documented) | Codex runs on Windows too. Windows users get degraded experience: skills/commands install, daemon disabled. See section 5.1                                                                                                                                                      |
| Plugin packaging      | Optional but possible | `.codex-plugin/plugin.json` manifest. Codex plugin marketplace supports `codex plugin marketplace add` + `codex plugin install`                                                                                                                                                  |

**Verdict**: Feasible. Hook format adaptation is mechanical. Main difference: `$airprompt` command
syntax instead of `/airprompt`. **Will evaluate at implementation time** — case-by-case decision
whether to proceed.

---

### 4.2 Cursor — Feasible, MEDIUM effort

**Install path**: `npx skills add farox-coop/airprompt -a cursor`

**Hook system**: `.cursor/hooks.json` — 15+ events including `sessionStart`, `beforeShellExecution`,
`afterFileEdit`, `beforeSubmitPrompt`, `Stop`, `sessionIdle`. Broader than Claude Code's events.

**What AirPrompt needs**:

| Component                  | Status                | Notes                                                                                                                                                                                 |
| -------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SKILL.md` files           | Need creation         | `.cursor/skills/`. Auto-loaded when project opens. Invocation: `/airprompt`                                                                                                           |
| Hook scripts               | Need adaptation       | Cursor hook format: `{hookType: "onSave", filePattern: "**/*.ts", command: "..."}`. Different JSON schema than Claude Code. Need Cursor-specific stdin parsing in activate/deactivate |
| Rules                      | Need creation         | `.cursor/rules/airprompt.md` with YAML frontmatter (`description`, `globs`, `alwaysApply`). For always-on context injection                                                           |
| Commands                   | Need creation         | `.cursor/commands/airprompt.md` — markdown file invoked with `/`                                                                                                                      |
| Daemon lifecycle           | Works same            | SessionStart → activate, Stop → deactivate                                                                                                                                            |
| StatusLine equivalent      | None direct           | Cursor has no persistent statusline. Could use `sessionIdle` event or periodic notification                                                                                           |
| Cursor 3.9+ Customize page | Future path           | Plugin bundles can package rules + skills + hooks + commands as single installable unit. Team marketplaces support GitHub import                                                      |
| tmux dependency            | Required (documented) | Cursor runs on macOS/Linux/Windows. tmux is Unix-only                                                                                                                                 |

**Verdict**: Feasible. Cursor has richest hook system (more events than Claude Code). Plugin bundle
packaging in Cursor 3.9+ is clean distribution path. **Will evaluate at implementation time** —
case-by-case decision whether to proceed.

---

### 4.3 Windsurf — Feasible, MEDIUM-LOW effort

**Install path**: `npx skills add farox-coop/airprompt -a windsurf`

**Hook system**: Local/project-level hooks. `.windsurfrules` for project rules.
`.windsurf/skills/` for skills.

**What AirPrompt needs**:

| Component        | Status                | Notes                                                              |
| ---------------- | --------------------- | ------------------------------------------------------------------ |
| `SKILL.md` files | Need creation         | `.windsurf/skills/`. Cascade agent auto-discovers and activates    |
| Rules            | Need creation         | `.windsurfrules` or `.windsurf/rules/airprompt.md`                 |
| Hooks            | Need adaptation       | Windsurf local hooks. Format less documented but similar to Cursor |
| Commands         | Need creation         | `.windsurf/commands/`                                              |
| Daemon lifecycle | Works same            | Hook-driven start/stop                                             |
| tmux dependency  | Required (documented) | Unix-only                                                          |

**Verdict**: Feasible. Windsurf's Cascade agent has comparable capabilities to Claude Code. Less
hook documentation publicly available, but pattern is same. Lower priority than Codex/Cursor given
smaller user base. **Will evaluate at implementation time.**

---

### 4.4 Gemini CLI — Feasible, MEDIUM effort (needs further investigation)

**Install path**: `gemini extensions install https://github.com/farox-coop/airprompt`

**Hook system**: `.gemini/settings.json` — `BeforeTool`/`AfterTool` events with matchers. May need
`"experimental": { "hooks": true }`. Different from Claude Code — hooks are tool-interception
middleware, not session-lifecycle events.

**What AirPrompt needs**:

| Component          | Status          | Notes                                                                                                                                                                        |
| ------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extension manifest | Need creation   | `gemini-extension.json` — bundles MCP configs, GEMINI.md context, commands (.toml), skills, hooks                                                                            |
| `GEMINI.md`        | Need creation   | Persistent context file, analog to CLAUDE.md                                                                                                                                 |
| `SKILL.md` files   | Need creation   | `~/.gemini/skills/` or `.gemini/skills/`. Invocation: `/airprompt`                                                                                                           |
| Hook scripts       | Need adaptation | Gemini hooks are tool-level middleware, not session-lifecycle. No direct `SessionStart`/`Stop` equivalent for daemon management. May need `BeforeTool` matcher as workaround |
| Commands           | Need creation   | `.toml` format, not markdown                                                                                                                                                 |
| Daemon lifecycle   | **Problem**     | No SessionStart equivalent. Would need creative workaround: start daemon on first `BeforeTool` fire, clean up via `gemini extensions uninstall`                              |
| StatusLine         | None            | Gemini CLI has no statusline concept                                                                                                                                         |

**Verdict**: Feasible but awkward. Gemini CLI's hook model (tool middleware) doesn't map cleanly
to AirPrompt's session-lifecycle daemon management. **Needs deeper investigation** before committing:
research whether Gemini CLI has added session-lifecycle hooks since last check, or whether a
standalone daemon approach (daemon always running, independent of IDE session lifecycle) is viable.
If too complex, it will be **discarded** like OpenCode/Hermes.

---

### 4.5 OpenCode — DISCARDED (high effort, backlog)

**Install path**: Native plugin copy (like caveman's `installOpencode`). No `npx skills` shortcut.

**Hook system**: ESM/Bun native plugin with `session.created` + `tui.prompt.append` events.
Completely different from all others — requires JavaScript plugin file, not shell-command hooks.

**What AirPrompt would need**:

| Component        | Status                | Notes                                                                                                            |
| ---------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Plugin files     | Need creation         | `plugin.js`, `package.json` → `~/.config/opencode/plugins/airprompt/`. ESM/Bun format                            |
| Commands         | Need creation         | `~/.config/opencode/commands/`                                                                                   |
| Skills           | Need creation         | `~/.config/opencode/skills/`                                                                                     |
| Agents/AGENTS.md | Need creation         | OpenCode uses AGENTS.md for rules                                                                                |
| Daemon lifecycle | **Different model**   | `session.created` event for start, no direct Stop equivalent. OpenCode's plugin model is fundamentally different |
| tmux             | Required (documented) |                                                                                                                  |

**Reason for discard**: OpenCode's native plugin system (JavaScript ESM) is completely different from
shell-command hooks. Requires writing a full plugin, not just adapting existing hook scripts. Small
user base doesn't justify the effort. **Kept in backlog** — re-evaluate if OpenCode adoption grows
significantly or if the plugin system converges toward a standard.

---

### 4.6 Hermes — DISCARDED (high effort, backlog)

**Install path**: Native copy to `~/.hermes/skills/`. No hook system publicly documented.
Different install mechanism than all others. Small user base.

**Reason for discard**: Native copy mechanism + undocumented hook system + small user base.
**Kept in backlog.**

---

### 4.7 Other Agents (Cline, Copilot, Roo, etc.) — Low effort per agent, deferred

All 25+ agents using `npx skills add` share the same mechanism. Adding one means creating
a provider file in `src/providers/` (auto-discovered by the registry). The `installViaSkills()`
function handles the install generically. But:

- Each still needs hook format adaptation for daemon lifecycle
- Each has different config dir and hook event names
- Most are VS Code extensions — share VS Code's platform constraints

**Deferred** until core 4 providers (Claude + Codex + Cursor + Windsurf) are stable. Adding more
agents after that is mechanical.

---

## 5. Cross-Cutting Concerns

### 5.1 tmux Dependency — REQUIRED, Windows support deferred

AirPrompt's core feature (terminal capture/sharing) requires tmux. **This is non-negotiable for
the daemon to function.**

| Platform         | tmux available? | AirPrompt support                                                                          |
| ---------------- | --------------- | ------------------------------------------------------------------------------------------ |
| Linux            | Yes             | **Full support**                                                                           |
| macOS            | Yes (Homebrew)  | **Full support**                                                                           |
| Windows (native) | **No**          | **Not supported** — daemon disabled. Skills/commands install but are inert without daemon. |
| WSL              | Yes             | **Full support** (tested)                                                                  |
| Git Bash         | No (or limited) | **Not supported**                                                                          |

**Decision**: tmux stays. No ConPTY, no Windows terminal capture, no graceful degradation beyond
"daemon doesn't start on Windows." Future investigation (long-term backlog): evaluate replacing
tmux with a pure Node.js PTY solution (`node-pty` already handles PTY allocation — tmux is used
for session persistence and multiplexing, which could theoretically be replaced).

**Windows support**: Deferred indefinitely. Windows is not a priority platform for AirPrompt's
target audience (developers using terminal-based AI coding agents). The install script will detect
the platform and print a clear message: "AirPrompt daemon requires tmux (Unix/macOS/WSL only).
Windows detected — installing skills and commands only. Daemon will not run."

### 5.2 Hook Format Fragmentation

Each IDE has different hook JSON schema:

```
Claude Code:  {hooks: [{type: "command", command: "node script.js", timeout: 10}]}
Codex:        stdin snake_case JSON → stdout {hookSpecificOutput: {...}, decision: "block"|"continue"}
Cursor:       {hookType: "sessionStart", command: "node script.js"}
Gemini CLI:   {name: "...", type: "command", command: "..."} with matchers
OpenCode:     JavaScript plugin class with event handlers
```

Solution: **Provider adapter pattern** (see `docs/PLAN - IDE agnostic.md`). Each provider implements:

- `parseHookStdin(input)` → normalized common format
- `formatHookOutput(output)` → IDE-specific format
- `buildHookEntry(event, scriptPath, timeout)` → IDE-specific hook JSON entry

Core hook logic stays in one place. Per-IDE wrappers are thin (parse stdin, call core, format stdout).

### 5.3 Command Syntax Differences

| IDE         | Invocation                            |
| ----------- | ------------------------------------- |
| Claude Code | `/airprompt on`                       |
| Codex       | `$airprompt on` (or `/skills` picker) |
| Cursor      | `/airprompt on`                       |
| Windsurf    | `/airprompt on`                       |
| Gemini CLI  | `/airprompt on` (TOML command)        |

Need separate command files per IDE with correct syntax. The underlying shell scripts
(`bin/airprompt-on.sh`, etc.) can be shared. Command files are generated from templates
during install, with `commandPrefix` substituted per provider.

### 5.4 StatusLine / URL Display

Claude Code's StatusLine hook has no equivalent in other IDEs:

| IDE         | URL display mechanism                   |
| ----------- | --------------------------------------- |
| Claude Code | StatusLine hook — persistent badge      |
| Codex       | `Notification` hook — ephemeral         |
| Cursor      | None built-in. `sessionIdle` could work |
| Windsurf    | None                                    |
| Gemini CLI  | None                                    |

Multi-IDE means accepting that the persistent mobile URL badge is Claude Code-only. Other IDEs
would show URL once at session start (via SessionStart output) or on demand
(`/airprompt status`).

### 5.5 Per-Session Isolation

Current marker file scheme uses `~/.claude/.airprompt/sessions/{tmux-name}/`. Multi-IDE needs
either:

- Separate dirs per IDE: `~/.codex/.airprompt/sessions/`, `~/.cursor/.airprompt/sessions/`, etc.
- Unified dir with IDE prefix: `~/.airprompt/sessions/claude-{name}/`,
  `~/.airprompt/sessions/codex-{name}/`

Second option is cleaner — daemon only needs to know about one directory. Session ID includes
provider prefix to avoid collisions when same tmux session is used by multiple IDEs.

---

## 6. Implementation Roadmap

### Phase 1: Make AirPrompt IDE-agnostic (foundation)

See `docs/PLAN - IDE agnostic.md` for detailed 14-stage design. This phase extracts all
Claude-specific code into a `ClaudeProvider` adapter and makes the base code provider-agnostic.

1. Define `Provider` adapter interface + shared types
2. Implement `ClaudeProvider` as first adapter
3. Create provider registry (auto-discovers providers from `src/providers/`)
4. Extract hook core logic into shared modules; create per-IDE wrappers
5. Migrate `bin/install.js` to provider dispatch + port `installViaSkills()`
6. Migrate `src/utils.js`, `bin/lib/settings.js`, `server.js` to provider-agnostic paths
7. Migrate all 11 shell scripts + generalize `sync-claude` → `airprompt-sync-agent`
8. Migrate marker files to `~/.airprompt/sessions/{provider}-{name}/`
9. Update installer files + tests + documentation

### Phase 2: Codex Support

1. Create `src/providers/codex.js` (implements Provider interface — auto-discovered by registry)
2. Create `src/hooks/codex/activate.js` + `deactivate.js` (thin wrappers, ~20 lines each)
3. Create `.codex/hooks.json` template + per-session hook wiring
4. Create `SKILL.md` for `$airprompt` command (Codex uses `$` prefix)
5. Create `.codex/config.toml` template (`[features] hooks = true`)
6. Test daemon lifecycle: SessionStart → activate → Stop → deactivate

### Phase 3: Cursor Support

1. Create `src/providers/cursor.js` (implements Provider interface — auto-discovered by registry)
2. Create `.cursor/hooks.json` template + `src/hooks/cursor/` wrappers
3. Create `.cursor/rules/airprompt.md` for always-on context
4. Create `.cursor/skills/` and `.cursor/commands/` entries
5. Test

### Phase 4: Windsurf Support

1. Create `src/providers/windsurf.js` (auto-discovered by registry)
2. Create config templates + hook wrappers
3. Test

### Phase 5: Gemini CLI Investigation (research only)

1. Deep-dive into Gemini CLI hook documentation — check if session-lifecycle events were added
2. If yes: implement like other providers
3. If no: evaluate standalone-daemon approach
4. If still too complex: **discard** and document alongside OpenCode/Hermes

### Backlog (deferred, no timeline)

- OpenCode support (discarded — high effort, small user base)
- Hermes support (discarded — no hook system, small user base)
- Cline, Copilot, Roo, + 25 other agents (deferred — add after core providers stable)
- Windows native support (deferred — requires tmux replacement)
- tmux replacement research (deferred — long-term, low priority)

---

## 7. What Caveman Does That AirPrompt Cannot Easily Replicate

| Caveman feature                               | AirPrompt equivalent                    | Feasibility                         |
| --------------------------------------------- | --------------------------------------- | ----------------------------------- |
| Pure text injection, zero deps                | Daemon + npm deps                       | Fundamental architecture difference |
| Works on all platforms identically            | tmux = Unix-only                        | Windows not supported               |
| Install in ~30 seconds                        | Clone + npm install + cert gen = slower | Acceptable — one-time cost          |
| `--with-init` drops always-on rules into repo | Could do same for skills/commands       | Straightforward                     |
| Soft probe for agents without CLI             | Same mechanism available                | Trivial — already in code           |
| SHA-256 manifest verification of hook files   | Not implemented, could add              | Low effort                          |

---

## 8. Decisions Made

| Decision                             | Rationale                                                                                                               |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| **tmux is REQUIRED**                 | Core feature (terminal capture/sharing). No replacement planned short-term.                                             |
| **Windows support: DEFERRED**        | tmux-dependent. Not a priority platform. Install script warns, installs skills only.                                    |
| **OpenCode: DISCARDED**              | High effort (native ESM plugin system), small user base. Kept in backlog.                                               |
| **Hermes: DISCARDED**                | Native copy mechanism, undocumented hooks, small user base. Kept in backlog.                                            |
| **Gemini CLI: NEEDS INVESTIGATION**  | No SessionStart equivalent found. Research more before deciding. Risk of discard if too complex.                        |
| **Medium-effort IDEs: CASE-BY-CASE** | Codex, Cursor, Windsurf evaluated individually at implementation time. May discard any that prove unexpectedly complex. |
| **Other 25+ agents: DEFERRED**       | Add after core providers (Claude + Codex + Cursor + Windsurf) are stable.                                               |

---

## 9. Bottom Line

**AirPrompt can work in Codex, Cursor, and Windsurf.** The `PROVIDERS` matrix and installer
infrastructure from caveman are intact. After the IDE-agnostic refactoring,
adding Codex, Cursor, and Windsurf is purely additive — the provider adapter pattern makes
new IDE support a matter of one new provider file + thin hook wrappers + config templates.

**Real constraints:**

1. **tmux is mandatory** — daemon won't run without it. Documented and accepted. No Windows.
2. **Hook format fragmentation** — solved with provider adapter pattern (see
   `docs/PLAN - IDE agnostic.md`). Each IDE gets a thin wrapper; core logic stays shared.
3. **Gemini CLI has no SessionStart** — needs deeper investigation. May be discarded.
4. **OpenCode + Hermes discarded** — high effort, small user base. Backlog only.

**Priority order**: IDE-agnostic refactor → Codex → Cursor →
Windsurf → Gemini CLI (investigate first). Codex + Cursor cover ~90% of
non-Claude AI coding agent users.

---

## Sources

- [Caveman install.js PROVIDERS matrix](https://github.com/JuliusBrussee/caveman/blob/main/cli/install.js)
- [Caveman settings.js library](https://github.com/JuliusBrussee/caveman/blob/main/cli/lib/settings.js)
- [Caveman INSTALL.md](https://github.com/JuliusBrussee/caveman/blob/main/INSTALL.md)
- [Codex CLI hooks documentation](https://github.com/OthmanAdi/planning-with-files/blob/master/docs/codex.md)
- [Cursor hooks + Customize page](https://cursor.com/docs/customize-cursor.md)
- [Gemini CLI extensions overview](https://geminicli.com/docs/extensions/writing-extensions/)
- [Gemini CLI hooks + agent skills discussion](https://github.com/google-gemini/gemini-cli/discussions/17790)
- [Vercel Skills CLI — npx skills add](https://vercel.com/changelog/introducing-skills-the-open-agent-skills-ecosystem)
- [Windsurf agent-config compatibility matrix](https://docs.rs/crate/agent-config/latest)
