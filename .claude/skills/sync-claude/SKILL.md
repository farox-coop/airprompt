---
description: Sync AirPrompt repo files to ~/.claude/hooks/ and all plugin cache directories
---

# sync-claude

Sync AirPrompt source files from this repo to `~/.claude/hooks/`, `~/.claude/commands/`, and all installed plugin cache directories. Run after making changes to hooks, bin scripts, or command definitions.

## Execution

Run:

```bash
bash .claude/skills/sync-claude/sync.sh
```

## What it syncs

| Source | Destination |
|---|---|
| `src/hooks/` (3 files) | Each plugin cache + `~/.claude/hooks/` |
| `bin/` (11 files) | Each plugin cache |
| `bin/lib/` (directory) | Each plugin cache |
| `commands/` (2 files) | Each plugin cache + `~/.claude/commands/` |

All copies verified by MD5 checksum after sync. Symlinks at `~/.claude/hooks/` and `~/.claude/commands/` destinations are skipped (user-managed). Fails on exit code 1 if any copy doesn't match.
