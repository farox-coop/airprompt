# AirPrompt — Open Readiness Plan

> Derived from the audit in [REPORT - open readiness.md](<REPORT - open readiness.md>). Read the report for the full findings (blockers, should-fix, provider matrix); this plan sequences those fixes into stages.

> **Status: Phase 1 complete, Phase 2 in progress** — Stages 1.1–2.3 done, all blockers resolved. Stage 2.4 (linter/formatter) and Phase 3 remain.

## How to use this plan

- Work top-down: Phase 1 → Phase 2 → Phase 3.
- Each Stage **is** one atomic commit — do not split further.
- Each Stage lists its suggested commit message, scope (files), and acceptance criteria (how to verify it's done).
- Each Phase ends with a Proposed PR description (3 PRs total).
- Cross-reference: every Stage maps back to the report blockers/findings (see the traceability table at the end).

## Goal per phase

- **Phase 1** — remove the blockers so the coop can start testing. Critical path.
- **Phase 2** — make it easy for coop members to contribute code (PRs, bugfixes, features).
- **Phase 3** — wider platform support and the remaining providers, before going public.

## Dependencies

- Phase 1 is independent. Do it first.
- Phase 2 depends on Phase 1 (a working install + honest scope must exist before people contribute).
- Phase 3 depends on Phase 1 + 2.

---

## Phase 1 — unblock the coop (critical path)

### Stage 1.1 — Security hardening

> **Implementation:** The auth-token piece is redesigned as SSH-style device pairing — detailed in [PLAN - security hardening.md](<PLAN - security hardening.md>).

### Stage 1.2 — Governance + identity

- **Commit message:** `chore(meta): add MIT LICENSE, re-home identity to farox-coop`

Addresses report blockers #3 and #4.

- Files: `LICENSE` (new), `install.sh:8,19`, `install.ps1:7,29`, `bin/install.js:24`, `src/providers/claude.js:30`, `.claude-plugin/marketplace.json:5`, `.claude-plugin/plugin.json:4`, `test/unit/sync.test.sh:27-34`, `README.md:151`.
- Scope:
  - Add `LICENSE` (MIT text, © Farox Software Cooperative).
  - Re-home identity: replace `diegomanuel/airprompt` → `farox-coop/airprompt` and the personal owner URL → `https://farox.coop` across the files; `git remote set-url origin` to the coop repo (deferred to post-commit repo transfer).
- Acceptance: `package.json` `"license": "MIT"` is backed by real text and linked from README; `curl|bash install.sh` clones from the coop org; plugin marketplace URL points at the coop.
- Note: identity re-home is done in code; repo transfer (`git remote set-url origin` to the coop repo) is deferred until after this commit is pushed.

### Stage 1.3 — Docs + install path

- **Commit message:** `docs(readme): working install path + troubleshooting; fix statusline badge in plugin installs`

Addresses the biggest onboarding friction (report "Onboarding / docs" section). The Quick Start currently does not install anything.

- Files: `README.md`, `.claude-plugin/plugin.json`, `src/providers/claude.js`.
- Scope:
  - README Quick Start: lead with `curl -fsSL https://raw.githubusercontent.com/<org>/airprompt/main/install.sh | bash` (or `make setup` if it delegates to the installer).
  - Add Install section (one-liners, `node bin/install.js` flags, what gets created, uninstall), Troubleshooting/FAQ (self-signed cert warning, mic-over-HTTP, "no provider detected", missing tmux/jq/openssl, HTTP fallback), Configuration reference (`AIRPROMPT_*` env vars, `--port`, on-disk layout, cert regeneration, log location), and a Provider status matrix ("Claude Code functional; Codex/Cursor/Windsurf planned").
  - Fix "push-to-talk" → "tap-to-dictate"; document the `airprompt-launch` resume workflow.
  - Statusline badge: wire the StatusLine hook into the plugin manifest (or always wire the standalone statusline) so the badge actually activates for plugin installs.
- Acceptance: a fresh clone following the README verbatim reaches a working `/airprompt on`, with the badge showing.

### Stage 1.4 — Provider scope honesty

- **Commit message:** `fix(providers): de-advertise unimplemented codex/cursor/windsurf`

Addresses report blocker #5. Only `claude` exists; codex/cursor/windsurf are advertised but stubbed.

- Files: `bin/install.js` (`--only` validation message), `bin/airprompt`, `bin/airprompt-attach.sh` (provider hint messages).
- Scope: keep the providers and the detection loops as-is; clarify that codex/cursor/windsurf are not yet implemented (coming soon) in the `--only` error and the "install a provider" hints.
- Acceptance: `--only codex` prints "not yet implemented — coming soon" with the available providers, instead of a bare "unknown agent" error.
- Alternative (bigger): ship the three adapters now — defer to Stage 3.3.

### Proposed PR description — Phase 1

#### Summary

- add SSH-style device pairing + WebSocket Origin check so the daemon is no longer an open terminal on the LAN
- guard Node-side `fs.rmSync` with the same containment rule the shell already enforces
- add MIT LICENSE and re-home repo identity from `diegomanuel` to `farox-coop`
- fix the README so a fresh install actually works (installer-first Quick Start, troubleshooting, provider matrix)
- stop advertising codex/cursor/windsurf until their adapters exist

#### Tasks

- [x] device pairing + WS origin check (unauthenticated WS closed, QR carries server fingerprint)
- [x] node `isSafeRmTarget()` guard on all `fs.rmSync`
- [x] add LICENSE + re-home identity to `farox-coop`
- [x] README install / troubleshooting / env-var / provider matrix
- [x] de-advertise unimplemented providers

#### Notes / Out of Scope

- no Codex/Cursor/Windsurf adapters yet (Phase 3)
- no macOS portability work (Phase 3)
- no CONTRIBUTING/templates (Phase 2)
- no shared secret — the QR carries only a server fingerprint; no multi-user auth model

---

## Phase 2 — contributor-ready (before accepting PRs)

### Stage 2.1 — Contributing + repo governance

- **Commit message:** `docs(contrib): CONTRIBUTING, PR/issue templates, editorconfig, codeowners`

- Files: `CONTRIBUTING.md` (new), `.github/PULL_REQUEST_TEMPLATE.md`, `.github/ISSUE_TEMPLATE/*`, `CODEOWNERS`, `.editorconfig`, `.gitattributes`.
- Scope:
  - `CONTRIBUTING.md`: prerequisites (Node ≥18, tmux, jq, curl), dev run with `AIRPROMPT_DEBUG=1`, `make test-all`, the add-a-provider path (`src/providers/provider.js` interface, `src/providers/registry.js` auto-discovery, `test/unit/provider-interface.test.js` contract test, `agnostic-check` rule), the no-hardcoded-user-paths rule, conventional-commit format. Translate the agent-oriented bits of `CLAUDE.md` into human prose.
  - PR template (test-all checklist, provider-adapter scope, no-hardcoded-paths), bug/feature issue templates, `CODEOWNERS` for review routing, `.gitattributes` (`* text=auto`, `*.sh text eol=lf`), `.editorconfig`.
- Acceptance: a new contributor can set up, test, and submit a change following only `CONTRIBUTING.md`; opening a PR/issue shows a template; shell scripts stay LF.

### Stage 2.2 — Test/CI integrity (silent-skip tests, engines, Node matrix)

- **Commit message:** `ci(test): un-skip silent shell suites, add Node matrix, declare engines.node >=18`

- Files: `test/unit/common.sh` (new), `test/unit/statusline.test.sh`, `test/unit/status-formatter.test.sh`, `test/unit/sync.test.sh`, `.github/workflows/test.yml`, `package.json`.
- Scope:
  - Fix the two silent-skip shell tests: resolve the hook/formatter from the repo root (shared `repo_root()` helper in `test/unit/common.sh`) instead of the deployed path or `$HOME/projects/airprompt`; fail (`exit 1`) rather than silently `exit 0`.
  - Add `"engines": { "node": ">=18" }` to `package.json`.
  - Add a Node version matrix (18/20/24) to `.github/workflows/test.yml`.
- Acceptance: on a fresh clone, `make test-all` genuinely exercises both shell suites (assertions run, not skipped); CI runs on multiple Node versions.
- Deferred (→ Stage 2.3): wiring `agnostic-check` into `test-all`/CI.

### Stage 2.3 — Test/CI integrity (agnostic-check gate)

- **Commit message:** `ci(tests): gate agnostic-check`

- Files: `bin/airprompt-agnostic-check.sh`, `Makefile`.
- Scope:
  - Categorize the current `agnostic-check` report (265 refs / 19 files: test noise, the intentional `bin/` detection loop, a `public/` audit) and add exemptions so the check is green on main.
  - Wire `agnostic-check` into the `test-all` target (CI runs `make test-all`, so this gates it).
- Acceptance: `make test-all` runs `agnostic-check`; a PR hardcoding a provider name in core fails CI.

### Stage 2.4 — Lint/format normalization

- **Commit message:** `chore(lint): add ESLint + shellcheck + Prettier; one-time format pass`

- Files: `package.json`, `Makefile`, `.eslintrc*`/`eslint.config.*` (new), `.prettierrc*` (new), `.shellcheckrc` (new), all source files (format pass).
- Scope:
  - Replace the syntax-only `lint` (`node --check`) with a real linter — ESLint for `.js`, shellcheck for `.sh` (already referenced in `# shellcheck` comments) — wired into `make lint` and `test-all`.
  - Add a formatter (Prettier) aligned with `.editorconfig`.
  - One-time `git add --renormalize .` + format pass, landed as its own "format only, no behavior change" commit so a future 2-line edit no longer churns the whole file.
- Acceptance: `make lint` catches real issues (not just syntax); `make test-all` runs the linter; the repo is formatted consistently; a later edit diffs cleanly (no mass churn).

### Proposed PR description — Phase 2

#### Summary

- add `CONTRIBUTING.md` covering setup, testing, add-a-provider, and conventions
- add PR/issue templates, `CODEOWNERS`, `.editorconfig`, and `.gitattributes` (LF enforcement)
- fix two shell tests that silently skipped on a fresh clone
- declare `engines.node >=18` and add a Node version matrix (18/20/24)
- gate `agnostic-check` in CI (Stage 2.3)
- add a real linter + formatter and normalize the codebase (Stage 2.4)

#### Tasks

- [x] `CONTRIBUTING.md` (prereqs, dev run, `make test-all`, add-a-provider, commit convention)
- [x] PR template + issue templates + `CODEOWNERS` + `.editorconfig` + `.gitattributes`
- [x] fix `statusline.test.sh` / `status-formatter.test.sh` silent-skip
- [x] `engines.node >=18`
- [x] Node version matrix (18/20/24)
- [x] `agnostic-check` into `test-all`/CI
- [ ] real linter + formatter + one-time format pass

#### Notes / Out of Scope

- no feature work — governance + test/CI only

---

## Phase 3 — wider platform (before "anyone can use it")

### Stage 3.1 — macOS portability

- **Commit message:** `fix(portability): macOS support (bash 3.2, pid guard, path resolution, ip detection)`

- Files: `bin/airprompt-clean.sh`, `.claude/skills/sync-claude/sync.sh`, `bin/airprompt-on.sh`, `bin/airprompt-off.sh`, `bin/airprompt-restart.sh`, `bin/airprompt`, `bin/airprompt-launch`, `bin/airprompt-status.sh`, `bin/generate-cert.sh`, `bin/airprompt-attach.sh`.
- Scope: replace `mapfile` with bash-3.2-safe loops; replace the `/proc/$PID/cmdline` guard with `kill -0` + port probe (so `off/clean/restart` kill the daemon on macOS); resolve symlinks via `cd … && pwd -P` instead of `readlink -f`/`realpath`; add an `ipconfig getifaddr` fallback for LAN IP detection.
- Acceptance: `airprompt on/off/clean/restart/status` work on a stock macOS machine; mobile URL shows a real LAN IP.

### Stage 3.2 — Install robustness

- **Commit message:** `fix(install): vendor xterm, document node-pty, gitignore certs, normalize timeouts`

- Files: `public/` (vendor xterm), `README.md`, `.gitignore`, `bin/lib/protocol.sh`, `src/providers/claude.js`, `.claude-plugin/plugin.json`, `bin/lib/autostart.js`, `src/install-helpers.js`.
- Scope: vendor xterm.js + xterm-addon-fit locally (drop the CDN dependency); document node-pty build tools (python3/make/g++) in Requirements; add `*.pem`, `*.key`, `*.pid`, `.airprompt/` to `.gitignore`; normalize hook timeouts (10/5 vs 10000); make the `jq` check cross-platform (no hardcoded `sudo apt`).
- Acceptance: LAN-only phone renders the terminal; fresh-machine install succeeds without undocumented build tools; a mispointed env var can't commit a private key.

### Stage 3.3 — Ship remaining providers (codex/cursor/windsurf)

- **Commit message:** `feat(providers): codex, cursor, windsurf adapters`

- Files: new `src/providers/codex.js`, `src/providers/cursor.js`, `src/providers/windsurf.js`; re-enable detection loops; per-provider hook wiring + tests.
- Scope: implement the three adapters against the `provider.js` interface (the contract test `test/unit/provider-interface.test.js` validates each automatically); implement `macapp:`/`vscode-ext:` detection for GUI installs.
- Acceptance: `--only codex` installs and wires hooks; a Codex session auto-registers and gets the mobile URL + badge.
- Note: reverse of Stage 1.4 — re-advertise each provider only when its adapter lands.

### Stage 3.4 — Release hygiene

- **Commit message:** `chore(release): tags, changelog, gui detection probes, vscode docs`

- Files: `package.json`, `CHANGELOG.md` (new), `Makefile`, `src/providers/claude.js`.
- Scope: tag releases + CHANGELOG; implement `macapp:`/`vscode-ext:` probes in `claude.js` detection; document the VS Code no-`$TMUX` limitation (phone attaches to an empty mirror shell).
- Acceptance: versioned releases exist; detection covers GUI installs; VS Code behavior is documented, not surprising.

### Proposed PR description — Phase 3

#### Summary

- add macOS support (bash 3.2, PID guard, path resolution, LAN IP detection)
- vendor xterm.js, document node-pty build tools, harden `.gitignore`, normalize hook timeouts
- ship Codex/Cursor/Windsurf provider adapters
- release hygiene: version tags, CHANGELOG, GUI detection probes, VS Code docs

#### Tasks

- [ ] macOS portability fixes
- [ ] install robustness (vendor xterm, node-pty docs, `.gitignore`, timeouts)
- [ ] codex/cursor/windsurf adapters + detection
- [ ] release hygiene (tags, changelog, gui probes, vscode doc)

#### Notes / Out of Scope

- Codex/Cursor/Windsurf adapters are large — consider one PR per provider if needed
- no multi-user auth model; per-device keypairs, no shared secret

---

## Traceability — stage → report

| Stage | Report blockers / findings |
|---|---|
| 1.1 | Blockers #1 (zero auth → LAN RCE) + #2 (Node `fs.rmSync` unguarded) |
| 1.2 | Blockers #3 (no LICENSE) + #4 (personal identity) |
| 1.3 | Onboarding/docs section + statusline badge missing |
| 1.4 | Blocker #5 (only `claude` provider) |
| 2.1 | Contributor/PR readiness section |
| 2.2 | Test/CI integrity section (silent-skip tests + engines) |
| 2.3 | Test/CI integrity section (agnostic-check gate) |
| 2.4 | Polish/later section (lint is syntax-only) |
| 3.1 | macOS breaks section |
| 3.2 | Portability/install correctness section |
| 3.3 | Provider readiness matrix (Codex/Cursor/Windsurf) |
| 3.4 | Polish/later section |

## Final checklist (one item per stage)

- [x] 1.1 Security hardening (device pairing + WS origin + Node rm guard)
- [x] 1.2 Governance + identity (LICENSE + re-home)
- [x] 1.3 Docs + install path (README + statusline badge)
- [x] 1.4 Provider scope honesty
- [x] 2.1 Contributing + repo governance
- [x] 2.2 Test/CI integrity (silent-skip tests + engines)
- [x] 2.3 Test/CI integrity (agnostic-check gate)
- [ ] 2.4 Lint/format normalization
- [ ] 3.1 macOS portability
- [ ] 3.2 Install robustness
- [ ] 3.3 Ship remaining providers
- [ ] 3.4 Release hygiene
