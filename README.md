# AirPrompt

Remote control interface for Claude CLI with voice dictation support.

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
| `autostart on|off` | Auto-start AirPrompt on Claude session start |
| `help` | Print usage |

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

Chrome/Android block `SpeechRecognition` over plain HTTP to LAN IPs. AirPrompt auto-detects TLS certs in `~/.claude/` and serves HTTPS. On first connect, accept the self-signed certificate warning. After that, push-to-talk voice dictation works.

## Claude Integration

- `/airprompt on` — Register session and enable remote access
- `/airprompt off` — Unregister session and hide statusline badge
- `/airprompt status` — Show daemon status and all active sessions
- `/airprompt name <text>` — Set session display name (empty or "" clears)
- `/airprompt autostart on|off` — Auto-start on Claude session start
- `/airprompt clean` — Full teardown: kill daemon, remove all sessions and markers
- `/airprompt help` — Print usage

## License

Farox Software Cooperative - https://farox.coop
