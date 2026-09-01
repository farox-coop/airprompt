#!/usr/bin/env bash
# airprompt-agnostic-check — Audit codebase for hardcoded provider names.
# DEV-ONLY TOOL. NOT SHIPPED TO END USERS. NOT IN DISPATCHER. NOT IN SYNC.
#
# Scans every source file outside provider-adapter dirs for provider IDs.
# Rule: NO provider name (claude, codex, cursor, etc.) shall appear
# hardcoded in any core/agnostic/generic file.
#
# Provider adapters (src/providers/<name>.js), IDE-specific artifacts
# (.claude-plugin/, etc.), and documentation (docs/) are EXEMPT.
#
# Usage: bash bin/airprompt-agnostic-check.sh

set -euo pipefail
cd "$(dirname "$0")/.."

PROVIDERS=(claude codex cursor windsurf gemini)

# Files/dirs exempt from scanning (these ARE provider-specific by design).
EXEMPT_FILES=(
  ".gitignore"
  "bin/airprompt-agnostic-check.sh"
  "bin/airprompt"
  "bin/airprompt-on.sh"
  "bin/airprompt-autostart.sh"
  "bin/install.js"
  "src/providers/claude.js"
  "src/providers/codex.js"
  "src/providers/cursor.js"
  "src/providers/windsurf.js"
  "src/providers/gemini.js"
  "src/hooks/airprompt-activate.js"
  "src/hooks/airprompt-deactivate.js"
  "src/hooks/core/resolve-provider.js"
)

EXEMPT_DIRS=(
  ".claude-plugin"
  ".codex-plugin"
  ".cursor-plugin"
  ".windsurf-plugin"
  ".gemini-plugin"
  ".claude/skills"
  "docs"
  "test"
  "node_modules"
  ".git"
)

