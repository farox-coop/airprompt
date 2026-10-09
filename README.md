# <img src="public/favicon.svg" alt="AirPrompt logo" width="56" height="56"> AirPrompt

### Remote control interface for IDE/CLI terminals with voice dictation support.

## Overview

AirPrompt lets you view and interact with remote IDE/CLI sessions running on your local network machine from your mobile phone using voice prompts. Provider-agnostic: supports multiple IDEs via adapters (Claude Code, Codex, Cursor, Windsurf).

## Requirements

> Debian/Ubuntu commands shown; macOS uses `brew install tmux jq openssl` (see [Supported platforms](#supported-platforms)).

- **Node.js** ≥ 20
- **tmux** (`sudo apt install tmux`)
- **curl** — API communication with daemon
- **jq** (`sudo apt install jq`) — JSON parsing for daemon protocol detection and notifications
- **openssl** — TLS certificate generation for HTTPS voice dictation
- **Build tools** — `node-pty` compiles from source: `build-essential` + `python3` on Linux, Xcode Command Line Tools on macOS

## Supported platforms

Linux, macOS, and WSL are supported. macOS uses Homebrew (`brew install tmux jq openssl`); the shell scripts are bash 3.2 compatible. Native Windows is not supported (the daemon requires tmux) — the PowerShell installer does a CLI-only install.

## Architecture

- **Daemon**: Single `server.js` instance on port 3210 managing multiple IDE sessions
- **Sessions**: One tmux session per IDE/CLI instance
- **Mobile UI**: Web-based terminal with session selector, xterm.js, adaptive touch scrolling, tap-to-dictate voice dictation, keyboard input fallback, image attach (phone gallery/clipboard/paste/drag-and-drop), and dictation-macro preferences
- **Statusline**: Integrated badge `[AirPrompt: https://<IP>:3210]` in IDE terminal

### tmux feature usage

Every tmux feature AirPrompt depends on, where it's used, and why:

| tmux command                   | Used in                                                                  | Purpose                                                                      |
| ------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `new-session -d`               | `on.sh`, `activate.js`, `server.js`                                      | Create detached sessions (mirror + daemon + web proxy)                       |
| `attach-session`               | `server.js`                                                              | Web client connects to tmux session via node-pty                             |
| `has-session`                  | `on.sh`, `restart.sh`, `activate.js`, `airprompt-launch`, `src/utils.js` | Check if session exists                                                      |
| `kill-session`                 | `server.js`, `clean.sh`, `off.sh`                                        | Destroy sessions (mirror, daemon, cleanup)                                   |
| `send-keys`                    | `server.js`                                                              | Inject `/airprompt off` into session without attaching                       |
| `list-clients`                 | `server.js`, `src/utils.js`                                              | Detect orphaned mirror sessions (no attached clients)                        |
| `display-message`              | `activate.js`, `server.js`                                               | Read session name `#S`, group `#{session_group}`, cwd `#{pane_current_path}` |
| `set-option`                   | `server.js`, `airprompt-launch`                                          | Disable status bar in web sessions, enable focus-events                      |
| `load-buffer` / `save-buffer`  | `server.js`                                                              | Clipboard sync between web client and session                                |
| `list-panes -F '#{pane_dead}'` | `airprompt-launch`                                                       | Detect zombie panes from previous `/exit`                                    |
| `respawn-pane -k`              | `airprompt-launch`, `on.sh`                                              | Revive zombie pane or restart daemon                                         |
| Session grouping (`-t parent`) | `server.js`                                                              | Web proxy sessions inherit from real session — kill parent, children die     |

## Quick Start

Install AirPrompt and wire it into Claude Code with one command:

```bash
curl -fsSL https://github.com/farox-coop/airprompt/releases/latest/download/install.sh | bash
```

This clones the repo to `~/.airprompt/`, installs dependencies, generates a TLS certificate, symlinks `airprompt` into `~/bin/`, installs the Claude Code plugin, and wires the hooks + statusline badge.

Then run Claude Code inside tmux and turn the session on:

```bash
tmux new-session -s claude && claude
```

Inside Claude Code, run `/airprompt on`. Open the QR/URL shown on the host (`https://<LAN-IP>:3210/#fp=…`) on your phone — the phone generates a device key and requests pairing. Approve it on the host:

```bash
airprompt auth list          # find the pending seq (e.g. 1)
airprompt auth allow 1
```

Accept the self-signed certificate warning on the phone and voice dictation works from there.

## Install

### One-liners

```bash
# Linux / macOS / WSL — latest release
curl -fsSL https://github.com/farox-coop/airprompt/releases/latest/download/install.sh | bash

# Pin a specific release instead:
curl -fsSL https://github.com/farox-coop/airprompt/releases/download/v1.0.0/install.sh | bash

# PowerShell (Windows — daemon needs tmux, so CLI install only)
irm https://github.com/farox-coop/airprompt/releases/latest/download/install.ps1 | iex

# From a local clone
node bin/install.js
```

### Installer flags

`node bin/install.js` accepts the following (each is also forwarded through `install.sh`):

| Flag                  | Action                                                         |
| --------------------- | -------------------------------------------------------------- |
| `--dry-run`           | Print what would run, change nothing                           |
| `--force`             | Re-run even if already installed                               |
| `--only <agent>`      | Install only for the named agent (repeatable)                  |
| `--with-hooks`        | Wire standalone hooks alongside the plugin manifest            |
| `--no-hooks`          | Skip settings.json hook wiring (plugin manifest handles hooks) |
| `--uninstall, -u`     | Remove AirPrompt from this machine                             |
| `--config-dir <path>` | IDE config dir (default `~/.claude`)                           |
| `--target-dir <path>` | Install dir (default `~/.airprompt/`)                          |
| `--port <n>`          | Daemon port (default 3210)                                     |
| `--non-interactive`   | Never prompt; use defaults                                     |
| `--list`              | Print supported agents and exit                                |

### What gets created

- `~/.airprompt/` — repo clone + runtime (server.js, src/, node_modules)
- `~/.airprompt/state/` — daemon.json, TLS cert/key, project names
- `~/.airprompt/sessions/` — per-session markers (url, name)
- `~/bin/airprompt` — symlink to the dispatcher (add `~/bin` to your PATH)
- `~/bin/airprompt-{codex,cursor,windsurf}` — per-provider launch wrappers
- Per-provider config: `~/.claude/hooks/` + `settings.json`; `~/.codex/hooks.json` + `config.toml` + `skills/`; `~/.cursor/hooks.json` + `commands/` + `rules/`; `~/.codeium/windsurf/hooks.json` + `skills/` + `rules/`
- `/tmp/airprompt-server.pid` — daemon PID file
- `/tmp/airprompt.log` — daemon log

### Uninstall

```bash
node bin/install.js --uninstall
# or, full teardown (kills daemon, removes sessions + config):
airprompt clean
```

## Configuration

Environment variables (all optional):

| Variable                     | Default                     | Purpose                                                              |
| ---------------------------- | --------------------------- | -------------------------------------------------------------------- |
| `AIRPROMPT_PORT`             | `3210`                      | Daemon port                                                          |
| `AIRPROMPT_STATE_DIR`        | `~/.airprompt/state`        | daemon.json, TLS cert/key, project names                             |
| `AIRPROMPT_SESSIONS_DIR`     | `~/.airprompt/sessions`     | Per-session markers                                                  |
| `AIRPROMPT_UPLOADS_DIR`      | `~/.airprompt/uploads`      | Files attached from the phone (must contain `airprompt` in its path) |
| `AIRPROMPT_UPLOAD_MAX_BYTES` | `26214400` (25 MB)          | Per-file upload cap                                                  |
| `AIRPROMPT_UPLOAD_TTL_MS`    | `86400000` (24 h)           | Backstop lifetime for an upload never released by a prompt           |
| `AIRPROMPT_UPLOAD_GRACE_MS`  | `600000` (10 min)           | Grace window between a prompt submit and the file being reaped       |
| `AIRPROMPT_PID_FILE`         | `/tmp/airprompt-server.pid` | Daemon PID file                                                      |
| `AIRPROMPT_NO_TLS`           | unset                       | `1` disables HTTPS (breaks pairing + voice dictation)                |
| `AIRPROMPT_DEBUG`            | unset                       | `1` enables verbose logging                                          |

### TLS certificate

A self-signed certificate is generated to `~/.airprompt/state/` on install. To regenerate:

```bash
bin/generate-cert.sh        # or: make cert
airprompt restart
```

### Logs

Daemon output goes to `/tmp/airprompt.log`. Tail it with `make logs` or `tail -f /tmp/airprompt.log`.

## Provider status

| Provider              | Status        | Notes                                                                     |
| --------------------- | ------------- | ------------------------------------------------------------------------- |
| Claude Code (tmux)    | ✅ Functional | Full install, hooks, badge, lifecycle                                     |
| Claude Code (VS Code) | ⚠️ Partial    | Registers, but no `$TMUX` — phone shows an empty shell, not the live UI   |
| Codex                 | ✅ Functional | `$airprompt` skill, `SessionStart`/`Stop` hooks                           |
| Cursor                | ✅ Functional | `/airprompt` command + rule, `sessionStart`/`sessionEnd` hooks            |
| Windsurf              | ✅ Functional | `on-open` hook; no session-end — daemon runs until `airprompt off`/reboot |

## Troubleshooting

**`/airprompt` is an unknown command** — the install didn't complete, or `~/bin` isn't on your PATH. Re-run the installer and add `export PATH="$HOME/bin:$PATH"` to your shell profile.

**Self-signed certificate warning** — expected. Accept it once. It's the local TLS cert required for HTTPS (mic + pairing). If it keeps re-prompting, regenerate the cert (see Configuration).

**Voice dictation (mic) doesn't work** — HTTPS is required. Chrome/Android block `SpeechRecognition` over plain HTTP. Don't set `AIRPROMPT_NO_TLS=1` if you need the mic.

**"no provider detected" / badge missing** — install a supported agent (`claude`, `codex`, `cursor`, or `windsurf`) and re-run the installer, or set `AIRPROMPT_PROVIDER` manually. The badge shows only in the registered session.

**Missing tmux / jq / openssl** — `sudo apt install tmux jq openssl` (macOS: `brew install tmux jq openssl`). tmux is required for mirroring; jq for protocol detection; openssl for the TLS cert.

**HTTP fallback (TLS unavailable)** — if cert generation fails the daemon falls back to HTTP; pairing and voice dictation won't work. Run `bin/generate-cert.sh` and `airprompt restart`.

**Multi-line dictation collapses into a `[Pasted text #N]` chip** — known issue. Dictation with real line breaks ("nueva línea" / "nuevo párrafo", or >800 chars) is sent as a bracketed paste, which Claude Code collapses by design. The text is not lost — it's delivered in full on Enter. See [docs/PLAN - dictation macros.md](<docs/PLAN - dictation macros.md#known-issue--multi-line-dictation-collapses-in-claude-code>) for the root cause and options.

## Attaching files from the phone

- **Three ways in** — 📎 in the session bar opens the gallery/camera picker, 📋 reads an image straight from the clipboard where the browser allows it, and on desktop you can paste (Ctrl+V) or drop a file onto the terminal.
- **The path is what travels** — the daemon stores the file under `~/.airprompt/uploads/<provider>-<sessionId>/` and answers with its absolute path, which is typed into the session wrapped in backticks (` `/path/to/file.jpg` `) so it lands as a self-contained code span. A CLI that reads images from a path (Claude Code, for example) therefore sees your screenshot with no manual transfer. Nothing is submitted: the path lands at the CLI's cursor and you add your instruction and send.
- **Downscaled to a 1568px long edge** — the vision API's own limit, so a 4000px screenshot does not cost upload time for nothing. Toggle it in the ⚙ preferences; PNG stays PNG, so UI screenshots keep crisp text.
- **Self-cleaning** — a prompt submit releases the previous turn's files, which are reaped after `AIRPROMPT_UPLOAD_GRACE_MS` (10 min by default, so a slow turn can still read them); anything never released is reaped after `AIRPROMPT_UPLOAD_TTL_MS` (24 h); and a session's uploads go with the session (`airprompt off`, `airprompt clean`, or its tmux session ending).
- **Bounded and authenticated** — `/api/upload` is reachable from the LAN but requires a single-use, device-bound token minted over the paired WebSocket. Images only (PNG/JPEG/WebP/GIF), capped by `AIRPROMPT_UPLOAD_MAX_BYTES` (25 MB).

> **Caveats:** a `$HOME` or `AIRPROMPT_UPLOADS_DIR` containing spaces makes the typed path ambiguous for the CLI (filenames themselves are always sanitized), and clipboard reads depend on the source app (some Android galleries never put the image on the clipboard, in which case 📋 says so) — confirmed working from Android Chrome, so try it, with 📎 as the always-works fallback.

## Commands

All commands go through the unified dispatcher: `airprompt <command>` (`/airprompt <command>` inside Claude Code).

| Command            | Action                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `on [<name>]`      | Start daemon + register current session (optional display name)                                                                             |
| `on --name <name>` | Same, explicit flag form                                                                                                                    |
| `off`              | Unregister current session + hide statusline badge                                                                                          |
| `status`           | Show daemon status and all active sessions                                                                                                  |
| `name [<text>]`    | Set display name for current session (empty or "" clears it)                                                                                |
| `clean`            | Full teardown — kill daemon, remove all sessions/config. Preserves install files (~/.airprompt/server.js) so autostart hook target survives |
| `restart`          | Restart daemon — sessions survive via disk recovery                                                                                         |
| `autostart on      | off`                                                                                                                                        | Auto-start AirPrompt on IDE session start |
| `auth <cmd>`       | Manage paired devices: `list` (alias `devices`), `allow <seq>`, `deny <seq>`, `revoke <seq>`, `name <seq> <name>`                           |
| `help`             | Print usage                                                                                                                                 |

**`/airprompt` with no arguments** runs `status` + `help` — shows daemon status followed by the command reference.

**Always use `airprompt <command>`** — never call `bin/airprompt-*.sh` directly. Those are internal scripts.

## Device pairing

The daemon requires SSH-style device pairing: each browser holds an ECDSA P-256 keypair, the host whitelists authorized devices, and every connect is a silent mutual challenge-response. No password, no secret in the QR.

- On first connect, scan the QR on the host screen — its URL carries the server fingerprint (`#fp=…`). The phone generates a device key and requests pairing.
- Approve on the host: `airprompt auth list` → `airprompt auth allow <seq>` (or watch for the desktop notification, or the webUI notice on an already-paired browser).
- A pairing request auto-expires after 1 minute if not approved.
- Manage devices: `airprompt auth list` (alias `devices`), `allow <seq>`, `deny <seq>`, `revoke <seq>`, `name <seq> <name>`. Ordinals are stable — ordered by creation, never renumbered.
- `airprompt clean` wipes all auth state — every device re-pairs.
- If the daemon's key changes (reinstall/rotation), paired browsers show a "server identity changed" warning — use **Re-pair**.

## Make Targets

| Target             | Action                                                       |
| ------------------ | ------------------------------------------------------------ |
| `setup`            | Install npm deps + generate TLS cert                         |
| `cert`             | Generate self-signed TLS certificate                         |
| `start`            | Start AirPrompt daemon in background                         |
| `stop`             | Stop daemon via PID file                                     |
| `refresh`          | Stop, clean, setup, and start fresh                          |
| `logs`             | Tail daemon logs                                             |
| `lint`             | Lint JS (ESLint) + shell (shellcheck)                        |
| `format-write`     | Reformat with Prettier                                       |
| `format-check`     | Verify formatting with Prettier                              |
| `test-all`         | Run lint, format-check, agnostic-check, unit, integration    |
| `agnostic-check`   | Audit codebase for hardcoded provider names (dev only)       |
| `test-unit`        | Run Node.js unit tests                                       |
| `test-integration` | Run shell integration tests                                  |
| `install-plugin`   | Install AirPrompt as an IDE plugin                           |
| `uninstall-plugin` | Remove plugin registration                                   |
| `clean`            | Remove PID, daemon.json, state, sessions, logs, node_modules |

## TLS & Voice Dictation

Chrome/Android block `SpeechRecognition` over plain HTTP to LAN IPs. AirPrompt auto-detects TLS certs in `~/.airprompt/state/` and serves HTTPS. On first connect, accept the self-signed certificate warning. After that, tap-to-dictate voice dictation works.

**Device pairing also requires HTTPS.** Browser WebCrypto (`crypto.subtle`) is only available in secure contexts (HTTPS or `localhost`), so a phone reaching `http://<LAN-IP>:3210` cannot generate or sign keys at all. Running with `AIRPROMPT_NO_TLS=1` disables browser pairing — use TLS.

### Dictation macros

Voice macros let you control formatting and punctuation by speaking trigger phrases. Three types:

- **Inline macros** — replaced in-place within a continuous fragment: "hola signo de pregunta" → `hola?`. Triggers are unambiguous multi-word commands: `abre/abrí` + `cierra/cerrá` `paréntesis` → `(`/`)`, `comillas` → `"`, `comillas simples` → `'`, `tics` → `` ` ``, and `signo de pregunta` → `?`, `signo de exclamación`/`signo de admiración` → `!` (es-AR) / equivalents in en-US.
- **Fragment-level inserts** — a standalone fragment consisting ONLY of the trigger word/phrase inserts the character: `punto` → `.`, `coma` → `,`, `guion` → `-`, `punto y coma` → `;`, `dos puntos` → `:`, `puntos suspensivos` → `…`, `nueva línea` → newline, `nuevo párrafo` → blank line. These common words are NOT replaced when embedded in longer text ("se coma esto" stays literal).
- **Stateful macros** — a standalone fragment that sets formatting for the _next_ fragment: say "entre comillas" → next fragment wrapped in `"..."`. Also: "entre comillas simples" → `'...'`, "entre tics" → `` `...` ``, "entre paréntesis" → `(...)`, "en mayúsculas" (capitalize first letter), "todo mayúsculas" (ALL CAPS). Trigger phrases must be the _only_ thing in their fragment to activate — embedded in longer speech they're treated as literal text.

Both Spanish (es-AR, including voseo "abrí"/"cerrá") and English (en-US) supported with the same macro set. Accent-dropping by the recognizer is tolerated (e.g. "abri paréntesis" still matches).

Every macro can be toggled from the web UI: tap the ⚙ gear button in the header to open **Preferences**, which lists all macros for the current dictation language, grouped into inline and stateful sections. Each row shows the trigger phrase and its replacement, with a per-macro checkbox (all enabled by default) plus a global "enable all" switch at the top. Disabled macros produce no replacement during dictation, and settings persist in the browser (`localStorage`).

## IDE Integration

AirPrompt uses a provider adapter pattern — each IDE/CLI gets its own adapter implementing a shared interface. Four providers ship today: Claude Code, Codex, Cursor, and Windsurf.

**Claude Code:**

- `/airprompt on` — Register session and enable remote access
- `/airprompt off` — Unregister session and hide statusline badge
- `/airprompt status` — Show daemon status and all active sessions
- `/airprompt name <text>` — Set session display name (empty or "" clears)
- `/airprompt autostart on|off` — Auto-start on IDE session start
- `/airprompt clean` — Full teardown: kill daemon, remove all sessions and markers
- `/airprompt restart` — Restart daemon — active sessions survive via disk recovery
- `/airprompt update [<tag>]` — Update install to a release tag (or latest main)
- `/airprompt help` — Print usage

**Manual launch / resume:** `airprompt-launch --provider claude` starts Claude inside a managed tmux session so AirPrompt can mirror it. Resume a previous session with `airprompt-launch --resume <session_id>` or `airprompt-launch --continue`. Handy in VS Code where there's no `$TMUX` — the launch script creates the tmux session itself.

**Adding a new provider:** create one provider file + a single generic hook wrapper (provider id passed via argv). Provider auto-discovered by registry. Zero changes to core.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, running the tests, adding a provider, and project conventions.

## License

MIT — see [LICENSE](LICENSE). © Farox Software Cooperative — https://farox.coop
