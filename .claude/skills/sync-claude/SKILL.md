---
description: Sync AirPrompt repo files to ~/.claude/hooks/ and all plugin cache directories
---

# sync-claude

Sync AirPrompt source files from this repo to `~/.claude/hooks/`, `~/.claude/commands/`, and all installed plugin cache directories. Run after making changes to hooks, bin scripts, or command definitions.

## Execution

```bash
bash .claude/skills/sync-claude/sync.sh
```

## What it syncs

| Source                              | Destination                               | Type           |
| ----------------------------------- | ----------------------------------------- | -------------- |
| `src/hooks/airprompt-activate.js`   | Plugin cache + `~/.claude/hooks/`         | symlink → repo |
| `src/hooks/airprompt-deactivate.js` | Plugin cache + `~/.claude/hooks/`         | symlink → repo |
| `src/hooks/airprompt-statusline.sh` | Plugin cache + `~/.claude/hooks/`         | symlink → repo |
| `src/status-formatter.js`           | Plugin cache                              | copy           |
| `bin/` (12 files)                   | Each plugin cache                         | copy           |
| `bin/lib/` (directory)              | Each plugin cache                         | copy           |
| `commands/` (2 files)               | Each plugin cache + `~/.claude/commands/` | symlink → repo |

### Symlink vs copy policy

**Symlinks** (hooks + commands in `~/.claude/`): the `~/.claude` repo tracks symlinks pointing into the airprompt dev checkout. Editing source files in `~/projects/airprompt` takes effect immediately — no sync needed for hooks/commands. The sync script restores symlinks if a stale copy overwrites them.

**Copies** (bin scripts in plugin caches): each Claude Code plugin cache needs a self-contained copy. These must be explicitly re-synced after source changes.

**NOT synced:** `~/.claude/hooks/notify.sh` belongs exclusively to the `~/.claude` repo. It is never touched by sync-claude.

All copies verified by MD5 checksum after sync. Symlinks at `~/.claude/hooks/` and `~/.claude/commands/` destinations are preserved. Fails on exit code 1 if any copy doesn't match.
