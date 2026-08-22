# <img src="public/favicon.svg" alt="AirPrompt logo" width="56" height="56"> AirPrompt

### Remote control interface for IDE/CLI terminals with voice dictation support.

## Overview

AirPrompt lets you view and interact with remote IDE/CLI sessions running on your local network machine from your mobile phone using voice prompts. Provider-agnostic: supports multiple IDEs via adapters (Claude Code first, Codex/Cursor/Windsurf planned).

## Requirements

- **Node.js** ≥ 18
- **tmux** (`sudo apt install tmux`)
- **curl** — API communication with daemon
- **jq** (`sudo apt install jq`) — JSON parsing for daemon protocol detection and notifications
- **reptyr** (`sudo apt install reptyr`) — optional, for `airprompt-attach.sh` (attach running processes to tmux)
- **openssl** — TLS certificate generation for HTTPS voice dictation

## Architecture

- **Daemon**: Single `server.js` instance on port 3210 managing multiple IDE sessions
- **Sessions**: One tmux session per IDE/CLI instance
- **Mobile UI**: Web-based terminal with session selector, xterm.js, adaptive touch scrolling, push-to-talk voice dictation, keyboard input fallback, and dictation-macro preferences
- **Statusline**: Integrated badge `[AirPrompt: https://<IP>:3210]` in IDE terminal

### tmux feature usage

Every tmux feature AirPrompt depends on, where it's used, and why:

| tmux command | Used in | Purpose |
|---|---|---|
| `new-session -d` | `on.sh`, `activate.js`, `server.js` | Create detached sessions (mirror + daemon + web proxy) |
| `attach-session` | `server.js` | Web client connects to tmux session via node-pty |
| `has-session` | `on.sh`, `restart.sh`, `activate.js`, `airprompt-launch`, `src/utils.js` | Check if session exists |
| `kill-session` | `server.js`, `clean.sh`, `off.sh` | Destroy sessions (mirror, daemon, cleanup) |
| `send-keys` | `server.js` | Inject `/airprompt off` into session without attaching |
| `list-clients` | `server.js`, `src/utils.js` | Detect orphaned mirror sessions (no attached clients) |
| `display-message` | `activate.js`, `server.js` | Read session name `#S`, group `#{session_group}`, cwd `#{pane_current_path}` |
| `set-option` | `server.js`, `airprompt-launch` | Disable status bar in web sessions, enable focus-events |
| `load-buffer` / `save-buffer` | `server.js` | Clipboard sync between web client and session |
| `list-panes -F '#{pane_dead}'` | `airprompt-launch` | Detect zombie panes from previous `/exit` |
| `respawn-pane -k` | `airprompt-launch`, `on.sh` | Revive zombie pane or restart daemon |
| Session grouping (`-t parent`) | `server.js` | Web proxy sessions inherit from real session — kill parent, children die

## Quick Start

```bash
make setup          # install deps + generate TLS cert

# Start Claude inside tmux
tmux new-session -s claude && claude

# Inside Claude: /airprompt on

# Open the QR/URL shown on the host (https://<LAN-IP>:3210/#fp=…) on your phone.
# The phone generates a device key and requests pairing.

# On the host, approve the device:
airprompt auth list          # find the pending seq (e.g. 1)
airprompt auth allow 1

# Accept the self-signed cert warning on the phone — voice dictation works.
```

## Commands

All commands go through the unified dispatcher: `airprompt <command>` (`/airprompt <command>` inside Claude Code).

| Command | Action |
|---|---|
| `on [<name>]` | Start daemon + register current session (optional display name) |
| `on --name <name>` | Same, explicit flag form |
| `off` | Unregister current session + hide statusline badge |
| `status` | Show daemon status and all active sessions |
| `name [<text>]` | Set display name for current session (empty or "" clears it) |
| `clean` | Full teardown — kill daemon, remove all sessions/config. Preserves install files (~/.airprompt/server.js) so autostart hook target survives |
| `restart` | Restart daemon — sessions survive via disk recovery |
| `autostart on|off` | Auto-start AirPrompt on IDE session start |
| `auth <cmd>` | Manage paired devices: `list` (alias `devices`), `allow <seq>`, `deny <seq>`, `revoke <seq>` |
| `help` | Print usage |

**`/airprompt` with no arguments** runs `status` + `help` — shows daemon status followed by the command reference.

**Always use `airprompt <command>`** — never call `bin/airprompt-*.sh` directly. Those are internal scripts.

## Device pairing

The daemon requires SSH-style device pairing: each browser holds an ECDSA P-256 keypair, the host whitelists authorized devices, and every connect is a silent mutual challenge-response. No password, no secret in the QR.

