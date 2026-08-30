#!/usr/bin/env bash
set -euo pipefail

REPO="$(git rev-parse --show-toplevel 2>/dev/null || { echo "ERROR: not inside a git repo" >&2; exit 1; })"
# Shared portable helpers (_md5, _safe_rm_rf, _lan_ip, _is_airprompt_pid).
source "$REPO/bin/lib/protocol.sh"
CACHE_BASE=$(set +o pipefail; ls -d "$HOME/.claude/plugins/cache/"*-airprompt/airprompt 2>/dev/null | head -1 || true)

# Discover cache dirs (optional — hooks point to dev repo, caches are copies)
CACHES=()
if [ -n "$CACHE_BASE" ]; then
  CACHES=($(ls -d "$CACHE_BASE"/*/ 2>/dev/null || true))
fi

if [ ${#CACHES[@]} -eq 0 ]; then
  echo "=== Syncing to ~/.claude/hooks/ + ~/.claude/commands/ (no plugin caches found) ==="
else
  echo "=== Syncing to ${#CACHES[@]} cache dirs + ~/.claude/hooks/ + ~/.claude/commands/ ==="
fi

# ── Cleanup: prune stale caches, keep only latest N by mtime ──────────
# Each commit creates a new cache dir with full node_modules (~70MB).
# Sort by modification time so new commits don't nuke all old caches
# just because the git hashes changed.
KEEP_COUNT=2
if [ ${#CACHES[@]} -gt $KEEP_COUNT ]; then
  # ls -dt sorts newest first — keep first $KEEP_COUNT, remove the rest.
  # `mapfile` is bash ≥4 — macOS ships bash 3.2, so use a while-read loop.
  REMOVED=0
  idx=0
  while IFS= read -r dir; do
    idx=$((idx + 1))
    [ "$idx" -le "$KEEP_COUNT" ] && continue
    dirname=$(basename "$dir")
    _safe_canonical="$(cd "$(dirname "$dir")" 2>/dev/null && pwd -P 2>/dev/null)" || {
      echo "  SAFETY: cannot resolve parent of ${dir} — skipping" >&2
      continue
    }
    _safe_canonical="${_safe_canonical%/}/$(basename "$dir")"
    if [[ "$_safe_canonical" != *airprompt* ]]; then
      echo "  SAFETY: canonical path missing 'airprompt' — refusing rm -rf $_safe_canonical" >&2
      continue
    fi
    echo "  pruning stale cache: $dirname"
    rm -rf "$dir"
    ((REMOVED++)) || true
  done < <(ls -dt "${CACHES[@]}" 2>/dev/null)
  echo "  removed $REMOVED stale cache dirs (keeping latest $KEEP_COUNT)"
  # Refresh cache list after pruning
  CACHES=($(ls -d "$CACHE_BASE"/*/ 2>/dev/null || true))
fi

HOOKS=(airprompt-activate.js airprompt-deactivate.js airprompt-statusline.sh)
BINS=(airprompt airprompt-autostart.sh airprompt-clean.sh airprompt-launch airprompt-name.sh airprompt-off.sh airprompt-on.sh airprompt-restart.sh airprompt-status.sh generate-cert.sh install.js)

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
  # src/ utilities used by bin scripts
  for s in status-formatter.js utils.js install-helpers.js; do
    mkdir -p "$d/src"
    cp "$REPO/src/$s" "$d/src/"
  done
  # src/providers/ — provider adapter + registry
  if [ -d "$REPO/src/providers" ]; then
    mkdir -p "$d/src/providers"
    cp "$REPO/src/providers/"*.js "$d/src/providers/"
  fi
  # src/hooks/core/ — shared hook logic
  if [ -d "$REPO/src/hooks/core" ]; then
    mkdir -p "$d/src/hooks/core"
    cp "$REPO/src/hooks/core/"*.js "$d/src/hooks/core/"
  fi
done

# ── ~/bin/ symlinks + provider wrappers ───────────────────────────────
# airprompt + airprompt-launch must be available from any terminal.
# All symlinks point directly to repo source — no ~/.airprompt/ middleman needed.
HOME_BIN="$HOME/bin"
LAUNCH_SRC="$REPO/bin/airprompt-launch"
DISPATCH_SRC="$REPO/bin/airprompt"

mkdir -p "$HOME_BIN"