is_exempt() {
  local f="$1"
  for e in "${EXEMPT_FILES[@]}"; do [[ "$f" == "$e" ]] && return 0; done
  for d in "${EXEMPT_DIRS[@]}"; do
    [[ "$f" = "$d" || "$f" = "$d"/* ]] && return 0
  done
  return 1
}

# Collect files — tracked files only (git), so gitignored local state (.vscode/,
# .claude/review-findings/) never trips the check. Falls back to find outside a worktree.
FILES=()
while IFS= read -r -d '' f; do
  is_exempt "$f" || FILES+=("$f")
done < <(git ls-files -z 2>/dev/null || find . -type f \( -name '*.js' -o -name '*.sh' -o -name '*.json' \
  -o -name '*.html' -o -name '*.css' -o -name '*.md' -o -name '*.toml' \
  -o -name '*.yml' -o -name 'Makefile' -o -name '*.mk' \
  -o -name 'airprompt' -o -name 'airprompt-launch' \) -print0 2>/dev/null | sed 's|^\./||')

# Scan
HITS=""
COUNT=0

for f in "${FILES[@]}"; do
  for prov in "${PROVIDERS[@]}"; do
    matches=$(grep -n -i "$prov" "$f" 2>/dev/null | grep -iv \
      -e "CLAUDE_CONFIG_DIR" \
      -e "CLAUDE_PLUGIN_ROOT" \
      -e "CLAUDE_CODE" \
      -e "AIRPROMPT_PROVIDER" \
      -e "providerId" \
      -e "for prov in" \
      -e "add.*provider.*here" \
      -e "new provider" \
      -e "provider.*adapter" \
      -e "e\.g\. .${prov}.\|e.g. .${prov}." \
      -e "DEFAULT_BINARY" \
      -e "\"${prov}\"" \
      -e "cursor.*pointer" \
      -e "cursorBlink" \
      -e "cursor[A-Z]" \
      -e "cursor:" \
      -e "cursor " \
      -e "/cursor" \
      -e "cursor/" \
      || true)

    # Skip CSS/JS cursor property matches (false positives for "cursor" provider)
    if [ "$prov" = "cursor" ]; then
      matches=$(echo "$matches" | grep -iv \
        -e "cursor:" \
        -e "cursor " \
        -e "cursorBlink" \
        -e "flex-shrink" \
        -e "zIndex" \
        -e "user-select" \
        -e "border-radius" \
        -e "padding" \
        || true)
    fi

    # Only scan code files — docs/meta/config (.md/.json/.css/.html/.toml/.yml/Makefile)
    # mention providers descriptively and are not core code.
    case "$f" in
      *.md|docs/*|*.css|*.html|*.json|*.toml|*.svg|Makefile|*.yml) continue ;;
    esac
    [ -n "$matches" ] || continue

    while IFS= read -r line; do
      [ -z "$line" ] && continue
      # Skip test fixtures (hardcoded test data strings)
      ln=$(echo "$line" | cut -d: -f1)
      txt=$(echo "$line" | cut -d: -f2- | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
      # Skip JSDoc examples
      [[ "$txt" =~ @param.*"e.g." ]] && continue
      # Skip pure comments about the provider
      [[ "$txt" =~ ^[[:space:]]*//.*[Cc]laude[[:space:]]*[Cc]ode ]] && continue
      [[ "$txt" =~ ^[[:space:]]*//.*[Pp]rovider ]] && continue
      COUNT=$((COUNT + 1))
      HITS+="${f}:${ln}:${txt}"$'\n'
    done <<< "$matches"
  done
done

# Output
B='\033[1m'; R='\033[31m'; G='\033[32m'; C='\033[36m'; N='\033[0m'

echo ""
echo -e "${B}═══════════════════════════════════════════════════════════════${N}"
echo -e "${B}  AirPrompt Agnostic Check — Provider Hardcoding Audit${N}"
echo -e "${B}═══════════════════════════════════════════════════════════════${N}"
echo -e "  Files scanned: ${#FILES[@]}  |  Providers: ${PROVIDERS[*]}"
echo -e "  Exempt dirs:   ${EXEMPT_DIRS[*]}"
echo -e "  Exempt files:  $(echo "${EXEMPT_FILES[@]}" | wc -w)"
echo ""

echo -e "${B}${R}─── REFERENCES FOUND ────────────────────────────────────────────${N}"
echo -e "${R}  Every entry below = provider name in non-adapter code.${N}"
echo -e "${R}  Review each one. Fix violations. Justify exceptions below.${N}"
echo ""

if [ "$COUNT" -eq 0 ]; then
  echo -e "  ${G}✓ Zero provider references in core code.${N}"
else
  echo -e "  ${R}${B}${COUNT} reference(s):${N}"
  echo ""
  prev=""
  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    f="${entry%%:*}"
    rest="${entry#*:}"
    ln="${rest%%:*}"
    txt="${rest#*:}"
    if [ "$f" != "$prev" ]; then
      echo -e "  ${B}${C}── ${f} ──${N}"
      prev="$f"
    fi
    printf "    ${R}L%-4s${N} %s\n" "$ln" "$txt"
  done <<< "$HITS"
fi

echo ""
echo -e "${B}───────────────────────────────────────────────────────────────${N}"
echo -e "  ${B}GUIDE — how to read this report:${N}"
echo ""
echo -e "  ${B}FIX (blocking):${N}"
echo -e "    • configDirFor('claude') in generic settings code"
echo -e "    • os.homedir() + '.claude' as a fallback path"
echo -e "    • Any business logic conditioned on a specific provider name"
echo ""
echo -e "  ${B}REVIEW (case-by-case):${N}"
echo -e "    • Help text mentioning specific IDEs"
echo -e "    • Example commands mentioning specific binaries"
echo -e "    • ClaudeProvider references in hook wrappers (these ARE Claude-specific)"
echo -e "    • Test fixtures with hardcoded provider strings (acceptable test data)"
echo -e "    • Auto-detection list in bin/airprompt (list of known providers)"
echo ""

if [ "$COUNT" -eq 0 ]; then
  echo -e "  ${G}${B}PASS${N} — Zero hardcoded provider references in core code."
else
  echo -e "  ${R}${B}NEEDS REVIEW${N} — ${COUNT} reference(s). Review each, fix violations, re-run."
fi
echo ""

[ "$COUNT" -gt 0 ] && exit 1
exit 0
