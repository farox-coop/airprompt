# <img src="public/favicon.svg" alt="AirPrompt logo" width="56" height="56"> AirPrompt

### Remote control interface for Claude CLI with voice dictation support.

## Overview

AirPrompt lets you view and interact with remote Claude CLI sessions running on your local network machine from your mobile phone using voice prompts.

## Requirements

- **Node.js** ≥ 18
- **tmux** (`sudo apt install tmux`)
- **jq** (`sudo apt install jq`) — JSON parsing for daemon protocol detection and notifications
- **reptyr** (`sudo apt install reptyr`) — optional, for `airprompt-attach.sh` (attach running processes to tmux)
- **openssl** — TLS certificate generation for HTTPS voice dictation

## Architecture

- **Daemon**: Single `server.js` instance on port 3210 managing multiple Claude sessions
- **Sessions**: One tmux session per Claude instance
- **Mobile UI**: Web-based terminal with session selector, xterm.js, push-to-talk voice dictation, and keyboard input fallback
- **Statusline**: Integrated badge `[airprompt: https://<IP>:3210]` in Claude Code

### tmux feature usage

Every tmux feature AirPrompt depends on, where it's used, and why:

| tmux command | Used in | Purpose |
|---|---|---|
| `new-session -d` | `on.sh:65`, `activate.js:258`, `server.js:52,346` | Create detached sessions (mirror + daemon + web proxy) |
| `attach-session` | `server.js:356` | Web client connects to tmux session via node-pty |
| `has-session` | `server.js:44`, `clean.sh`, `off.sh`, `status.sh` | Check if session exists |
| `kill-session` | `server.js:57`, `clean.sh:56-63`, `off.sh:66` | Destroy sessions (mirror, daemon, cleanup) |
| `send-keys` | `server.js:257` | Inject `/airprompt off` into session without attaching |
| `list-clients` | `server.js:449` | Detect orphaned mirror sessions (no attached clients) |
| `display-message` | `activate.js:167`, `server.js:130` | Read session name `#S`, group `#{session_group}`, cwd `#{pane_current_path}` |
| `set-option` | `server.js:353-354`, `claude:111` | Disable status bar in web sessions, enable focus-events |
| `load-buffer` / `save-buffer` | `server.js:413,421` | Clipboard sync between web client and session |
| `list-panes -F '#{pane_dead}'` | `claude:102` | Detect zombie panes from previous `/exit` |
| `respawn-pane -k` | `claude:104`, `on.sh:107` | Revive zombie pane or restart daemon |
| Session grouping (`-t parent`) | `server.js:346` | Web proxy sessions inherit from real session — kill parent, children die

## Quick Start

```bash
make setup          # install deps + generate TLS cert

# Start Claude inside tmux
tmux new-session -s claude && claude

# Inside Claude: /airprompt on

# Open https://<LAN-IP>:3210 on your mobile phone
# Accept self-signed cert warning, then voice dictation works
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
| `clean` | Full teardown — kill daemon, remove all tmux sessions and markers |
| `restart` | Restart daemon — sessions survive via disk recovery |
| `autostart on|off` | Auto-start AirPrompt on Claude session start |
| `help` | Print usage |

**`/airprompt` with no arguments** runs `status` + `help` — shows daemon status followed by the command reference.

**Always use `airprompt <command>`** — never call `bin/airprompt-*.sh` directly. Those are internal scripts.

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
| `test-unit` | Run Node.js unit tests |
| `test-integration` | Run shell integration tests |
| `clean` | Remove PID, logs, node_modules |

## TLS & Voice Dictation

Chrome/Android block `SpeechRecognition` over plain HTTP to LAN IPs. AirPrompt auto-detects TLS certs in `~/.claude/.airprompt/` and serves HTTPS. On first connect, accept the self-signed certificate warning. After that, push-to-talk voice dictation works.

## Claude Integration

- `/airprompt on` — Register session and enable remote access
- `/airprompt off` — Unregister session and hide statusline badge
- `/airprompt status` — Show daemon status and all active sessions
- `/airprompt name <text>` — Set session display name (empty or "" clears)
- `/airprompt autostart on|off` — Auto-start on Claude session start
- `/airprompt clean` — Full teardown: kill daemon, remove all sessions and markers
- `/airprompt restart` — Restart daemon — active sessions survive via disk recovery
- `/airprompt help` — Print usage

## License

Farox Software Cooperative - https://farox.coop
