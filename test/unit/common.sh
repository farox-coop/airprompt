# test/unit/common.sh — shared helpers for the shell test suites.
#
# Sourced (never executed directly) by test/unit/*.test.sh. Provides repo_root()
# so each suite resolves the repository root from its own location — works on a
# fresh clone (git available) and outside a git checkout (fallback), so a test
# never silently skips for lack of a resolved path.

# Resolve the repository root from the calling script's directory.
# Uses git when available; otherwise walks up two levels (test/unit → repo root).
repo_root() {
  local dir
  dir="$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd)"
  git -C "$dir" rev-parse --show-toplevel 2>/dev/null || (cd "$dir/../.." && pwd)
}
