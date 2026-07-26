# AirPrompt — Multi-Session Remote Access Plan

## Context

AirPrompt lets you watch and control Claude CLI sessions from your Android phone
via a web terminal with voice dictation. A single daemon (`server.js`) runs on the
Ubuntu host, and every Claude session auto-registers so the phone sees all active
sessions and can switch between them.

This plan replaces the earlier single-session PoC with a multi-session design
integrated into the Claude Code statusline (alongside `[CAVEMAN]`, `[high]`, etc.).

---

## 1. Port

**3210** — unusual, avoids collisions with common dev servers.

Every reference (plan, `server.js`, skill, command, statusline hook) uses 3210.

---

## 2. Architecture

```
┌──────────────────────────────────────────────────┐
│  Ubuntu host                                      │
│                                                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐         │
│  │ Claude A  │  │ Claude B  │  │ Claude C  │        │
│  │ tmux:     │  │ tmux:     │  │ tmux:     │        │
│  │ airprompt │  │ airprompt │  │ airprompt │        │
│  │ -abc123   │  │ -def456   │  │ -ghi789   │        │
│  └────┬──────┘  └────┬──────┘  └────┬──────┘        │
│       │ register      │ register      │ register      │
│       ▼               ▼               ▼              │
│  ┌──────────────────────────────────────────┐       │
│  │           server.js (port 3210)           │       │
│  │  • Session registry (in-memory)           │       │
│  │  • REST: GET/POST /api/sessions           │       │
│  │  • WebSocket: terminal I/O + control      │       │
│  │  • PID file: /tmp/airprompt-server.pid    │       │
│  └──────────────────────────────────────────┘       │
│       ▲                                               │
│       │ http://<LAN-IP>:3210                          │
│       │                                               │
│  ┌───┴──────────────────────────────────────┐        │
│  │  Mobile phone (browser)                   │        │
│  │  • Session selector (top bar)             │        │
│  │  • xterm.js terminal                      │        │
│  │  • Push-to-talk voice dictation           │        │
│  └──────────────────────────────────────────┘        │
└──────────────────────────────────────────────────┘
```

---

## 3. Components & Files

### A. Central Daemon — `server.js` (rewrite)

| Concern | Design |
|---------|--------|
| Port | 3210 (env `PORT` override) |
| PID file | `/tmp/airprompt-server.pid` — prevents duplicate instances |
| Session registry | In-memory `Map<sessionId, {cwd, tmuxSession, createdAt}>` |
| REST `GET /api/sessions` | Returns JSON array of active sessions |
| REST `POST /api/sessions/register` | Body: `{sessionId, cwd}`. Creates tmux session `airprompt-<sessionId>`. Returns `{ok: true}` |
| REST `POST /api/sessions/unregister` | Body: `{sessionId}`. Removes from registry. |
| WebSocket upgrade | Same HTTP server. Messages are JSON: |
| | `{type: "input", data: "<keystrokes>"}` — forward to active tmux session |
| | `{type: "switch_session", sessionId: "..."}` — detach old pty, attach new |
| | Server emits `{type: "session_list", sessions: [...]}` on connect and on change |
| Per-WS pty | One `node-pty` per WebSocket client. Re-spawned on session switch. |
| Stale cleanup | Every 60s, check each registered tmux session still exists; remove dead ones. Broadcast updated session list. |

### B. Mobile UI — `public/index.html` + `public/client.js` (rewrite)

**`index.html`** — new structure:
- **Top bar** (`#session-bar`): shows current session label + "Switch" button.
- **Session modal** (`#session-modal`): overlay listing all sessions fetched from server. Tap to switch.
- **Terminal container** (existing, unchanged).
- **Mic button** (existing, unchanged).
- References `client.js`.

**`client.js`** — new logic:
- On WebSocket open, request session list.
- Render session bar and modal from `session_list` messages.
- Session switch: send `{type: "switch_session", sessionId}` → server re-attaches pty.
- All terminal input wrapped as `{type: "input", data: ...}` (not raw strings).
- Voice dictation unchanged except wrapping in JSON protocol.
- Auto-select first session on connect if none active.

