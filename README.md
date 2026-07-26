# AirPrompt

Remote control interface for Claude CLI with voice dictation support.

## Overview
AirPrompt allows you to view and interact with remote Claude CLI sessions running on your local network machine from your mobile phone using voice prompts.

## Requirements
- **Node.js** ≥ 18
- **tmux** (`sudo apt install tmux`)
- **reptyr** (`sudo apt install reptyr`) — attach running processes to tmux without restart. May need `echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope`
- **openssl** — TLS certificate generation for HTTPS voice dictation
- **airprompt-claude** — convenience wrapper at `~/bin/airprompt-claude` (auto-starts Claude inside tmux)

## Architecture
- **Daemon**: Single `server.js` instance on port 3210 managing multiple Claude sessions
- **Sessions**: One tmux session per Claude instance (`airprompt-<sessionId>`)
- **Mobile UI**: Web-based terminal with session selector, xterm.js, push-to-talk voice dictation, and keyboard input fallback
- **Statusline**: Integrated badge `[airprompt: https://<IP>:3210]` in Claude Code

## Quick Start
```bash
make setup          # install deps + generate TLS cert
make start          # start daemon in background

# Use the convenience wrapper (auto-starts Claude inside tmux)
airprompt-claude --continue

# Or manually: start Claude inside tmux
tmux new-session -s claude && claude

# Inside Claude: /airprompt on

# Open https://<LAN-IP>:3210 on your mobile phone
# Accept self-signed cert warning, then voice dictation works
```

## Make Targets
| Target | Action |
|--------|--------|
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

## Scripts
| Script | Purpose |
|--------|---------|
| `bin/airprompt-register.sh` | Register tmux session with daemon (auto-detects `$TMUX`) |
| `bin/airprompt-unregister.sh` | Unregister session (auto-discovers saved session ID) |
| `bin/airprompt-attach.sh <PID>` | Attach running process to tmux via reptyr + register |
| `bin/generate-cert.sh` | Create self-signed TLS cert (idempotent, always refreshes) |

## TLS & Voice Dictation
Chrome/Android block `SpeechRecognition` over plain HTTP to LAN IPs. AirPrompt auto-detects TLS certs in `~/.claude/` and serves HTTPS. On first connect, accept the self-signed certificate warning. After that, push-to-talk voice dictation works.

## Claude Integration
- `/airprompt on` — Register session and enable remote access
- `/airprompt off` — Unregister session and hide statusline badge
- `/airprompt status` — List all active sessions

## License
Farox Software Cooperative - https://farox.coop
