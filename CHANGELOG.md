# Changelog

Release notes for AirPrompt, newest first. Each entry mirrors the [GitHub release](https://github.com/farox-coop/airprompt/releases) body: a one-line summary, then **Highlights**, plus **Install** / **Notes** / **Known limitations** where they apply. Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

A launched session keeps the tmux identity of the pane it runs in, and `airprompt off` can name the session it tears down. `airprompt-launch --name` now names the CLI's own session too. A notification can show the session's context size instead of a message count.

### Highlights

- **A notification can show how full the session's context is** — `airprompt-session-tokens.js` is now installed beside the other hooks: given an agent's session log it prints the session's current context size (`125k`, rounded exactly like the statusline badge) and prints nothing when that provider's log has no such record. Claude's notification hook reads the transcript's newest usage entry, so `turn_info` became `4.0s — 125k` in place of the turn's message count — which said little and, unlike the token count, existed for one agent only. A compaction is handled explicitly: `/compact` ends its turn with no assistant message after the boundary, so the boundary's own `postTokens` is reported instead (a session that compacted from 284k to 20k shows `20k`, not a context that no longer exists). The helper also reads Codex rollouts (`last_token_usage.input_tokens` — the prompt that request re-sent, never the cumulative total); Cursor and Windsurf have no notification hook wired yet, so they show no badge either — never a made-up number.
- **A session started by `airprompt-launch` is recognised as the session it is** — the launcher hands the pane's own `TMUX`, `TMUX_PANE` and `TERM` to the IDE while still clearing the tmux server's environment, so a launch that happens inside a pane no longer registers as a mirror under the IDE's session id, spawns a second tmux session, or leaves `airprompt off` unable to find it. Resuming also stops replacing a live pane, and no marker is filed for a session that does not exist.
- **`--name` now names the CLI's own session too** — `airprompt-launch --name <name>` already named the AirPrompt marker (and the tmux session on a fresh launch); where the IDE has a name flag of its own it now receives the same name, so at launch the name the CLI shows in its prompt box, its `/resume` picker and the terminal title is the same one the phone displays (renaming later with `/airprompt name` updates only the AirPrompt side). The flag is declared per provider (`sessionNameFlag` in `src/providers/*.js`; `-n` for Claude Code, `null` for the others until verified), and `AIRPROMPT_IDE_NAME_FLAG` overrides it either way — set it empty to disable the forwarding.

### Fixes

- **A stale tmux server environment no longer reaches a session.** tmux keeps one environment for the whole server — the one of whichever client happened to start it — and every session created afterwards starts from a copy of that, so a variable belonging to some other launch (a per-project git scope, a port, a Docker project name, a token meant for one session) reached the IDE anyway, silently, and outlived whatever set it. The launcher now passes the environment with `env -i`, so a session's environment is the launching shell's, which is what forwarding the environment has to mean. `TMUX`, `TMUX_PANE` and `TERM` are handed back explicitly: tmux injects all three into the pane's process, so clearing the environment wholesale took the only copy with it and the IDE — correctly inside a pane — reported itself as outside tmux, and addressed a terminal it was not sitting in (`TERM` inside a pane has to name what tmux emulates, not the emulator outside it). That also made `airprompt off` a no-op, and left the session registering again — as a mirror keyed on the IDE's session id by its own start hook, rather than on the tmux session it was actually running in. They are also dropped from the forwarded set, since a launcher that is itself running inside tmux carries the _outer_ session's pair, and forwarded variables are applied after the handed-back ones.
- **`airprompt off` can name the session it tears down.** The dispatcher ran `airprompt-off.sh` through its catch-all branch, which passed no arguments, so the sessionId that script reads from `$1` never arrived: `airprompt off <sessionId>` quietly degraded to "unregister the current session", and the current session is worked out from `$TMUX`. A session that had lost `$TMUX` therefore could not be unregistered with `airprompt off` — the command reported "nothing to unregister (already off)" and left it registered. `off` now forwards its arguments like the other argument-taking commands, and `airprompt off` on its own still means the current session. Naming a session also resolves _that_ session's local markers, so tearing down another one no longer removes the caller's.
- **No marker is written for a resume target, or for a pane whose session cannot be resolved, that turns out not to be a tmux session.** Two paths did. `airprompt-launch --resume <id>` accepts either a tmux session name or the IDE's own session id, and it wrote a marker before deciding which — so resuming by id left a directory whose `tmux` file named something that can never exist. And the "already inside tmux" path marked whatever `tmux display-message` returned, so a launcher inheriting a `TMUX` whose server is gone filed a directory under the `airprompt-unknown` fallback. Both now mark only a session that actually exists; the sweep no longer has that junk to reap.
- **Resuming a session respawns its _dead_ pane.** The launcher replaced the session's _active_ pane instead, so in a session holding a dead pane and a live one — a split, with `remain-on-exit` on — and with the live pane active, the live one was replaced, killing the process the user was returning to.
- **`--resume` and `--name` reject an operand that is empty or is itself a flag.** An empty `--resume` silently started a fresh session instead — no resume, no complaint, and one nobody asked for — and `--name --resume x` took the flag _as_ the name, destroying the argument the user did type.
- **The CLI commands work on macOS again.** On plain HTTP — the default — `airprompt on|off|name|restart|status` aborted under macOS `/bin/bash` 3.2 with `AP_CURL_OPTS[@]: unbound variable`, because an empty array counts as unset with `set -u` before bash 4.4. Every expansion is now guarded, and `airprompt-launch` too (an empty argument list aborted a launch outright).
- **The installer repairs a plugin record whose cache directory is gone, and installs the plugin by name instead of by the marketplace's own name.** Claude Code pins an installed plugin to a directory in its marketplace cache, and that record outlives the directory: once the cache dir was pruned or cleaned, `/plugin` reported `Plugin "airprompt" not cached at <path>` while the installer's "is it installed?" probe — a plain search for the word `airprompt` in `claude plugin list` — called the record healthy and skipped the repair, so it stayed broken. Install also spelled the plugin `airprompt@airprompt`, where the marketplace half is frozen at whatever the marketplace was named when it was added; that name went stale when this project moved to `farox-coop`, and the install then targeted a plugin id nothing resolves. The installer now reads the recorded `installPath`, repairs the record with `claude plugin update <id>` (falling back to a fresh install), and installs with `claude plugin install airprompt --marketplace farox-coop/airprompt`. Every `claude plugin` call also runs against the config dir the install targets, so `--config-dir` no longer reads the default `~/.claude` and reports another config's plugin as installed. `sync-claude` no longer prunes the cache dir Claude Code records, nor one a live session is using.
- **A bare `--continue` now means what the IDE means by it.** `airprompt-launch --continue` used to be swallowed and quietly start a _new_ session; it now reaches the IDE as the CLI's own "continue the most recent conversation" flag (and `--continue <session_id>` keeps using AirPrompt's resume path).

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
