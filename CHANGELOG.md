# Changelog

Release notes for AirPrompt, newest first. Each entry mirrors the [GitHub release](https://github.com/farox-coop/airprompt/releases) body: a one-line summary, then **Highlights**, plus **Install** / **Notes** / **Known limitations** where they apply. Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-10-09

Attach images from your phone, plus a watchdog for flaky WiFi.

### Highlights

- **Attach images from the phone** — the 📎 button opens the gallery/camera picker, 📋 pulls an image from the clipboard where the browser allows it, and on desktop you can paste or drop a file straight onto the terminal. The daemon stores it under `~/.airprompt/uploads/<provider>-<sessionId>/` and types the absolute path into the session as a backticked code span, so a CLI that reads images from a path (**Claude Code**) sees your screenshot with no manual transfer to the host.
- **Token-gated uploads** — `/api/upload` is reachable from the LAN but authenticated by a single-use, device-bound token minted over the paired WebSocket. Images only (PNG/JPEG/WebP/GIF), capped at 25 MB by default, and downscaled to a 1568px long edge before upload — toggle it in the ⚙ preferences.
- **Self-cleaning** — the previous turn's uploads are released when you submit your next prompt and reaped after a 10-minute grace window (so a slow turn can still read them), never-submitted files expire after 24 h, and a session's uploads go with the session (`airprompt off`, `airprompt clean`, or its tmux session ending).
- **Dead-connection watchdog** — the web client detects half-open WebSocket connections (stale on flaky WiFi) with an app-level ping/pong probe and force-reconnects, falling back to a page reload for wedged sockets.

### Notes

- **Upload cleanup is time-based, not read-based** — the daemon cannot see when a CLI actually reads a file, so the grace window is what keeps a slow turn working while still letting nothing accumulate. Tune it with `AIRPROMPT_UPLOAD_GRACE_MS`, `AIRPROMPT_UPLOAD_TTL_MS` and `AIRPROMPT_UPLOAD_MAX_BYTES`.
- **A `$HOME` (or `AIRPROMPT_UPLOADS_DIR`) containing spaces** makes the typed path ambiguous for the CLI — filenames themselves are always sanitized.
- **Clipboard reads depend on the source app** — some Android galleries never put the image on the clipboard; when that happens 📋 says so rather than failing silently. 📎 picks a file directly and always works.

### Hardening

- **`SECURITY.md`** — the threat model, the accepted risks and a private route to report a vulnerability are now documented. Please report security issues privately, never in a public issue.
- **Security headers and honest errors** — the daemon sends a Content-Security-Policy, `X-Content-Type-Options`, `X-Frame-Options` and `Referrer-Policy`, no longer advertises `X-Powered-By`, and answers malformed requests with JSON instead of an HTML stack trace that exposed absolute paths.
- **Daemon log is created `0600`** instead of world-readable.
- **Installer Node guard fixed** — `install.sh` and `install.ps1` accepted Node 18/19 even though ≥ 20 is required; they now check 20 up front.

### Install

```bash
curl -fsSL https://raw.githubusercontent.com/farox-coop/airprompt/v1.1.0/install.sh | bash
```

## [1.0.0] - 2026-09-01

Remote control + voice dictation for your IDE/CLI sessions, straight from your phone over the local network. Works with **Claude Code, Codex, Cursor, and Windsurf**.

### Highlights

- **Remote mobile terminal** — view and control any tmux-backed session from the phone (xterm.js web terminal, live session selector).
- **Voice dictation** — tap-to-dictate with punctuation/formatting macros; Spanish (es-AR, incl. voseo) + English.
- **Four providers** — Claude Code, Codex, Cursor, Windsurf, via an auto-discovered provider registry (one file per IDE).
- **Device pairing** — SSH-style device pairing + WebSocket origin check; the daemon is never an open LAN terminal.
- **Statusline badge** — live mobile URL right in the Claude Code terminal.
- **Adaptive touch scrolling** — mouse wheel / viewport / arrow keys, depending on terminal state.
- **Cross-platform** — Linux, macOS, WSL (bash 3.2-compatible). Windows: CLI-only (daemon needs tmux).
- **Release tooling** — `make set-release-tag`, `airprompt update`, `CHANGELOG.md`, tag-pinned installers.

### Install

```bash
curl -fsSL https://raw.githubusercontent.com/farox-coop/airprompt/v1.0.0/install.sh | bash
```

### Known limitations

- **Windows** — CLI-only install (terminal mirroring needs tmux).
- **VS Code** — the phone attaches to a mirror shell, not the live editor pane (no `$TMUX`); use `airprompt-launch` to run inside tmux.
- **Windsurf** — no session-end hook, so the daemon runs until `airprompt off`/`airprompt clean`/reboot.

---

**Read more:** [README.md](https://github.com/farox-coop/airprompt/blob/v1.0.0/README.md) — full setup, provider matrix, troubleshooting, and configuration reference.

[Unreleased]: https://github.com/farox-coop/airprompt/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/farox-coop/airprompt/releases/tag/v1.1.0
[1.0.0]: https://github.com/farox-coop/airprompt/releases/tag/v1.0.0
