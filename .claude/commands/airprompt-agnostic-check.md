---
description: DEV-ONLY — Audit codebase for hardcoded provider names in core/agnostic code
argument-hint: ""
---

# /airprompt-agnostic-check — Provider Hardcoding Audit (DEV ONLY)

**NOT SHIPPED TO END USERS. Development-only tool.**

## Rule (ABSOLUTE — NEVER VIOLATED)

No provider name (claude, codex, cursor, windsurf, gemini) shall be hardcoded in any core/agnostic/generic file. Provider-specific strings belong ONLY in provider adapter files (`src/providers/<name>.js`) and provider-specific artifacts (`.claude-plugin/`, `.codex-plugin/`, etc.).

## Execution

Run `bash bin/airprompt-agnostic-check.sh`. Read the full output. Analyze EVERY entry. Fix violations. Re-run.

### Exit codes

- **0** — PASS: zero hardcoded provider names in core/agnostic code
- **1** — NEEDS REVIEW: references found (review each one)

## Output format

Every line is a file:line:text where a provider name was found. Grouped by file for readability.

- **FIX (blocking):** `configDirFor('claude')`, `~/.claude` fallback paths, business logic conditioned on provider name — these must be removed or moved to adapter.
- **REVIEW (case-by-case):** Help text mentioning specific IDEs, example commands, test fixtures with provider strings, auto-detection lists — may be acceptable with justification.

## What this command does

1. Scans ALL source files in the repo (`.js`, `.sh`, `.json`, `.html`, `.css`, `.md`, `.toml`, `.yml`, `Makefile`)
2. Greps for each provider name (case-insensitive)
3. Excludes env var names (`CLAUDE_CONFIG_DIR`, `CLAUDE_PLUGIN_ROOT`, `AIRPROMPT_PROVIDER`)
4. Excludes provider adapter files (`src/providers/<name>.js`), IDE artifacts (`.claude-plugin/`, etc.), documentation (`docs/`)
5. Reports every remaining match with file:line:text

## Exempt from scanning (by design)

- `src/providers/<name>.js` — provider adapters
- `src/hooks/airprompt-activate.js`, `src/hooks/airprompt-deactivate.js` — Claude-specific hook wrappers
- `.claude-plugin/`, `.codex-plugin/`, etc. — IDE-specific plugin manifests
- `.claude/skills/` — Claude-specific skills
- `docs/` — documentation (describes provider architecture)
- `node_modules/`, `.git/` — vendored/external
- `bin/airprompt-agnostic-check.sh` — this script itself

## NEVER

- Never add a "default to claude" fallback in core code
- Never add a provider name to an exemption list just to silence the check
- Never hardcode a provider ID in a new file that isn't a provider adapter
