---
name: airprompt
description: Enable remote control and multi-session mobile voice dictation for Claude CLI via web terminal
---

# AirPrompt Skill

When invoked, this skill manages the AirPrompt multi-session remote access system:

1. Checks if the AirPrompt daemon is running on port 3210. If not, starts it in background.
2. Registers the current Claude session with the daemon, making it available for remote access.
3. Shows local network URL + QR code for mobile connection.

## Instructions
- `/airprompt on` — register current session, start daemon if needed, show connection info. Runs `bash bin/airprompt-register.sh`.
- `/airprompt off` — unregister current session, remove statusline badge. Runs `bash bin/airprompt-unregister.sh` (auto-discovers session ID from `~/.claude/.airprompt-session`).
- `/airprompt status` — show current sessions via `curl http://localhost:3210/api/sessions`.

## Architecture
- Daemon: `server.js` on port 3210 (`/tmp/airprompt-server.pid`)
- Web UI: `public/index.html` + `public/client.js` (xterm.js + Web Speech API)
- Sessions: one tmux session per Claude instance (`airprompt-<sessionId>`)
