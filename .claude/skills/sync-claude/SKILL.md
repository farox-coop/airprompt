---
description: Sync AirPrompt repo files to $CLAUDE_CONFIG_DIR/hooks/ and all plugin cache directories
---

# sync-claude

Sync AirPrompt source files from this repo to `$CLAUDE_CONFIG_DIR/hooks/`, `$CLAUDE_CONFIG_DIR/commands/`, and all installed plugin cache directories. Run after making changes to hooks, bin scripts, or command definitions.

## Execution

```bash
bash .claude/skills/sync-claude/sync.sh
```

## What it syncs

| Source                                                              | Destination                    | Type           |
| ------------------------------------------------------------------- | ------------------------------ | -------------- |
| `src/hooks/` (4 hook files)                                         | Plugin cache                   | copy           |
| `src/hooks/` (4 hook files)                                         | `$CLAUDE_CONFIG_DIR/hooks/`    | symlink → repo |
| `commands/` (2 files)                                               | Plugin cache                   | copy           |
| `commands/` (2 files)                                               | `$CLAUDE_CONFIG_DIR/commands/` | symlink → repo |
| `bin/` (11 files) + `bin/lib/`                                      | Each plugin cache              | copy           |
| `src/status-formatter.js`, `src/utils.js`, `src/install-helpers.js` | Each plugin cache              | copy           |
| `src/providers/*.js`                                                | Each plugin cache              | copy           |
| `bin/airprompt`, `bin/airprompt-launch` → `~/bin/`                  | Outside the config dir         | symlink → repo |
| `airprompt-<provider>` wrappers (generated) → `~/bin/`              | Outside the config dir         | generated      |
| `src/hooks/core/*.js`                                               | Each plugin cache              | copy           |

### Symlink vs copy policy

**Symlinks** (hooks + commands under `$CLAUDE_CONFIG_DIR`): the `~/.claude` repo tracks symlinks pointing into the airprompt dev checkout. Editing source files in `~/projects/airprompt` takes effect immediately — no sync needed for hooks/commands. The sync script restores symlinks if a stale copy overwrites them.

**Copies** (everything in a plugin cache, including the hooks and commands there — only the `$CLAUDE_CONFIG_DIR` destinations are symlinks): each cache needs a self-contained copy. These must be explicitly re-synced after source changes; editing the repo does not update a cache.

**NOT synced:** `$CLAUDE_CONFIG_DIR/hooks/notify.sh` belongs exclusively to the `~/.claude` repo. It is never touched by sync-claude.

All copies verified by MD5 checksum after sync. Symlinks at the `$CLAUDE_CONFIG_DIR/hooks/` and `$CLAUDE_CONFIG_DIR/commands/` destinations are preserved. Fails on exit code 1 if any copy doesn't match.
