# AirPrompt Integration Command

## Purpose
Enable remote mobile access and voice dictation for this Claude session.

## Usage
- `/airprompt on` — Register current session and start daemon. Shows QR code + URL.
- `/airprompt off` — Unregister current session. Removes statusline badge.
- `/airprompt status` — List all active remote sessions.

## Architecture
- Daemon on port 3210, PID file `/tmp/airprompt-server.pid`
- One tmux session per Claude instance (`airprompt-<sessionId>`)
- Mobile UI at `http://<LAN-IP>:3210` with session selector, xterm.js terminal, and push-to-talk voice dictation

## Execution
1. `/airprompt on` runs `bash /home/diego/projects/airprompt/bin/airprompt-register.sh` (saves session ID to `~/.claude/.airprompt-session` for auto-discovery on off).
2. Daemon auto-starts if not running (single instance enforced via PID file).
3. Statusline hook (`airprompt-statusline.sh`) shows `[airprompt: http://<IP>:3210]` badge when active.
4. `/airprompt off` runs `bash /home/diego/projects/airprompt/bin/airprompt-unregister.sh` which auto-discovers the saved session ID.