### C. Statusline Hook — `~/.claude/hooks/airprompt-statusline.sh` (new file)

Follows `caveman-statusline.sh` pattern:
1. Read stdin JSON (session data piped by aggregator).
2. Check marker file `~/.claude/.airprompt-active` exists and is not a symlink.
3. If active, read URL from `~/.claude/.airprompt-url` (written by registration script).
4. Output: `\033[38;5;33m[airprompt: http://<IP>:3210]\033[0m` (blue, color 33).
5. If marker absent → output nothing (statusline clean).

**Registration in aggregator** — edit `~/.claude/hooks/statusline.sh`:
- Add `airprompt-statusline.sh` to `HOOKS_INCLUDED`.

### D. Session Registration Script — `bin/airprompt-register.sh` (new file)

Called by Claude wrapper or `/airprompt` command:
1. Generate `sessionId = $(date +%s)-$(basename $PWD | tr -cd 'a-zA-Z0-9-_')`
2. Ensure tmux session exists: `tmux new-session -d -s "airprompt-${sessionId}"`
3. Ensure daemon running: check PID file, start `node server.js &` if not.
4. `curl -s POST localhost:3210/api/sessions/register -d "{...}"`
5. Write full URL to `~/.claude/.airprompt-url`
6. Touch `~/.claude/.airprompt-active`

### E. Session Unregistration — `bin/airprompt-unregister.sh` (new file)

Called on Claude exit (Stop hook):
1. `curl -s POST localhost:3210/api/sessions/unregister -d "{...}"`
2. Remove `~/.claude/.airprompt-active` marker.

### F. Claude Integration Files

| File | Purpose |
|------|---------|
| `.claude/skills/airprompt.md` | Skill instructions: check daemon, register, show QR + URL |
| `.claude/commands/airprompt.md` | `/airprompt` command docs |
| `~/.claude/hooks/airprompt-statusline.sh` | Statusline badge script |
| `~/.claude/hooks/statusline.sh` | Add airprompt hook to `HOOKS_INCLUDED` |

**Toggle support:**
- `/airprompt on` → runs registration script, creates marker file.
- `/airprompt off` → runs unregistration script, removes marker file.
- Statusline hook checks marker → badge appears/disappears naturally.

---

## 4. WebSocket Protocol (JSON)

All messages are JSON strings:

**Client → Server:**
```json
{"type": "input", "data": "ls -la\r"}
{"type": "switch_session", "sessionId": "1720000000-myproject"}
{"type": "list_sessions"}
```

**Server → Client:**
```json
{"type": "output", "data": "[32m...terminal output...[0m"}
{"type": "session_list", "sessions": [{"id": "...", "cwd": "...", "createdAt": "..."}]}
```

---

## 5. Implementation Steps (ordered)

### Step 1: Rewrite `server.js` ✅
- Port 3210, PID file, session registry Map.
- REST endpoints: `GET /api/sessions`, `POST /api/sessions/register`, `POST /api/sessions/unregister`.
- JSON WebSocket protocol: parse `type`, route `input`/`switch_session`.
- Stale session cleanup loop (60s interval).
- Serve static `public/` via express.

### Step 2: Rewrite `public/index.html` + `public/client.js` ✅
- Add session bar + modal HTML/CSS.
- JSON WebSocket protocol in client.js.
- Session list fetching and switching.
- Keep xterm.js + Web Speech API, wrap in JSON.

### Step 3: Create `bin/airprompt-register.sh` + `bin/airprompt-unregister.sh` ✅
- Registration: generate ID, create tmux session, POST to daemon, write markers.
- Unregistration: POST to daemon, remove markers.

### Step 4: Create `~/.claude/hooks/airprompt-statusline.sh` ✅
- Read stdin, check marker, output badge with LAN IP.
- Security: refuse symlinks, strip control chars (same hardening as caveman hook).

### Step 5: Update `~/.claude/hooks/statusline.sh` ✅
- Add `airprompt-statusline.sh` to `HOOKS_INCLUDED`.

### Step 6: Update skill + command files ✅
- `.claude/skills/airprompt.md`: multi-session instructions, port 3210, toggle support.
- `.claude/commands/airprompt.md`: same.

