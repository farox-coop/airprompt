#!/usr/bin/env bash
set -euo pipefail

REPO="$(git rev-parse --show-toplevel 2>/dev/null || { echo "ERROR: not inside a git repo" >&2; exit 1; })"
# Shared portable helpers (_md5, _safe_rm_rf, _lan_ip, _is_airprompt_pid).
source "$REPO/bin/lib/protocol.sh"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
# Widen past `*-airprompt`: the cache directory is named after the marketplace,
# which is named after the repo slug at *add* time. `airprompt` (the name now)
# and `diegomanuel-airprompt` (the pre-rename name) must both match, or the live
# cache is missed and nothing gets synced or pruned. Newest base wins — a
# rename leaves the previous base behind, and the live one keeps being written.
CACHE_BASE=$(set +o pipefail; ls -dt "$CLAUDE_DIR/plugins/cache/"*airprompt/airprompt 2>/dev/null | head -1 || true)

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
#
# Two dirs are never pruned, because Claude Code keeps pointing at them:
#   - the one recorded in installed_plugins.json (`installPath`) — deleting it
#     is exactly what produces `Plugin "airprompt" not cached at <path>`
#   - one a live session is using (`.in_use/` holds its pid files)
KEEP_COUNT=2
PLUGIN_RECORD="$CLAUDE_DIR/plugins/installed_plugins.json"
RECORDED_PATHS=()
if [ -f "$PLUGIN_RECORD" ]; then
  # Node is a hard requirement of this project, and `jq` is not guaranteed.
  while IFS= read -r p; do
    [ -n "$p" ] && RECORDED_PATHS+=("$p")
  done < <(node -e '
    try {
      const fs = require("fs");
      const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      for (const entries of Object.values(d.plugins || {})) {
        for (const e of entries || []) if (e && e.installPath) console.log(e.installPath);
      }
    } catch (_) {}
  ' "$PLUGIN_RECORD" 2>/dev/null || true)
fi

# A missing node (or a shape we cannot parse) leaves this empty, and pruning
# without knowing which dir Claude Code recorded is how the recorded one gets
# deleted — that is the `Plugin "airprompt" not cached at <path>` bug. So when
# there is a record we cannot read, skip the prune instead of guessing.
PRUNE_OK=1
if [ -f "$PLUGIN_RECORD" ] && [ ${#RECORDED_PATHS[@]} -eq 0 ]; then
  echo "  WARNING: no installPath read from $PLUGIN_RECORD — skipping the prune rather than delete a recorded cache" >&2
  PRUNE_OK=0
fi

_is_recorded() {
  local dir="${1%/}"
  for p in "${RECORDED_PATHS[@]:-}"; do
    [ -n "$p" ] && [ "${p%/}" = "$dir" ] && return 0
  done
  return 1
}

# Claude Code names each file after the pid of the session using the dir, and
# leaves the file behind when that session exits — so a non-empty `.in_use/` is
# not proof of a live session. Reading the pids keeps a dead one from pinning
# its 70 MB dir forever (which would turn KEEP_COUNT into a no-op).
# An entry whose name is not a pid is assumed live: never prune on a guess.
_is_in_use() {
  local dir="${1%/}" f pid
  [ -d "$dir/.in_use" ] || return 1
  for f in "$dir/.in_use"/*; do
    [ -f "$f" ] || continue
    pid="${f##*/}"
    pid="${pid//[!0-9]/}"
    [ -n "$pid" ] || return 0
    kill -0 "$pid" 2>/dev/null && return 0
  done
  return 1
}

if [ "$PRUNE_OK" -eq 1 ] && [ ${#CACHES[@]} -gt $KEEP_COUNT ]; then
  # ls -dt sorts newest first — keep first $KEEP_COUNT, remove the rest.
  # `mapfile` is bash ≥4 — macOS ships bash 3.2, so use a while-read loop.
  REMOVED=0
  KEPT=0
  idx=0
  while IFS= read -r dir; do
    idx=$((idx + 1))
    dir="${dir%/}"
    if [ "$idx" -le "$KEEP_COUNT" ]; then
      continue
    fi
    if _is_recorded "$dir"; then
      echo "  keeping $(basename "$dir") — recorded in installed_plugins.json"
      ((KEPT++)) || true
      continue
    fi
    if _is_in_use "$dir"; then
      echo "  keeping $(basename "$dir") — in use by a running session"
      ((KEPT++)) || true
      continue
    fi
    _safe_canonical="$(cd "$(dirname "$dir")" 2>/dev/null && pwd -P 2>/dev/null)" || {
      echo "  SAFETY: cannot resolve parent of ${dir} — skipping" >&2
      continue
    }
    _safe_canonical="${_safe_canonical%/}/$(basename "$dir")"
    if [[ "$_safe_canonical" != *airprompt* ]]; then
      echo "  SAFETY: canonical path missing 'airprompt' — refusing rm -rf $_safe_canonical" >&2
      continue
    fi
    echo "  pruning stale cache: $(basename "$dir")"
    rm -rf "$dir"
    ((REMOVED++)) || true
  done < <(ls -dt "${CACHES[@]}" 2>/dev/null)
  echo "  removed $REMOVED stale cache dirs (kept latest $KEEP_COUNT + $KEPT protected)"
  # Refresh cache list after pruning
  CACHES=($(ls -d "$CACHE_BASE"/*/ 2>/dev/null || true))
fi

HOOKS=(airprompt-activate.js airprompt-deactivate.js airprompt-statusline.sh airprompt-session-tokens.js)
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
mkdir -p "$CLAUDE_DIR/hooks" "$CLAUDE_DIR/commands"
for h in "${HOOKS[@]}"; do
  dest="$CLAUDE_DIR/hooks/$h"
  src="$REPO/src/hooks/$h"
  if [ ! -f "$src" ]; then
    echo "  (skip $h — source missing from repo)"
    continue
  fi
  if [ -d "$dest" ]; then
    echo "  WARNING: $dest is a directory, should be a symlink — removing"
    # Safety: only rm -rf under ~/.claude/
    [[ "$dest" == "$CLAUDE_DIR/"* ]] || { echo "  SAFETY: refusing rm -rf outside the claude config dir — $dest" >&2; continue; }
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
  dest="$CLAUDE_DIR/commands/$f"
  src="$REPO/commands/$f"
  [ ! -f "$src" ] && continue
  if [ -d "$dest" ]; then
    echo "  WARNING: $dest is a directory, should be a symlink — removing"
    [[ "$dest" == "$CLAUDE_DIR/"* ]] || { echo "  SAFETY: refusing rm -rf outside the claude config dir — $dest" >&2; continue; }
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
  dest="$CLAUDE_DIR/hooks/$h"
  if [ ! -L "$dest" ] && [ -f "$dest" ]; then
    # Only verify if content matches repo (i.e. a managed copy, not user-edited)
    if diff -q "$REPO/src/hooks/$h" "$dest" >/dev/null 2>&1; then
      debug_mismatch "hook" "$REPO/src/hooks/$h" "$CLAUDE_DIR/hooks" "$h"
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
  dest="$CLAUDE_DIR/commands/$f"
  if [ ! -L "$dest" ] && [ -f "$dest" ]; then
    if diff -q "$REPO/commands/$f" "$dest" >/dev/null 2>&1; then
      debug_mismatch "command" "$REPO/commands/$f" "$CLAUDE_DIR/commands" "$f"
    fi
  fi
done

if [ $MISMATCHES -eq 0 ]; then
  echo "SYNCED OK ($TOTAL files verified across ${#CACHES[@]} caches + ~/.claude/hooks/)"
else
  echo "SYNC FAIL: $MISMATCHES/$TOTAL mismatches"
  exit 1
fi
