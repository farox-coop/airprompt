# AirPrompt

Remote control interface for Claude CLI with voice dictation support.

## Overview
AirPrompt allows you to view and interact with remote Claude CLI sessions running on your local network machine from your mobile phone using voice prompts.

## Architecture
- **Daemon**: Single `server.js` instance on port 3210 managing multiple Claude sessions
- **Sessions**: One tmux session per Claude instance (`airprompt-<sessionId>`)
- **Mobile UI**: Web-based terminal with session selector, xterm.js, and push-to-talk voice dictation
- **Statusline**: Integrated badge `[airprompt: http://<IP>:3210]` in Claude Code

## Quick Start
```bash
make setup
make start
# Register a Claude session:
bash bin/airprompt-register.sh
# Open http://<LAN-IP>:3210 on your mobile phone
```

## Make Targets
| Target | Action |
|--------|--------|
| `setup` | Install npm dependencies |
| `start` | Start AirPrompt daemon in background |
| `stop` | Stop daemon via PID file |
| `refresh` | Stop, clean, setup, and start fresh |
| `logs` | Tail daemon logs |
| `lint` | Syntax-check JS files |
| `test-all` | Run unit and integration tests |
| `test-unit` | Run Node.js unit tests |
| `test-integration` | Run shell integration tests |
| `clean` | Remove PID, logs, node_modules |

## Claude Integration
- `/airprompt on` — Register session and enable remote access
- `/airprompt off` — Unregister session and hide statusline badge
- `/airprompt status` — List all active sessions

## License
Farox Software Cooperative - https://farox.coop
