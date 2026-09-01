# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-01

### Added

- Codex, Cursor, and Windsurf provider adapters — install/uninstall with idempotent hook wiring and non-clobber of pre-existing hooks.
- Shared install preamble (`src/providers/install-common.js`).
- Shared provider detection (`command:`/`dir:`/`macapp:`/`vscode-ext:` probes).
- `resolve-provider` bridge and provider-agnostic `airprompt off`.
- tmux warning banner when running outside tmux; `airprompt status` marks non-tmux (MIRROR) sessions red.
- `airprompt update` command; version shown in `airprompt status`.
- `make set-release-tag` release tooling; installers pinned to an immutable release tag.

### Changed

- Hook wrappers now resolve the provider from argv (single generic wrapper).
- `install.sh` / `install.ps1` are thin shims delegating to the unified Node installer.
- `install.sh`, `install.ps1`, and the installer clone are pinned to the release tag instead of `main`.

[1.0.0]: https://github.com/farox-coop/airprompt/releases/tag/v1.0.0
