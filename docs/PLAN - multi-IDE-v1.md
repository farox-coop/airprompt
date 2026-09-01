# PLAN — multi-IDE v1 (codex / cursor / windsurf)

> Derived from `REPORT - multi-IDE feasibility.md` + fresh provider research (August 2026). Predecessor plan: `PLAN - open readiness.md` Stage 3.3.
> **Status: implemented.**

## Scope & constraints

- One big commit. Direct push to `main`. No PR, no per-provider staging.
- Predominantly `add` — three new provider files (`src/providers/codex.js`, `cursor.js`, `windsurf.js`) plus template assets. A small number of shared-infrastructure edits (see "Shared changes") are unavoidable.
- Re-advertise each provider only where its adapter actually lands (reverse of Stage 1.4).

## Bottom line

- The IDE-agnostic core is done and tested. `provider.js` interface + `registry.js` auto-discovery + provider-agnostic hook core (`core/activate.js`, `core/deactivate.js`, `core/shared.js`) already exist. Adding a provider = dropping a file; the contract test `test/unit/provider-interface.test.js` validates it automatically.
- **Codex and Cursor have real session-lifecycle hooks** (`SessionStart`/`Stop` and `sessionStart`/`sessionEnd`). The daemon-lifecycle model maps cleanly. These two are safe to ship.
- **Windsurf has no session-end hook** (only `on-open` for start). It ships as normal support, with one minor accepted caveat: the daemon is not auto-stopped on session close (see Windsurf section).

---

## Provider differences at a glance

| Dimension            | Claude (reference)      | Codex                                                         | Cursor            | Windsurf                                   |
| -------------------- | ----------------------- | ------------------------------------------------------------- | ----------------- | ------------------------------------------ |
| Config dir           | `~/.claude`             | `$CODEX_HOME` → `~/.codex` (legacy) → `~/.config/codex` (XDG) | `~/.cursor`       | `~/.codeium/windsurf`                      |
| Hook config file     | `settings.json`         | `hooks.json` + `config.toml`                                  | `hooks.json`      | `hooks.json` (or `.windsurf/cascade.json`) |
| Session-start event  | `SessionStart`          | `SessionStart`                                                | `sessionStart`    | **none** (`on-open` is closest)            |
| Session-end event    | `Stop`                  | `Stop`                                                        | `sessionEnd`      | **none**                                   |
| stdin key style      | camelCase               | **snake_case**                                                | camelCase         | —                                          |
| stdout for lifecycle | JSON / plain            | SessionStart plain=context, **Stop JSON-only**                | JSON              | —                                          |
| Statusline           | `StatusLine` hook       | none (ephemeral `Notification`)                               | none              | none                                       |
| Command prefix       | `/`                     | `$` (skills only; **no custom slash commands**)               | `/`               | `/`                                        |
| Install mech         | `claude plugin install` | direct file copy                                              | direct file copy  | direct file copy                           |
| Terminal             | tmux (CLI)              | tmux (CLI)                                                    | **GUI — no tmux** | **GUI — no tmux**                          |

---

## Shared changes (small edits, not new files)

These are the only non-`add` edits required. All backward-compatible.

1. **`src/providers/provider.js`** — add a shared `detectMatch(spec)` + `hasCmd(cmd)` helper. Today `detectMatch` is duplicated in `claude.js` and only supports `command:` and `dir:`. Move it here and add `macapp:` and `vscode-ext:` probes (see Detection). Every provider then delegates to the shared version.
2. **`src/hooks/airprompt-activate.js` / `airprompt-deactivate.js`** — accept a provider id from argv (`node airprompt-activate.js codex`), load it from the registry, and use that provider's `parseHookStdin` / `formatHookOutput` instead of hardcoding `ClaudeProvider`. Defaults to `claude` when argv is absent, so existing Claude wiring is unaffected. One wrapper serves all four providers; no per-provider wrapper copies.
3. **`bin/install.js`** — remove the `plannedIds = ['codex','cursor','windsurf']` "not yet implemented" gate (line ~106) so `--only codex` resolves against the registry.
4. **`bin/airprompt`** — update the "coming soon" hint (line ~43) to reflect the shipped providers.
5. **`bin/lib/protocol.sh` + all `bin/` scripts** — tmux warning. Add a `_warn_if_not_tmux()` helper to the shared lib (sourced by every bin script). When `$TMUX` is empty, it prints a prominent banner (ANSI yellow/red): the session is not inside tmux, so the phone attaches to an empty mirror shell instead of the live terminal; fix is `airprompt-launch --provider <id>` (or running the IDE/CLI inside `tmux`). Call it from the `bin/airprompt` dispatcher (covers `/airprompt <anything>`) and from the top of each `bin/airprompt-*.sh` sub-script (covers direct invocation), guarded by an `AIRPROMPT_TMUX_WARN_SHOWN` flag so the dispatcher→sub-script chain doesn't double-warn. Warning scope (decided): warn for every command except the teardown pair — `on`, `name`, `restart`, `status`, `auth`, `help`, `autostart`; suppress for `off` and `clean` (a tmux warning is pointless while tearing down).
6. **`src/status-formatter.js`** — mark non-tmux sessions in red. `airprompt status` already labels each session `MIRROR` vs `REAL` (a `MIRROR` is exactly the no-`$TMUX` case). Render `MIRROR` sessions in red (`\x1b[1;31m`) instead of the default cyan, so the non-tmux session stands out in `airprompt status`.

