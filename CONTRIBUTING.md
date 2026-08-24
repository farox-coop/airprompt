# Contributing to AirPrompt

Thanks for helping build AirPrompt. This document covers how to set up a dev environment, run the tests, add a new provider, and follow the conventions the project expects.

## Prerequisites

- **Node.js ≥ 20** — the installer enforces this at startup.
- **tmux** — required for terminal mirroring. `sudo apt install tmux` (macOS: `brew install tmux`).
- **jq** — daemon protocol detection and notifications. `sudo apt install jq`.
- **curl** — API communication with the daemon.
- **openssl** — TLS certificate generation for HTTPS voice dictation.
- **reptyr** (optional) — only for `airprompt-attach.sh`, which attaches a running process to tmux.

Base setup additionally needs `build-essential` and `python3` on Linux to compile the `node-pty` native dependency during `npm install` (see CI in `.github/workflows/test.yml`).

## Setup

```bash
git clone https://github.com/farox-coop/airprompt.git
cd airprompt
make setup     # npm install + self-signed TLS cert
```

Run scripts with debug output during development:

```bash
AIRPROMPT_DEBUG=1 airprompt <command>
```

Never call the `bin/airprompt-*.sh` scripts directly — always go through the `airprompt` dispatcher.

## Testing

```bash
make test-all
```

`test-all` runs lint, unit, and integration. Breakdown:

| Target | What it runs |
|---|---|
| `make lint` | `eslint` over every `.js` file + `shellcheck` over `.sh` (shellcheck skipped if not installed) |
| `make test-unit` | `node --test test/unit/*.test.js` + the three shell suites |
| `make test-integration` | `bash test/integration/run.sh` |
| `make agnostic-check` | the provider-agnosticism audit (see below) |

`make format` runs `prettier --write` (one-time reformat), `make format-check` runs `prettier --check` to verify formatting.

Tests are isolated from any real daemon. Unit tests use `createApp()` (a fresh server, no PID file). Integration tests use port 3211 and `/tmp/airprompt-server-test.pid`. Tmux sessions are prefixed `airprompt-test-*` / `airprompt-integtest-*` and never touch real sessions. Do not change a failing test to make it pass — fix the production code, unless the production code itself changed and the test expectation is now wrong.

## Adding a provider

Providers live in `src/providers/`. The registry auto-discovers every `*.js` file there (skipping `provider.js` and `registry.js`), so adding a provider is one file — no edits to core code.

1. Read the `Provider` contract in `src/providers/provider.js` (JSDoc typedefs + shared path utilities).
2. Create `src/providers/<name>.js` implementing the contract: `id`, `label`, `mech`, `detect`, `profile`, `hookEvents`, `commandPrefix`, the `configDir()`/`sessionsDir()`/`hooksDir()`/… path resolvers, `detectMatch()`, `parseHookStdin()`/`formatHookOutput()`, `buildHookEntry()`, `install()`/`uninstall()`, and the `get*Files()` manifests.
3. `test/unit/provider-interface.test.js` auto-discovers your provider and validates every required property and method — no new test file needed. Run `make test-unit`.
4. Keep core/agnostic code free of provider names. `make agnostic-check` enforces this: no hardcoded `claude`, `codex`, `cursor`, etc. outside provider adapters, IDE-specific plugin dirs, and `docs/`. If your adapter needs provider-specific artifacts (e.g. `.codex-plugin/`), add that directory to the exemption list in `bin/airprompt-agnostic-check.sh`.

Do not re-advertise a provider in the CLI hints or the `--only` validator until its adapter actually ships.

## Conventions

- **No hardcoded user paths.** AirPrompt runs for any user. Never hardcode a user-specific absolute path. Shell scripts use `$HOME` / `$CLAUDE_CONFIG_DIR`; Node uses `os.homedir()` / `process.env.HOME` / `process.env.CLAUDE_CONFIG_DIR`; docs use `~` / `$HOME`. Config values (port, pid file, state dir) come from `AIRPROMPT_*` env vars, never a literal.
- **Extract, don't bloat.** When a file grows too many responsibilities, split it into a focused module (see the project's `CLAUDE.md` for the pattern). Smaller focused files over one giant file.
- **Commits** use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `ci:`. One atomic change per commit.
- **Language**: production code, tests, and commits are in English. Documentation follows the same language as the surrounding `.md` file.
