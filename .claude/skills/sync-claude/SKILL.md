---
description: Sync AirPrompt repo files to ~/.claude/hooks/ and all plugin cache directories
---

# sync-claude

Sync AirPrompt source files from this repo to `~/.claude/hooks/`, `~/.claude/commands/`, and all installed plugin cache directories. Run after making changes to hooks, bin scripts, or command definitions.

## Execution

Run this command:

```bash
REPO="/home/diego/projects/airprompt"
CACHE_BASE="$HOME/.claude/plugins/cache/diegomanuel-airprompt/airprompt"

# Discover cache dirs
CACHES=($(ls -d "$CACHE_BASE"/*/ 2>/dev/null))

if [ ${#CACHES[@]} -eq 0 ]; then
  echo "FAIL: no plugin cache dirs at $CACHE_BASE"
  exit 1
fi

echo "=== Syncing to ${#CACHES[@]} cache dirs + ~/.claude/hooks/ + ~/.claude/commands/ ==="

HOOKS=(airprompt-activate.js airprompt-deactivate.js airprompt-statusline.sh)
BINS=(airprompt airprompt-on.sh airprompt-off.sh airprompt-name.sh airprompt-clean.sh airprompt-status.sh airprompt-attach.sh install.js)

# Copy to caches
for d in "${CACHES[@]}"; do
  for h in "${HOOKS[@]}"; do
    cp "$REPO/src/hooks/$h" "$d/src/hooks/"
  done
  for b in "${BINS[@]}"; do
    cp "$REPO/bin/$b" "$d/bin/"
  done
done

# Copy hooks to ~/.claude/
for h in "${HOOKS[@]}"; do
  cp "$REPO/src/hooks/$h" "$HOME/.claude/hooks/"
done

# Copy command files to ~/.claude/commands/ (skip if dest is a symlink — user-managed)
for f in airprompt.md airprompt.toml; do
  dest="$HOME/.claude/commands/$f"
  if [ -L "$dest" ]; then
    echo "  (skip $dest — symlink, user-managed)"
  elif [ -f "$REPO/commands/$f" ]; then
    cp "$REPO/commands/$f" "$dest"
  fi
done

# Copy command files to plugin caches (ensure commands/ dir exists)
for d in "${CACHES[@]}"; do
  mkdir -p "$d/commands"
  for f in airprompt.md airprompt.toml; do
    [ -f "$REPO/commands/$f" ] && cp "$REPO/commands/$f" "$d/commands/"
  done
done

# MD5 verify (hooks + bins + commands in all caches)
MISMATCHES=0
TOTAL=0
for h in "${HOOKS[@]}"; do
  REPO_MD5=$(md5sum "$REPO/src/hooks/$h" | awk '{print $1}')
  for d in "${CACHES[@]}"; do
    CACHE_MD5=$(md5sum "$d/src/hooks/$h" 2>/dev/null | awk '{print $1}')
    ((TOTAL++))
    [ "$REPO_MD5" != "$CACHE_MD5" ] && ((MISMATCHES++)) && echo "MISMATCH $h in $(basename "$d")"
  done
done
for b in "${BINS[@]}"; do
  REPO_MD5=$(md5sum "$REPO/bin/$b" | awk '{print $1}')
  for d in "${CACHES[@]}"; do
    CACHE_MD5=$(md5sum "$d/bin/$b" 2>/dev/null | awk '{print $1}')
    ((TOTAL++))
    [ "$REPO_MD5" != "$CACHE_MD5" ] && ((MISMATCHES++)) && echo "MISMATCH $b in $(basename "$d")"
  done
done
for f in airprompt.md airprompt.toml; do
  [ ! -f "$REPO/commands/$f" ] && continue
  REPO_MD5=$(md5sum "$REPO/commands/$f" | awk '{print $1}')
  for d in "${CACHES[@]}"; do
    CACHE_MD5=$(md5sum "$d/commands/$f" 2>/dev/null | awk '{print $1}')
    ((TOTAL++))
    [ "$REPO_MD5" != "$CACHE_MD5" ] && ((MISMATCHES++)) && echo "MISMATCH commands/$f in $(basename "$d")"
  done
done

if [ $MISMATCHES -eq 0 ]; then
  echo "SYNCED OK (${#HOOKS[@]} hooks + ${#BINS[@]} bins + 2 commands × ${#CACHES[@]} caches + ~/.claude/hooks + ~/.claude/commands = $TOTAL checks)"
else
  echo "SYNC FAIL: $MISMATCHES/$TOTAL mismatches"
  exit 1
fi
```
