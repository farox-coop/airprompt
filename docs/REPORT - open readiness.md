# AirPrompt — Open Readiness Audit

Snapshot: 2026-08-18. Deep audit across 7 dimensions (architecture, providers, docs, security, portability, tests/CI, contributor-readiness) to assess readiness for opening to the Farox coop, then later the public.

> Implementation plan (stages + commits): [PLAN - open readiness.md](<PLAN - open readiness.md>)

> **Status: Phases 1 and 2 complete, Stage 3.1 done** — all 5 blockers resolved, plus contributor governance (CONTRIBUTING, PR/issue templates, CODEOWNERS, editorconfig, gitattributes), test integrity (silent-skip shell tests fixed, `engines.node >=20`, Node matrix, agnostic-check + format-check gated in `test-all`, ESLint + shellcheck + Prettier wired), and macOS portability (bash 3.2, portable PID guard, path resolution, LAN IP). Phase 3 remains: Stages 3.2–3.4.

## Verdict

Solid single-user PoC, ~70% ready for a trusted coop. Not yet for the coop's non-Claude users, not yet for public. 5 hard blockers, ~12 should-fix, rest polish.

Code quality is genuinely good: clean architecture (provider registry + extracted modules), 958 passing tests (`make test-all` green, verified), real CI, consistent conventional commits, no hardcoded `/home/` in production, shell `rm -rf` guarded, no shell-injection (array-form spawns), 0 known `npm audit` vulnerabilities. The gaps are almost all governance, docs, identity, and one security hole — not code rot.

## Blockers (must fix before inviting the coop)

| #   | Issue                                  | Where                                                                                                                                          | Why it blocks                                                                                                                                                                                                            |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Zero auth on daemon → LAN RCE          | `server.js:156-163,637` binds `0.0.0.0`, no token/Origin check                                                                                 | Any device on the shared network gets interactive terminal as the dev user + session-kill + notification spoofing. The "nuke the machine" class. ~30 lines to fix: random token + require on REST/WS + Origin allowlist. |
| 2   | Node-side `fs.rmSync` unguarded        | `server.js:113,125`, `activate.js:161`, `deactivate.js:185`                                                                                    | Shell has `_safe_rm_rf`, Node has no equivalent. Misconfigured `AIRPROMPT_SESSIONS_DIR=/home` → daemon `rm -rf`'s arbitrary dirs on startup recovery.                                                                    |
| 3   | No `LICENSE` file                      | repo root                                                                                                                                      | `package.json` says MIT, README names Farox, but no license text = all-rights-reserved. Blocks coop AND public.                                                                                                          |
| 4   | Personal identity hardcoded everywhere | `install.sh:19`, `bin/install.js:24-25,151`, `src/providers/claude.js:29`, `.claude-plugin/marketplace.json:5`, `.claude-plugin/plugin.json:4` | `diegomanuel/airprompt` drives clone + plugin-install + issue links. Repo move to `farox-coop` breaks every fresh install until these are updated.                                                                       |
| 5   | Only `claude` provider exists          | `src/providers/` = claude.js + provider.js + registry.js                                                                                       | codex/cursor/windsurf advertised in dispatcher + installer + help, but `--only codex` → `error: unknown agent: codex`. Codex users hit a hard wall.                                                                      |

## Should-fix before/with the coop rollout

### Onboarding / docs (single biggest friction source)

- Quick Start does not install. `make setup` (Makefile:6-11) = `npm install` + cert only. No plugin, no `/airprompt` command, no hooks. README:44-56 never points at the real installer (`install.sh` / `node bin/install.js`). Fresh user hits "unknown command /airprompt". Fix: Quick Start → `curl|bash install.sh`, or make `setup` delegate to `install.js`.
- No Install section, no one-liners, no troubleshooting. `install.sh`/`install.ps1` exist but README never mentions them. No FAQ for the top first-run failures (self-signed cert on Android, mic-over-HTTP, "no provider detected", missing tmux/jq/openssl). Docs scored ~60-70% ready.
- Env vars + disk layout undocumented. `AIRPROMPT_PORT/DEBUG/STATE_DIR/SESSIONS_DIR/NO_TLS/PID_FILE` and `~/.airprompt/{state,sessions}` + `/tmp/airprompt.log` nowhere in README.
- Statusline badge missing in default plugin install. `.claude-plugin/plugin.json` wires only SessionStart+Stop; standalone `statusLine` wiring is skipped when plugin install succeeds (`claude.js:128-140,483`). README advertises the badge; it does not activate.

### macOS breaks (if any coop friend is on a Mac)

> Resolved in Stage 3.1 — macOS portability shipped; awaiting real-Mac validation from a coop member.

- ~~`mapfile` (bash ≥4) in `clean.sh:61`, `sync.sh:26` — macOS bash 3.2 aborts `clean`, leaving orphans.~~ → `while read` loop.
- ~~`/proc/$PID/cmdline` PID guard (`on.sh:91`, `off.sh:141`, `clean.sh:33`, `restart.sh:50`) — skipped on macOS, so `off/clean/restart` never kill the daemon.~~ → portable `ps -p $PID -o command=`.
- ~~`readlink -f` / `realpath` (`bin/airprompt:10`, `launch:93`) — absent on macOS ≤12, breaks the main dispatcher.~~ → `cd && pwd -P` symlink walk.
- ~~`hostname -I` (Linux-only) — mobile URL + cert SAN degrade to `localhost` on macOS.~~ → `ipconfig getifaddr` fallback.

Bottom line: Linux/WSL ready, macOS supported (pending real-Mac validation), native Windows unsupported (despite `install.ps1`).