# ~/bin/airprompt → repo (dispatcher)
if [ ! -L "$HOME_BIN/airprompt" ] || [ "$(readlink "$HOME_BIN/airprompt" 2>/dev/null)" != "$DISPATCH_SRC" ]; then
	rm -f "$HOME_BIN/airprompt"
	ln -s "$DISPATCH_SRC" "$HOME_BIN/airprompt"
	echo "  symlinked: $HOME_BIN/airprompt → $DISPATCH_SRC"
fi

# ~/bin/airprompt-launch → repo
if [ ! -L "$HOME_BIN/airprompt-launch" ] || [ "$(readlink "$HOME_BIN/airprompt-launch" 2>/dev/null)" != "$LAUNCH_SRC" ]; then
	rm -f "$HOME_BIN/airprompt-launch"
	ln -s "$LAUNCH_SRC" "$HOME_BIN/airprompt-launch"
	echo "  symlinked: $HOME_BIN/airprompt-launch → $LAUNCH_SRC"
fi

# Provider wrappers: ~/bin/airprompt-{provider}
KNOWN_PROVIDERS=(claude codex cursor windsurf)
for prov in "${KNOWN_PROVIDERS[@]}"; do
	wrapper="$HOME_BIN/airprompt-$prov"
	cat > "$wrapper" << PROVIDEREOF
#!/bin/bash
exec airprompt-launch --provider $prov "\$@"
PROVIDEREOF
	chmod +x "$wrapper"
	echo "  wrapper: $wrapper"
done

# Sync hooks to ~/.claude/ — prefer symlinks into repo. If symlink was
# overwritten by a stale copy (content matches repo), restore it.
mkdir -p "$HOME/.claude/hooks" "$HOME/.claude/commands"
for h in "${HOOKS[@]}"; do
  dest="$HOME/.claude/hooks/$h"
  src="$REPO/src/hooks/$h"
  if [ ! -f "$src" ]; then
    echo "  (skip $h — source missing from repo)"
    continue
  fi
  if [ -d "$dest" ]; then
    echo "  WARNING: $dest is a directory, should be a symlink — removing"
    # Safety: only rm -rf under ~/.claude/
    [[ "$dest" == "$HOME/.claude/"* ]] || { echo "  SAFETY: refusing rm -rf outside ~/.claude/ — $dest" >&2; continue; }
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

# Sync commands to ~/.claude/commands/ — same symlink logic
for f in airprompt.md airprompt.toml; do
  dest="$HOME/.claude/commands/$f"
  src="$REPO/commands/$f"
  [ ! -f "$src" ] && continue
  if [ -d "$dest" ]; then
    echo "  WARNING: $dest is a directory, should be a symlink — removing"
    [[ "$dest" == "$HOME/.claude/"* ]] || { echo "  SAFETY: refusing rm -rf outside ~/.claude/ — $dest" >&2; continue; }
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
  local repo_path="$2" cache_base_dir="$3" file="$4"
  local repo_md5 cache_md5
  repo_md5=$(_md5 "$repo_path")
  cache_md5=$(_md5 "$cache_base_dir/$file")
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
    rel="${libfile#"$REPO/bin/"}"
    for d in "${CACHES[@]}"; do
      debug_mismatch "lib" "$libfile" "$d/bin" "$rel"
    done
  done < <(find "$REPO/bin/lib" -type f -print0)
fi

# Verify src/ files in caches (utils, install-helpers, status-formatter)
for s in status-formatter.js utils.js install-helpers.js; do
  for d in "${CACHES[@]}"; do
    debug_mismatch "src" "$REPO/src/$s" "$d/src" "$s"
  done
done

# Verify src/providers/ in caches
if [ -d "$REPO/src/providers" ]; then
  for prov in "$REPO/src/providers/"*.js; do
    [ ! -f "$prov" ] && continue
    bn=$(basename "$prov")
    for d in "${CACHES[@]}"; do
      debug_mismatch "providers" "$prov" "$d/src/providers" "$bn"
    done
  done
fi

# Verify src/hooks/core/ in caches
if [ -d "$REPO/src/hooks/core" ]; then
  for coref in "$REPO/src/hooks/core/"*.js; do
    [ ! -f "$coref" ] && continue
    bn=$(basename "$coref")
    for d in "${CACHES[@]}"; do
      debug_mismatch "hooks/core" "$coref" "$d/src/hooks/core" "$bn"
    done
  done
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
