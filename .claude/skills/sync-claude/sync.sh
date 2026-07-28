#!/usr/bin/env bash
set -euo pipefail

REPO="/home/diego/projects/airprompt"
CACHE_BASE="$HOME/.claude/plugins/cache/diegomanuel-airprompt/airprompt"

# Discover cache dirs
CACHES=($(ls -d "$CACHE_BASE"/*/ 2>/dev/null || true))

if [ ${#CACHES[@]} -eq 0 ]; then
  echo "FAIL: no plugin cache dirs at $CACHE_BASE"
  exit 1
fi

echo "=== Syncing to ${#CACHES[@]} cache dirs + ~/.claude/hooks/ + ~/.claude/commands/ ==="

HOOKS=(airprompt-activate.js airprompt-deactivate.js airprompt-statusline.sh)
BINS=(airprompt airprompt-attach.sh airprompt-autostart.sh airprompt-claude airprompt-clean.sh airprompt-name.sh airprompt-off.sh airprompt-on.sh airprompt-status.sh generate-cert.sh install.js)

# Copy to caches
for d in "${CACHES[@]}"; do
  for h in "${HOOKS[@]}"; do
    cp "$REPO/src/hooks/$h" "$d/src/hooks/"
  done
  for b in "${BINS[@]}"; do
    cp "$REPO/bin/$b" "$d/bin/"
  done
  # lib/ is a directory — needs recursive copy
  if [ -d "$REPO/bin/lib" ]; then
    cp -r "$REPO/bin/lib" "$d/bin/"
  fi
done

# Copy hooks to ~/.claude/ (skip if dest is a symlink — user-managed)
for h in "${HOOKS[@]}"; do
  dest="$HOME/.claude/hooks/$h"
  if [ -L "$dest" ]; then
    echo "  (skip $dest — symlink, user-managed)"
  else
    cp "$REPO/src/hooks/$h" "$dest"
  fi
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

# MD5 verify (hooks + bins + lib + commands in all caches)
MISMATCHES=0
TOTAL=0

debug_mismatch() {
  local what="$1" repo_path="$2" cache_base_dir="$3" file="$4"
  local repo_md5 cache_md5
  repo_md5=$(md5sum "$repo_path" | awk '{print $1}')
  cache_md5=$(md5sum "$cache_base_dir/$file" 2>/dev/null | awk '{print $1}')
  if [ "$repo_md5" != "$cache_md5" ]; then
    ((MISMATCHES++)) || true
    echo "MISMATCH $file in $(basename "$cache_base_dir")"
  fi
  ((TOTAL++)) || true
}

for h in "${HOOKS[@]}"; do
  for d in "${CACHES[@]}"; do
    debug_mismatch "hook" "$REPO/src/hooks/$h" "$d/src/hooks" "$h"
  done
  # Also verify ~/.claude/hooks/ copy (unless symlinked)
  if [ ! -L "$HOME/.claude/hooks/$h" ]; then
    debug_mismatch "hook" "$REPO/src/hooks/$h" "$HOME/.claude/hooks" "$h"
  fi
done

for b in "${BINS[@]}"; do
  for d in "${CACHES[@]}"; do
    debug_mismatch "bin" "$REPO/bin/$b" "$d/bin" "$b"
  done
done

# Verify lib/ files in caches
if [ -d "$REPO/bin/lib" ]; then
  while IFS= read -r -d '' libfile; do
    rel="${libfile#$REPO/bin/}"
    for d in "${CACHES[@]}"; do
      debug_mismatch "lib" "$libfile" "$d/bin" "$rel"
    done
  done < <(find "$REPO/bin/lib" -type f -print0)
fi

# Verify commands in caches
for f in airprompt.md airprompt.toml; do
  [ ! -f "$REPO/commands/$f" ] && continue
  for d in "${CACHES[@]}"; do
    debug_mismatch "command" "$REPO/commands/$f" "$d/commands" "$f"
  done
done

if [ $MISMATCHES -eq 0 ]; then
  echo "SYNCED OK ($TOTAL files verified across ${#CACHES[@]} caches + ~/.claude/hooks/)"
else
  echo "SYNC FAIL: $MISMATCHES/$TOTAL mismatches"
  exit 1
fi
