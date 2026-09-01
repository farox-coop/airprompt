# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-01

First official release.

### Added

- Remote mobile terminal — view and control any tmux-backed IDE/CLI session from the phone (xterm.js web terminal, live session selector).
- Voice dictation — tap-to-dictate with punctuation/formatting macros (Spanish es-AR + English).
- Device pairing — SSH-style device pairing + WebSocket origin check (the daemon is never an open LAN terminal).
- Four providers — Claude Code, Codex, Cursor, Windsurf — via an auto-discovered provider registry.
- Statusline badge — live mobile URL in the Claude Code terminal.
- Adaptive touch scrolling (mouse wheel / viewport / arrow keys by terminal state).
- Shared install preamble, provider detection (`command:`/`dir:`/`macapp:`/`vscode-ext:`), and `resolve-provider` bridge.
- tmux warning banner when running outside tmux; `airprompt status` marks non-tmux sessions red.
- `airprompt update` command; version shown in `airprompt status`.
- `make set-release-tag` release tooling; installers pinned to an immutable release tag.

### Changed

- Hook wrappers resolve the provider from argv (single generic wrapper).
- `install.sh` / `install.ps1` are thin shims delegating to the unified Node installer.
- The installer clone is pinned to the release tag instead of `main`.

[1.0.0]: https://github.com/farox-coop/airprompt/releases/tag/v1.0.0
