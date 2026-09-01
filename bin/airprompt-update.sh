#!/bin/bash
# airprompt-update.sh — Update the installed AirPrompt git checkout.
#   airprompt update              → latest main
#   airprompt update vX.Y.Z       → a specific release tag
set -euo pipefail

TARGET_DIR="${AIRPROMPT_INSTALL_DIR:-$HOME/.airprompt}"
REF="${1:-}"

if [ ! -d "$TARGET_DIR/.git" ]; then
  echo "AirPrompt: not a git install at $TARGET_DIR — reinstall with the installer" >&2
  exit 1
fi

# First: refuse to update a dirty checkout — local edits would conflict with the
# checkout. Only tracked changes matter (node_modules/ + state/ are untracked).
if [ -n "$(git -C "$TARGET_DIR" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
  echo "AirPrompt: local changes in $TARGET_DIR — aborting update." >&2
  echo "  Inspect with: git -C $TARGET_DIR status" >&2
  echo "  Discard with: git -C $TARGET_DIR checkout -- ." >&2
  exit 1
fi

if [ -n "$REF" ]; then
  git -C "$TARGET_DIR" fetch --tags --depth 1 origin 2>/dev/null || true
  if git -C "$TARGET_DIR" checkout "$REF" 2>/dev/null; then
    echo "AirPrompt updated to $REF"
  else
    echo "AirPrompt: checkout $REF failed (unknown ref?)" >&2
    exit 1
  fi
else
  git -C "$TARGET_DIR" fetch --depth 1 origin main 2>/dev/null || true
  if git -C "$TARGET_DIR" checkout main 2>/dev/null; then
    echo "AirPrompt updated to main"
  else
    echo "AirPrompt: checkout main failed (offline? no main branch?)" >&2
    exit 1
  fi
fi