---

## Detection

Detection probes, expressed as the `detect:` string each provider exposes. The shared `detectMatch` expands `$VAR` from `process.env` (plus `~`) and evaluates `command:`, `dir:`, `macapp:`, `vscode-ext:` clauses OR'd with `||`. This matters: the strings below reference `$CODEX_HOME` and `$CODEIUM_EDITOR_APP_ROOT`, which resolve via `process.env` (falling back to "path does not exist" when unset).

| Provider | `detect:` string                                                                     | Notes                                                                                                           |
| -------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Codex    | `command:codex\|\|dir:$HOME/.codex\|\|dir:$CODEX_HOME\|\|macapp:ChatGPT.app`         | `CODEX_HOME` env may point elsewhere; app bundle binary is `/Applications/ChatGPT.app/Contents/Resources/codex` |
| Cursor   | `dir:$HOME/.cursor\|\|macapp:Cursor.app`                                             | Cursor is a standalone VS Code fork, not a VS Code extension                                                    |
| Windsurf | `dir:$HOME/.codeium/windsurf\|\|macapp:Windsurf.app\|\|dir:$CODEIUM_EDITOR_APP_ROOT` | `CODEIUM_EDITOR_APP_ROOT` is the agent-detection signal                                                         |

`macapp:` probes `/Applications/<name>` and `~/Applications/<name>`. `vscode-ext:` probes `~/.vscode/extensions/<publisher>.<id>-*/`; the shared helper supports it, but none of the three providers is a plain VS Code extension, so it is reserved (it can be added to Codex's `detect:` string once the Codex VS Code extension id is confirmed).

---

## Codex CLI (OpenAI)

**Effort: medium. Blind risk: lowest of the three.** Best-documented, CLI installable anywhere, snake_case stdin well specified.

### Config + feature flag

Config dir resolution: `$CODEX_HOME` → legacy `~/.codex` (if it exists) → XDG `~/.config/codex`. Hooks are stable since v0.124 (auto-enabled when `hooks.json` is discovered); the flag is still written for older versions:

```toml
# ~/.codex/config.toml
[features]
codex_hooks = true      # legacy flag — deprecated warning on current versions
hooks = true            # current flag — silently ignored by old (≤0.120) versions
```

Write **both** defensively. Timeline: hooks shipped experimental in v0.114 (March 2026) behind `codex_hooks`; v0.124 (April 2026) made hooks **stable and enabled by default** whenever `hooks.json` is discovered; v0.129 renamed the flag to `hooks` and deprecated `codex_hooks`. Old versions (≤0.120) silently ignore unknown keys, so `hooks = true` alone would be ignored on them — writing both activates on either. The `codex_hooks` deprecation warning on newer versions is harmless.

Can also be enabled via `codex features enable codex_hooks` (older) or `codex --enable hooks` (newer).

### Hook config (`hooks.json`)

Discovery locations (additive, both load): `~/.codex/hooks.json` (global) and `<repo>/.codex/hooks.json` (project). Structure is `event → matcher group → handler array`; **the matcher-group wrapper is required** — handlers placed directly in the event array do not run.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.airprompt/src/hooks/airprompt-activate.js codex",
            "timeout": 30
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.airprompt/src/hooks/airprompt-deactivate.js codex",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

`timeout` default is 600s (not a concern for daemon startup, unlike Cursor).

### stdin (snake_case JSON)

Common fields: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`. `SessionStart` adds `source` (`startup`/`resume`/`clear`/`compact`); `Stop` adds `turn_id`, `stop_hook_active`, `last_assistant_message`.

### stdout

- `SessionStart`: plain text on stdout is injected as developer context; JSON goes in a `hookSpecificOutput` envelope.
- **`Stop`: JSON-only — plain text is invalid.** Exit 0 with empty/no-op output is the safe default. `{"decision":"block"}` means "continue" (would loop); `{"continue":false}` stops. Our deactivate must emit `{}` (no-op), never `decision: block`.

Adapter mapping:

- `parseHookStdin` reads `session_id`, `cwd`, `hook_event_name` (snake_case) → normalized `HookContext`.
- `formatHookOutput` returns `{}` for ok (no-op); errors surface as `{systemMessage}`. Plain-text SessionStart output comes from `activateSession`'s own stdout, not from this function.
- `buildHookEntry` emits the matcher-group shape above.

### Skills / commands

Codex uses **skills** (not custom slash commands — those are a closed built-in enum, and `/skill` is unrecognized). Invocation is `$airprompt`. Skill lives at `~/.codex/skills/airprompt/SKILL.md` with minimal frontmatter:

```yaml
---
name: airprompt
description: Remote mobile access and voice dictation for this Codex session
---
```

`getSkillFiles` returns the skill; `getCommandFiles` returns `[]` (no `/airprompt` command exists for Codex).

### Codex-specific risk

Hooks require a **trust review**: non-managed command hooks are skipped until approved in the `/hooks` UI, and trust is keyed by hook-definition hash — changing a hook re-requires review. Beta testers must run `/hooks` once and approve. Document this in the beta instructions.

---

## Cursor (Anysphere)

**Effort: medium. Blind risk: medium.** Rich hook system, but GUI-first and two real quirks (empty `cwd`, 5s default timeout).

### Hook config (`hooks.json`)

Locations: `~/.cursor/hooks.json` (global) and `<project>/.cursor/hooks.json`. Command paths are relative to the config file's location.

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [
      { "command": "node /abs/path/src/hooks/airprompt-activate.js cursor", "timeout": 30 }
    ],
    "sessionEnd": [
      { "command": "node /abs/path/src/hooks/airprompt-deactivate.js cursor", "timeout": 30 }
    ]
  }
}
```

Per-entry fields: `command`, optional `matcher` (regex), `timeout` (**default 5s — must override**; daemon startup exceeds it), optional `failClosed` (default best-effort/fail-open). `type` can be `command` or `http`.

### stdin (camelCase JSON)

Events keyed on `session_id`. Two quirks to handle in `parseHookStdin`:

- `hook_event_name` is camelCase (e.g. `sessionStart`).
- **Top-level `cwd` is empty/absent** in Cursor CLI; the real path is `workspace_roots[0]`. `parseHookStdin` must fall back `cwd = workspace_roots[0] || process.cwd()`.

### Events

`sessionStart` (activate) and `sessionEnd` (deactivate) are the lifecycle pair. `stop` is **per-turn**, not per-session — do NOT use it for deactivation. Note: `sessionEnd` fires on composer/tab/window close; there is a known bug where command hooks fail to spawn on `window_close` (shell-exec host torn down), so deactivation is best-effort for that path — acceptable because the daemon's dead-session sweep is the safety net.

### Rules / commands / skills

- Rules: `.cursor/rules/airprompt.mdc` with YAML frontmatter (`description`, `globs`, `alwaysApply`). `getRuleFiles` returns this.
- Commands: `.cursor/commands/airprompt.md` — plain Markdown, no frontmatter, invoked `/airprompt`. `getCommandFiles` returns this.
- Skills: `.cursor/skills/airprompt/SKILL.md` (optional; rules+commands suffice for v1). `getSkillFiles` can return `[]`.

### GUI / tmux constraint

Cursor is a GUI editor — sessions have no tmux. AirPrompt falls back to a **mirror tmux shell** (`tmux new-session -d`), the same path already exercised for Claude Code under VS Code. Document that the phone attaches to a mirror shell, not the live editor pane (consistent with the Stage 3.4 note).

---

## Windsurf (Codeium)

**Effort: medium-low. Blind risk: medium-high** (hook format least documented), but no architectural blocker.

Windsurf has no session-end hook — its documented hook events are file/tool/save/commit/worktree/response-scoped: `on-open`, `pre_user_prompt`, `post_cascade_response`, `pre_read_code`, `pre_write_code`, `pre_run_command`, `pre-save`, `post-save`, `pre-commit`, `post_setup_worktree`, etc. `on-open` (workspace open) is the closest analog to a session start; there is no clean session end.

### Hook config

The adapter installs to the single global config dir `~/.codeium/windsurf/` (`hooks.json`, `skills/`, `rules/`). Format maps event → command (single object or array):

```json
{
  "hooks": {
    "on-open": { "command": "node /abs/path/src/hooks/airprompt-activate.js windsurf" },
    "post_cascade_response": {
      "command": "node /abs/path/src/hooks/airprompt-activate.js windsurf"
    }
  }
}
```

`post_cascade_response` fires after every response — it is an idempotent re-register (the activate wrapper short-circuits when the session is already active), included so a workspace opened before install still registers.

### Support model

- **Start**: `on-open` (workspace open) starts the daemon and registers a session. `post_cascade_response` as a secondary re-register trigger.
- **Stop**: none — no session-end event. The daemon stays running (a lightweight idle process) until `airprompt off` / `airprompt clean` / reboot. Stale session entries and orphan mirror tmux sessions are reclaimed by the dead-session sweep on the next activation.
- **Rules/skills**: `~/.codeium/windsurf/rules/airprompt.md` (YAML frontmatter, `always_on`) for context; `~/.codeium/windsurf/skills/airprompt/SKILL.md` for the command.

The missing session-end hook is an accepted, minor caveat — not a blocker.

---

## Beta plan (programming blind)

The unverifiable part is the exact hook stdin/stdout wire format per IDE. Mitigation:

1. **`--dump-stdin` mode** in the hook wrapper: `node airprompt-activate.js codex --dump-stdin` prints the raw stdin JSON it received and exits without side effects. Beta testers paste the dump back; one paste confirms or fixes the parser.
2. **`AIRPROMPT_DEBUG=1`** already streams registry-load and hook diagnostics to stderr.
3. **Isolation**: each adapter is a separate file; a broken `codex.js` cannot touch Claude/Cursor.
4. Per-IDE beta checklist:
   - Codex: `codex features enable codex_hooks`, approve the hook in `/hooks`, start a session, confirm registration + URL, close session, confirm unregister.
   - Cursor: open a composer, confirm `sessionStart` registers (watch `workspace_roots[0]` fallback), close composer, confirm `sessionEnd` unregisters.
   - Windsurf: open workspace, confirm `on-open` registers; confirm sweep reclaims after close.

---

## File manifest

### New (add)

- `src/providers/codex.js`
- `src/providers/cursor.js`
- `src/providers/windsurf.js`
- Template assets (or inline-generated): `SKILL.md` / rules / commands per provider (Codex skill, Cursor rule+command, Windsurf rule+skill). Recommend a `src/providers/templates/<provider>/` directory to keep provider files lean.
- `test/unit/provider-codex.test.js`, `test/unit/provider-cursor.test.js`, `test/unit/provider-windsurf.test.js` (mirror `provider-claude.test.js`).

### Edited (small)

- `src/providers/provider.js` — shared `detectMatch`/`hasCmd` + `macapp:`/`vscode-ext:`.
- `src/hooks/airprompt-activate.js`, `src/hooks/airprompt-deactivate.js` — provider-id argv.
- `bin/install.js` — drop the "not yet implemented" gate.
- `bin/airprompt` — refresh hint text.
- `bin/lib/protocol.sh` — `_warn_if_not_tmux()` helper; call it from the dispatcher + sub-scripts.
- `src/status-formatter.js` — render `MIRROR` (non-tmux) sessions in red.

### Validation

`make test-all` — the contract test auto-discovers the three new providers and validates their interface shape.

---

## Suggested commit message

```
feat(providers): codex, cursor, windsurf adapters
```

---

## Sources

- Codex hooks reference: [shanraisshan/codex-cli-best-practice](https://github.com/shanraisshan/codex-cli-best-practice/blob/main/best-practice/codex-hooks.md), [CodeAlive-AI codex-hooks reference](https://github.com/codealive-ai/ai-driven-development/blob/main/skills/hooks-management/references/codex-hooks.md), [learn.chatgpt.com hooks](https://learn.chatgpt.com/docs/hooks)
- Codex skills / `$` prefix: [shanraisshan codex-skills](https://github.com/shanraisshan/codex-cli-best-practice/blob/main/best-practice/codex-skills.md), [openai/codex issue #11817](https://github.com/openai/codex/issues/11817)
- Codex config/env: [PR #4414 CODEX_HOME](https://github.com/openai/codex/pull/4414), [codex environment variables](https://learn.chatgpt.com/docs/config-file/environment-variables)
- Cursor hooks: [cursor.com/docs/hooks](https://cursor.com/docs/hooks.md), [Cursor hooks schema (DeepWiki)](https://deepwiki.com/cursor/agent-trace/4.1-cursor-integration), [sessionEnd vs stop forum thread](https://forum.cursor.com/t/sessionend-hook-fires-only-on-window-close-after-shell-exec-teardown-plugin-hook-commands-can-never-execute/165492)
- Cursor rules/commands/skills: [cursor.com/docs/rules](https://cursor.com/docs/rules.md), [forum: skills vs commands vs rules](https://forum.cursor.com/t/skills-vs-commands-vs-rules/148875)
- Windsurf hooks: [docs.windsurf.com Cascade Hooks](https://docs.windsurf.com/windsurf/cascade/hooks), [rtk-ai/rtk windsurf hooks](https://github.com/rtk-ai/rtk/blob/af81b081/hooks/windsurf/README.md), [weykon/agent-hooks](https://github.com/weykon/agent-hooks)
- Windsurf rules: [skillsplayground.com Windsurf rules](https://skillsplayground.com/guides/windsurf-rules/)
- Vercel skills CLI: [vercel.com skills changelog](https://vercel.com/changelog/introducing-skills-the-open-agent-skills-ecosystem)
