# AirPrompt — Open Readiness Plan

> Derived from the audit in [REPORT - open readiness.md](<REPORT - open readiness.md>). Read the report for the full findings (blockers, should-fix, provider matrix); this plan sequences those fixes into stages.

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

> **Implementation:** The auth-token piece is redesigned as SSH-style device pairing — detailed in [PLAN - Security hardening.md](<PLAN - Security hardening.md>).

### Stage 1.2 — Governance + identity

- **Commit message:** `chore(meta): add MIT LICENSE, re-home identity to farox-coop`

Addresses report blockers #3 and #4.

- Files: `LICENSE` (new), `install.sh:19`, `bin/install.js:24-25,151`, `src/providers/claude.js:29`, `.claude-plugin/marketplace.json:5`, `.claude-plugin/plugin.json:4`.
- Scope:
  - Add `LICENSE` (MIT text, © Farox Software Cooperative).
  - Re-home identity: replace `diegomanuel/airprompt` and the personal owner URL with the coop org across the 5 files; `git remote set-url origin` to the coop repo.
- Acceptance: `package.json` `"license": "MIT"` is backed by real text and linked from README; `curl|bash install.sh` clones from the coop org; plugin marketplace URL points at the coop.
- Note: the identity re-home is gated on the coop-org/repo-move decision. If the initial private test stays on `diegomanuel/airprompt` (friends with repo access), defer the re-home to Phase 2; LICENSE itself is always required.

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

- Files: `bin/airprompt`, `bin/airprompt-attach.sh`, `src/hooks/airprompt-statusline.sh`, `bin/lib/protocol.sh`, `.claude/skills/sync-claude/sync.sh`, `bin/airprompt-clean.sh`, `src/providers/claude.js` (the hardcoded detection loops), `bin/install.js` (`--only` validation message).
- Scope: restrict provider detection/listing to implemented providers only (derive from the registry where possible); replace the `error: unknown agent: codex` path with a clear "provider not yet implemented" message.
- Acceptance: a machine with only `codex` on PATH no longer silently selects `codex`; `--only codex` prints an honest message instead of a bare error.
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
- [ ] add LICENSE + re-home identity to `farox-coop`
- [ ] README install / troubleshooting / env-var / provider matrix
- [ ] de-advertise unimplemented providers

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

### Stage 2.2 — Test/CI integrity

- **Commit message:** `ci(tests): fix silent-skip shell tests, gate agnostic-check, node matrix`

- Files: `test/unit/statusline.test.sh`, `test/unit/status-formatter.test.sh`, `Makefile`, `.github/workflows/test.yml`, `package.json`.
- Scope:
  - Fix the two silent-skip shell tests: resolve the hook/formatter from the repo root (`dirname "$0"` / `git rev-parse --show-toplevel`) instead of the deployed path or `$HOME/projects/airprompt`; fail rather than silently `exit 0`.
  - Wire `agnostic-check` into `test-all` and the CI gate; add `"engines": { "node": ">=18" }`; add a Node version matrix (18/20/24).
- Acceptance: on a fresh clone, `make test-all` genuinely exercises both shell suites; a PR hardcoding a provider name in core fails CI; CI runs on multiple Node versions.

### Proposed PR description — Phase 2

#### Summary

- add `CONTRIBUTING.md` covering setup, testing, add-a-provider, and conventions
- add PR/issue templates, `CODEOWNERS`, `.editorconfig`, and `.gitattributes` (LF enforcement)
- fix two shell tests that silently skipped on a fresh clone
- enforce `agnostic-check` in CI, declare `engines.node >=18`, and add a Node version matrix

#### Tasks

- [ ] `CONTRIBUTING.md` (prereqs, dev run, `make test-all`, add-a-provider, commit convention)
- [ ] PR template + issue templates + `CODEOWNERS` + `.editorconfig` + `.gitattributes`
- [ ] fix `statusline.test.sh` / `status-formatter.test.sh` silent-skip
- [ ] `agnostic-check` into `test-all`/CI + `engines` + Node matrix

#### Notes / Out of Scope

- no feature work — governance + test/CI only
- real linter deferred to Phase 3 (lint is syntax-only today)

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

- **Commit message:** `chore(release): tags, changelog, linter, gui detection probes, vscode docs`

- Files: `package.json`, `CHANGELOG.md` (new), `Makefile`, `src/providers/claude.js`.
- Scope: tag releases + CHANGELOG; add a real linter (or document that lint is syntax-only today); implement `macapp:`/`vscode-ext:` probes in `claude.js` detection; document the VS Code no-`$TMUX` limitation (phone attaches to an empty mirror shell).
- Acceptance: versioned releases exist; detection covers GUI installs; VS Code behavior is documented, not surprising.

### Proposed PR description — Phase 3

#### Summary

- add macOS support (bash 3.2, PID guard, path resolution, LAN IP detection)
- vendor xterm.js, document node-pty build tools, harden `.gitignore`, normalize hook timeouts
- ship Codex/Cursor/Windsurf provider adapters
- release hygiene: version tags, CHANGELOG, linter, GUI detection probes, VS Code docs

#### Tasks

- [ ] macOS portability fixes
- [ ] install robustness (vendor xterm, node-pty docs, `.gitignore`, timeouts)
- [ ] codex/cursor/windsurf adapters + detection
- [ ] release hygiene (tags, changelog, linter, gui probes, vscode doc)

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
| 2.2 | Test/CI integrity section |
| 3.1 | macOS breaks section |
| 3.2 | Portability/install correctness section |
| 3.3 | Provider readiness matrix (Codex/Cursor/Windsurf) |
| 3.4 | Polish/later section |

## Final checklist (one item per stage)

- [x] 1.1 Security hardening (device pairing + WS origin + Node rm guard)
- [ ] 1.2 Governance + identity (LICENSE + re-home)
- [ ] 1.3 Docs + install path (README + statusline badge)
- [ ] 1.4 Provider scope honesty
- [ ] 2.1 Contributing + repo governance
- [ ] 2.2 Test/CI integrity
- [ ] 3.1 macOS portability
- [ ] 3.2 Install robustness
- [ ] 3.3 Ship remaining providers
- [ ] 3.4 Release hygiene