### Step 7: Create `Makefile` ✅

Targets:

| Target | Action |
|--------|--------|
| `setup` | `npm install` | ✅ Done |
| `start` | `node server.js` |
| `stop` | Kill process from PID file `/tmp/airprompt-server.pid` |
| `test-all` | Run `test-unit` + `test-integration` |
| `test-unit` | `node --test test/unit/*.test.js` |
| `test-integration` | `bash test/integration/run.sh` |
| `lint` | `npx eslint server.js public/client.js` (or basic `node --check`) |
| `clean` | Remove PID file, `node_modules/` |

`.PHONY` on single line.

### Step 8: Create Test Suite

Test framework: **Node.js built-in `node:test` + `node:assert`** (no extra deps).
Shell tests use plain `bash` with exit codes.

#### 8a. Unit Tests — `test/unit/server.test.js`

| # | Test | What it validates |
|---|------|-------------------|
| 1 | `POST /api/sessions/register` creates session | Returns 200, session in registry, tmux session spawned |
| 2 | `POST /api/sessions/register` rejects duplicate | Returns 409 on same sessionId |
| 3 | `POST /api/sessions/register` rejects missing body | Returns 400 on empty/missing `sessionId` |
| 4 | `GET /api/sessions` returns empty | `[]` when no sessions registered |
| 5 | `GET /api/sessions` returns all | After 2 registrations, returns array of 2 |
| 6 | `POST /api/sessions/unregister` removes | Returns 200, session gone from list |
| 7 | `POST /api/sessions/unregister` missing id | Returns 404 on unknown sessionId |
| 8 | PID file created on start | `/tmp/airprompt-server.pid` exists after `server.listen` |
| 9 | PID file prevents duplicate start | Second server process exits with error if PID file exists + process alive |
| 10 | WebSocket `list_sessions` on connect | New WS client receives `session_list` message automatically |
| 11 | WebSocket `switch_session` attaches correct tmux | Sending `switch_session` spawns pty for target session |
| 12 | WebSocket `input` forwards to tmux | Sending `input` writes data to active pty |
| 13 | Stale session cleanup | After marking session dead (tmux killed externally), removed within 60s |

#### 8b. Unit Tests — `test/unit/statusline.test.sh`

| # | Test | What it validates |
|---|------|-------------------|
| 1 | No badge when marker absent | Output is empty (exit 0) |
| 2 | Badge when marker present | Output contains `[airprompt: http://` |
| 3 | Badge includes correct port | Output contains `:3210]` |
| 4 | Refuses symlink marker | Output is empty when marker is symlink |
| 5 | Strips control characters | No ANSI other than the badge's own escape codes |
| 6 | Reads URL from file | Badge shows URL from `~/.claude/.airprompt-url` |

#### 8c. Integration Tests — `test/integration/run.sh`

| # | Test | What it validates |
|---|------|-------------------|
| 1 | Full register → list → switch → unregister | End-to-end via curl + websocat (or node ws client) |
| 2 | Two sessions register, both visible, switch between them | Multi-session listing + switching |
| 3 | Session unregistered on exit | Marker file removed, session gone from `/api/sessions` |
| 4 | Server survives client disconnect | Kill WS client, server still running, sessions intact |
| 5 | Concurrent clients on same session | Two WS clients both receive output from same session |

### Step 9: Update `package.json`
- Add `scripts.register` and `scripts.unregister` shortcuts.
- Add `scripts.test`: `"node --test test/unit/*.test.js"`.

---

## 6. Verification (Manual QA)

1. Start `server.js` manually: `node server.js` → check `http://<IP>:3210/api/sessions` returns `[]`.
2. Run `bin/airprompt-register.sh` from a project dir → session appears in API.
3. Open mobile browser to `http://<IP>:3210` → session shows in selector.
4. Start second Claude session, register → both sessions visible, switching works.
5. Dictate a prompt via mic button → text appears in selected session's terminal.
6. Run unregister → session removed from list.
7. Check statusline: `[airprompt: http://<IP>:3210]` badge visible when active, gone when off.
8. `/airprompt off` → badge disappears. `/airprompt on` → badge returns.