- On first connect, scan the QR on the host screen — its URL carries the server fingerprint (`#fp=…`). The phone generates a device key and requests pairing.
- Approve on the host: `airprompt auth list` → `airprompt auth allow <seq>` (or watch for the desktop notification, or the webUI notice on an already-paired browser).
- A pairing request auto-expires after 1 minute if not approved.
- Manage devices: `airprompt auth list` (alias `devices`), `allow <seq>`, `deny <seq>`, `revoke <seq>`. Ordinals are stable — ordered by creation, never renumbered.
- `airprompt clean` wipes all auth state — every device re-pairs.
- If the daemon's key changes (reinstall/rotation), paired browsers show a "server identity changed" warning — use **Re-pair**.

## Make Targets

| Target | Action |
|---|---|
| `setup` | Install npm deps + generate TLS cert |
| `cert` | Generate self-signed TLS certificate |
| `start` | Start AirPrompt daemon in background |
| `stop` | Stop daemon via PID file |
| `refresh` | Stop, clean, setup, and start fresh |
| `logs` | Tail daemon logs |
| `lint` | Syntax-check JS files |
| `test-all` | Run unit and integration tests |
| `agnostic-check` | Audit codebase for hardcoded provider names (dev only) |
| `test-unit` | Run Node.js unit tests |
| `test-integration` | Run shell integration tests |
| `install-plugin` | Install AirPrompt as an IDE plugin |
| `uninstall-plugin` | Remove plugin registration |
| `clean` | Remove PID, daemon.json, state, sessions, logs, node_modules |

## TLS & Voice Dictation

Chrome/Android block `SpeechRecognition` over plain HTTP to LAN IPs. AirPrompt auto-detects TLS certs in `~/.airprompt/state/` and serves HTTPS. On first connect, accept the self-signed certificate warning. After that, push-to-talk voice dictation works.

**Device pairing also requires HTTPS.** Browser WebCrypto (`crypto.subtle`) is only available in secure contexts (HTTPS or `localhost`), so a phone reaching `http://<LAN-IP>:3210` cannot generate or sign keys at all. Running with `AIRPROMPT_NO_TLS=1` disables browser pairing — use TLS.

### Dictation macros

Voice macros let you control formatting and punctuation by speaking trigger phrases. Three types:

- **Inline macros** — replaced in-place within a continuous fragment: "hola signo de pregunta" → `hola?`. Triggers are unambiguous multi-word commands: `abre/abrí` + `cierra/cerrá` `paréntesis` → `(`/`)`, `comillas` → `"`, `comillas simples` → `'`, `tics` → `` ` ``, and `signo de pregunta` → `?`, `signo de exclamación`/`signo de admiración` → `!` (es-AR) / equivalents in en-US.
- **Fragment-level inserts** — a standalone fragment consisting ONLY of the trigger word/phrase inserts the character: `punto` → `.`, `coma` → `,`, `guion` → `-`, `punto y coma` → `;`, `dos puntos` → `:`, `puntos suspensivos` → `…`, `nueva línea` → newline, `nuevo párrafo` → blank line. These common words are NOT replaced when embedded in longer text ("se coma esto" stays literal).
- **Stateful macros** — a standalone fragment that sets formatting for the *next* fragment: say "entre comillas" → next fragment wrapped in `"..."`. Also: "entre comillas simples" → `'...'`, "entre tics" → `` `...` ``, "entre paréntesis" → `(...)`, "en mayúsculas" (capitalize first letter), "todo mayúsculas" (ALL CAPS). Trigger phrases must be the *only* thing in their fragment to activate — embedded in longer speech they're treated as literal text.

Both Spanish (es-AR, including voseo "abrí"/"cerrá") and English (en-US) supported with the same macro set. Accent-dropping by the recognizer is tolerated (e.g. "abri paréntesis" still matches).

Every macro can be toggled from the web UI: tap the ⚙ gear button in the header to open **Preferences**, which lists all macros for the current dictation language, grouped into inline and stateful sections. Each row shows the trigger phrase and its replacement, with a per-macro checkbox (all enabled by default) plus a global "enable all" switch at the top. Disabled macros produce no replacement during dictation, and settings persist in the browser (`localStorage`).

## IDE Integration

AirPrompt uses a provider adapter pattern — each IDE/CLI gets its own adapter implementing a shared interface. Claude Code ships as the first provider.

**Claude Code:**
- `/airprompt on` — Register session and enable remote access
- `/airprompt off` — Unregister session and hide statusline badge
- `/airprompt status` — Show daemon status and all active sessions
- `/airprompt name <text>` — Set session display name (empty or "" clears)
- `/airprompt autostart on|off` — Auto-start on IDE session start
- `/airprompt clean` — Full teardown: kill daemon, remove all sessions and markers
- `/airprompt restart` — Restart daemon — active sessions survive via disk recovery
- `/airprompt help` — Print usage

**Adding new IDEs** (Codex, Cursor, Windsurf): create one provider file + thin hook wrappers. Provider auto-discovered by registry. Zero changes to core.

## License

Farox Software Cooperative - https://farox.coop