### Portability / install correctness

- `~/projects/airprompt` hardcoded fallback (`bin/airprompt:41,74`, `provider.js:95`, `resolveInstallDir`) — clones elsewhere fail "scripts not found".
- `node-pty` native build tools (python3/make/g++) not in Requirements — clean-machine `npm install` fails.
- xterm.js from jsdelivr CDN (`index.html:10-12`) — LAN-only phone = blank UI. Vendor it.
- Hook timeout unit inconsistency: `10/5` (claude.js, plugin.json) vs `10000` (`autostart.js`) — 1000×, needs normalizing.
- `.gitignore` missing `*.pem`, `*.key`, `*.pid`, `.airprompt/` — a mispointed env var could commit a private key.

### Contributor/PR readiness

- ~~No `CONTRIBUTING.md`, no PR/issue templates, no `CODEOWNERS`, no `.editorconfig`/`.gitattributes` (CRLF risk for shell scripts).~~ — resolved in Stage 2.1.
- Two shell tests silently skip on a fresh clone: `statusline.test.sh:5-7`, `status-formatter.test.sh:5-8` (one hardcodes `$HOME/projects/airprompt`) → green CI that tested nothing.
- ~~`agnostic-check` (the repo's own "no provider names in core" guard) is dev-only, not in `test-all`/CI — a PR can violate the architecture rule and stay green.~~ — resolved in Stage 2.3 (wired into `test-all`).
- ~~No `engines` field (Node ≥18 enforced only at install time); CI single Node 24, no matrix.~~ — resolved in Stage 2.2 (`engines.node >=18` + Node matrix 18/20/24).

## Polish / later

- Version tags + CHANGELOG (empty `git tag`, package.json 0.2.0) — commit convention now documented in `CONTRIBUTING.md` (Stage 2.1).
- `macapp:`/`vscode-ext:` detection probes claimed in `claude.js:238` but unimplemented (needed for future Cursor/Windsurf GUI detection).
- ~~Lint = syntax-only `node --check`; no real linter.~~ — resolved in Stage 2.4 (ESLint + shellcheck + Prettier).
- VS Code integrated terminal (no `$TMUX`) → phone attaches to an empty mirror shell, not the live Claude UI. Only works via `airprompt-launch`/`attach.sh`. Document this clearly.
- Rate-limiting on `/api/notify`; ANSI-injection in DEBUG `cwd` logging (`server.js:150,223`).
- `install.sh:112-132` `jq` check hardcodes `sudo apt install jq` (wrong for macOS/Windows).

## Provider readiness matrix

| Provider                      | Ready?       | Notes                                                                                      |
| ----------------------------- | ------------ | ------------------------------------------------------------------------------------------ |
| Claude Code (standalone/tmux) | ✅ Ready     | Full install, hooks, badge, lifecycle, tested. Caveat: run inside tmux for true mirroring. |
| Claude in VS Code             | ⚠️ Partial   | Registers, but no `$TMUX` → phone gets empty shell, not the live session.                  |
| Codex                         | ❌ Not ready | Zero adapter. `--only codex` hard-errors. No hooks/badge.                                  |
| Cursor                        | ❌ Not ready | Same + GUI detection unimplemented.                                                        |
| Windsurf                      | ❌ Not ready | Same as Codex.                                                                             |

Recommendation: start the coop test with Claude-using friends only. Tell Codex/Cursor/Windsurf folks "coming later" — or that they need the `airprompt-launch --provider` manual path (incomplete). Honest scope beats a broken first impression.

## Work plan

High-level summary only. The full staged/commit breakdown lives in [PLAN - open readiness.md](<PLAN - open readiness.md>).

### Phase 1 — unblock the coop (this week)

- [x] Auth token + WS Origin check (`server.js`) — the RCE hole.
- [x] Node-side `isSafeRmTarget()` guard for all `fs.rmSync`.
- [x] Add `LICENSE` (MIT, Farox Software Cooperative).
- [x] Re-home identity: `diegomanuel/airprompt` → `farox-coop/airprompt` in code + manifest URLs (git remote set-url deferred to post-commit repo transfer).
- [x] Fix README: working Quick Start, Install section (one-liners), Troubleshooting, provider matrix ("Claude only today"), env-var reference.
- [x] Either ship or de-advertise codex/cursor/windsurf (clarify "not yet implemented — coming soon" in `--only` + provider hints; detection loops left as-is).

### Phase 2 — contributor-ready (before accepting PRs)

- [x] `CONTRIBUTING.md` (prereqs, dev run with `AIRPROMPT_DEBUG=1`, `make test-all`, add-a-provider path, no-hardcoded-paths rule, commit convention).
- [x] PR + issue templates, `.editorconfig`, `.gitattributes`, `CODEOWNERS`.
- [x] Fix the 2 silent-skip shell tests (resolve from repo root, fail instead of `exit 0`).
- [x] `engines` field (`node >=20`).
- [x] Node CI matrix (20/22/24).
- [x] Wire `agnostic-check` into `test-all`/CI (now gated; scanner narrowed to tracked code files).
- [x] Real linter (ESLint + shellcheck) + formatter (Prettier); `format-check` gated in `test-all`.

### Phase 3 — wider platform (before "anyone can use it")

- [x] macOS fixes (`mapfile`, `/proc` guard, `pwd -P` resolution, `ipconfig getifaddr`).
- [ ] Vendor xterm.js; document node-pty build tools; `.gitignore` cert hardening; timeout normalization.

---

Method: 7 independent read-only audits (architecture, providers, docs, security, portability, tests/CI, contributor-readiness). Findings are point-in-time; line numbers may drift as the code moves.
