#!/usr/bin/env bash
set -euo pipefail

REPO="$(git rev-parse --show-toplevel 2>/dev/null || { echo "ERROR: not inside a git repo" >&2; exit 1; })"
CACHE_BASE=$(set +o pipefail; ls -d "$HOME/.claude/plugins/cache/"*-airprompt/airprompt 2>/dev/null | head -1 || true)

if [ -z "$CACHE_BASE" ]; then
  echo "FAIL: no plugin cache found at \$HOME/.claude/plugins/cache/*-airprompt/airprompt" >&2
  echo "       Install the plugin first: claude plugin marketplace add <publisher>/airprompt" >&2
  exit 1
fi

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

# Sync hooks to ~/.claude/ — prefer symlinks into repo. If symlink was
# overwritten by a stale copy (content matches repo), restore it.
for h in "${HOOKS[@]}"; do
  dest="$HOME/.claude/hooks/$h"
  src="$REPO/src/hooks/$h"
  if [ ! -f "$src" ]; then
    echo "  (skip $h — source missing from repo)"
    continue
  fi
  if [ -d "$dest" ]; then
    echo "  WARNING: $dest is a directory, should be a symlink — removing"
    rm -rf "$dest"
    ln -s "$src" "$dest"
    echo "  restored symlink: $dest → $src"
  elif [ -L "$dest" ]; then
    # Already a symlink — verify it points to the right place and exists
    _target=$(readlink "$dest" 2>/dev/null || echo "")
    if [ ! -e "$dest" ]; then
      echo "  broken symlink: $dest → restoring"
      rm "$dest"
      ln -s "$src" "$dest"
      echo "  restored symlink: $dest → $src"
    elif [ "$_target" != "$src" ]; then
      echo "  redirecting symlink: $dest (was → $_target, now → $src)"
      rm "$dest"
      ln -s "$src" "$dest"
    fi
  elif [ -f "$dest" ]; then
    # Regular file — check if content matches repo (stale copy → restore symlink)
    if diff -q "$src" "$dest" >/dev/null 2>&1; then
      echo "  restoring symlink (was overwritten): $dest"
      rm "$dest"
      ln -s "$src" "$dest"
      echo "  restored symlink: $dest → $src"
    else
      echo "  (skip $dest — user-edited copy, not overwriting)"
    fi
  else
    # No file at dest — create symlink
    ln -s "$src" "$dest"
    echo "  symlinked: $dest → $src"
  fi
done

# Sync commands to ~/.claude/commands/ — same symlink logic
for f in airprompt.md airprompt.toml; do
  dest="$HOME/.claude/commands/$f"
  src="$REPO/commands/$f"
  [ ! -f "$src" ] && continue
  if [ -d "$dest" ]; then
    echo "  WARNING: $dest is a directory, should be a symlink — removing"
    rm -rf "$dest"
    ln -s "$src" "$dest"
    echo "  restored symlink: $dest → $src"
  elif [ -L "$dest" ]; then
    _target=$(readlink "$dest" 2>/dev/null || echo "")
    if [ ! -e "$dest" ]; then
      echo "  broken symlink: $dest → restoring"
      rm "$dest"
      ln -s "$src" "$dest"
      echo "  restored symlink: $dest → $src"
    elif [ "$_target" != "$src" ]; then
      echo "  redirecting symlink: $dest (was → $_target, now → $src)"
      rm "$dest"
      ln -s "$src" "$dest"
    fi
  elif [ -f "$dest" ]; then
    if diff -q "$src" "$dest" >/dev/null 2>&1; then
      echo "  restoring symlink (was overwritten): $dest"
      rm "$dest"
      ln -s "$src" "$dest"
      echo "  restored symlink: $dest → $src"
    else
      echo "  (skip $dest — user-edited copy, not overwriting)"
    fi
  else
    ln -s "$src" "$dest"
    echo "  symlinked: $dest → $src"
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
  # Verify ~/.claude/hooks/ copy — skip symlinks and user-edited copies
  dest="$HOME/.claude/hooks/$h"
  if [ ! -L "$dest" ] && [ -f "$dest" ]; then
    # Only verify if content matches repo (i.e. a managed copy, not user-edited)
    if diff -q "$REPO/src/hooks/$h" "$dest" >/dev/null 2>&1; then
      debug_mismatch "hook" "$REPO/src/hooks/$h" "$HOME/.claude/hooks" "$h"
    fi
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
  # Also verify ~/.claude/commands/ copy — skip symlinks and user-edited copies
  dest="$HOME/.claude/commands/$f"
  if [ ! -L "$dest" ] && [ -f "$dest" ]; then
    if diff -q "$REPO/commands/$f" "$dest" >/dev/null 2>&1; then
      debug_mismatch "command" "$REPO/commands/$f" "$HOME/.claude/commands" "$f"
    fi
  fi
done

if [ $MISMATCHES -eq 0 ]; then
  echo "SYNCED OK ($TOTAL files verified across ${#CACHES[@]} caches + ~/.claude/hooks/)"
else
  echo "SYNC FAIL: $MISMATCHES/$TOTAL mismatches"
  exit 1
fi
