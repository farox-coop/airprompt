#!/usr/bin/env bash
# airprompt — installer shim (adapted from caveman's install.sh).
#
# Thin wrapper around bin/install.js (the unified Node installer). Every flag
# you'd pass to bin/install.js can be passed here; we just forward them.
#
# One-line install:
#   curl -fsSL https://raw.githubusercontent.com/farox-coop/airprompt/main/install.sh | bash
#
# Local clone:
#   bash install.sh [flags]
#
# Why a Node installer? install.sh + install.ps1 used to be parallel sources
# of truth and constantly drifted. One Node script works everywhere without
# bash/PowerShell quoting bugs.

set -euo pipefail

REPO="farox-coop/airprompt"
# Pinned install tag (immutable). `make set-release-tag TAG=vX.Y.Z` bumps this.
VERSION="v1.0.0"

# Require Node ≥20. nvm is a common path; print a hint if missing.
if ! command -v node >/dev/null 2>&1; then
  echo "airprompt: Node.js (≥20) required. Install:" >&2
  echo "  macOS:  brew install node" >&2
  echo "  Linux:  see https://nodejs.org or use nvm (https://github.com/nvm-sh/nvm)" >&2
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "airprompt: Node $NODE_MAJOR too old. Need Node ≥20." >&2
  echo "  Upgrade: https://nodejs.org" >&2
  exit 1
fi

# If we're inside the repo clone, run the local installer directly — saves
# the round-trip and keeps offline installs working. BASH_SOURCE is unset
# when bash is invoked from stdin (curl | bash), and `set -u` would trip on a
# bare reference — default to empty so the curl-pipe path falls through cleanly.
here="$(cd "$(dirname "${BASH_SOURCE[0]:-}")" 2>/dev/null && pwd)" || here=""
if [ -n "$here" ] && [ -f "$here/bin/install.js" ]; then
  exec node "$here/bin/install.js" "$@"
fi

# Curl-pipe path: shallow clone then exec installer.
# We can't use npx like caveman does — airprompt has runtime npm deps
# (express, ws, node-pty, qrcode-terminal) that npx won't install.
# Clone + let bin/install.js handle npm install.
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT
if ! git clone --depth 1 --branch "$VERSION" "https://github.com/${REPO}.git" "$TMP_DIR"; then
  echo "airprompt: clone of ${REPO}@${VERSION} failed (tag not found? no network?)" >&2
  exit 1
fi
exec node "$TMP_DIR/bin/install.js" "$@"
