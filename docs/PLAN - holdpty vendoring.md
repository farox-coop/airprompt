# Plan: holdpty vendoring — replace tmux with node-pty

**Status:** planned, not started
**Created:** 2026-07-31
**Goal:** Remove tmux dependency entirely. Replace with vendored holdpty code running on node-pty. Gain native Windows support.

## Why

1. **Remove system dependency** — tmux must be installed separately (`sudo apt install tmux`). Developers have it, but it's still an extra step.
2. **Cross-platform** — tmux works on Linux/macOS/WSL, but NOT native Windows. node-pty runs native Win/Linux/macOS via forkpty + ConPTY.
3. **Simplify stack** — node-pty is already an npm dependency. Adding tmux on top is redundant.
4. **Better control** — owning the session layer means we can fix things that tmux makes hard (keystroke handling on Android, proper session lifecycle, custom protocols).
5. **Single binary dream** — long term: bundle AirPrompt as a single executable (node + pty bindings). tmux makes that impossible.

## Decision: vendoring, not fork

holdpty is **archived** (read-only since May 2026). No upstream to contribute to. Strategy:

- **Copy** `src/` files from holdpty into AirPrompt
- **Rename** classes/functions to `AirPrompt*` prefix (avoid name collisions)
- **Adapt** transport layer from Unix sockets → WebSocket
- **Integrate** with AirPrompt's existing session registry
- **No external dependency** on holdpty — it becomes AirPrompt code

## What AirPrompt uses tmux for (12 features)

| # | Feature | holdpty equivalent | Status |
|---|---------|-------------------|--------|
| 1 | `new-session -d` (detached session) | `holder.ts` — spawns PTY, keeps alive | Exists |
| 2 | `attach-session` (connect to session) | `client.ts` → `attach()` — interactive mode | Exists |
| 3 | `has-session` (session exists?) | `session.ts` → `isSessionActive()` | Exists |
| 4 | `kill-session` (destroy session) | `holder.ts` → `kill()` + `session.ts` → `removeSession()` | Exists |
| 5 | `send-keys` (inject text, no attach) | `client.ts` → `send()` — non-exclusive write | Exists |
| 6 | `list-clients` (attached client count) | `holder.ts` tracks `ClientConnection[]` | Exists |
| 7 | `display-message` (session metadata) | Own registry (`session.ts` metadata) | Exists |
| 8 | `set-option` (status bar, focus-events) | N/A — no status bar in raw PTY | Not needed |
| 9 | Clipboard buffers | N/A — use OS clipboard directly | Not needed |
| 10 | `list-panes` / `respawn-pane` (zombie handling) | N/A — no panes, just one PTY per session | Not needed |
| 11 | Session grouping (parent/child) | N/A — each PTY is independent | Not needed |
| 12 | Ring buffer / scrollback replay | `ring-buffer.ts` — 1MB ring buffer | Exists |

**Verdict:** 8/12 features already exist in holdpty. 4 are tmux-specific and not needed in a node-pty world.

## holdpty source files (14 files, ~1,800 loc TypeScript)

| File | LOC | Role |
|------|-----|------|
| `holder.ts` | ~300 | Core: PTY owner, ring buffer, Unix socket server, client management |
| `protocol.ts` | ~200 | Binary protocol: 8 message types (DATA_OUT, DATA_IN, RESIZE, EXIT, HELLO, HELLO_ACK, REPLAY_END, ERROR) |
| `client.ts` | ~250 | Client side: connect(), attach(), view(), logs(), send(), waitForExit() |
| `session.ts` | ~150 | Filesystem registry: metadata CRUD, listing, stale cleanup |
| `ring-buffer.ts` | ~80 | 1MB ring buffer with line tracking |
| `cli.ts` | ~200 | CLI interface (8 subcommands) — we replace this with REST API |
| `platform.ts` | ~50 | Cross-platform abstractions (socket paths, shell resolution) |
| `line-filter.ts` | ~60 | Line-based output filtering |
| `e2e.test.ts` | ~150 | End-to-end tests |
| `integration.test.ts` | ~100 | Integration tests |
| `line-filter.test.ts` | ~60 | Line filter tests |
| `platform.test.ts` | ~40 | Platform tests |
| `protocol.test.ts` | ~80 | Protocol encode/decode tests |
| `ring-buffer.test.ts` | ~70 | Ring buffer tests |

## holdpty protocol (binary, 8 message types)

```
Frame: [1 byte type] [4 bytes payload length BE] [payload]
MAX_PAYLOAD = 10 MB

0x01 DATA_OUT     → holder → client: PTY output
0x02 DATA_IN      → client → holder: keyboard input
0x03 RESIZE       → client → holder: cols (uint16) + rows (uint16)
0x04 EXIT         → holder → client: exit code (int32)
0x05 ERROR        → bidir: error message (UTF-8 string)
0x06 HELLO        → client → holder: {mode, protocolVersion, name?, dimensions?, pid?}
0x07 HELLO_ACK    → holder → client: {sessionName, cols, rows, pid}
0x08 REPLAY_END   → holder → client: ring buffer replay complete
```

**Connection modes:** `attach` (exclusive writer), `view` (read-only), `logs` (disconnect after replay), `wait` (wait for exit, no output), `send` (write-only, non-exclusive)

## Integration plan — 5 phases

### Phase 1: Vendor the code (0.5 day)

- Copy `holder.ts`, `client.ts`, `protocol.ts`, `session.ts`, `ring-buffer.ts`, `platform.ts`, `line-filter.ts` into `src/holdpty/`
- Rename classes: `Holder` → `AirPromptHolder`, `SessionManager` → keep separate (we have our own)
- Port tests to use our test infrastructure
- Remove `cli.ts` (AirPrompt has its own CLI via `bin/airprompt`)

### Phase 2: Replace Unix sockets with WebSocket (1 day)

This is the biggest change. holdpty uses Unix domain sockets (`holder.ts` creates socket, `client.ts` connects). AirPrompt needs WebSocket transport.

**Plan:**

- `holder.ts` → `airprompt-session.ts`: Replace `net.createServer()` with WebSocket server. Each session is a WS endpoint or multiplexed through the daemon WS.
- `client.ts` → `airprompt-web-client.js`: The browser xterm.js already has WS — just change the protocol framing.
- Protocol frames stay binary — WebSocket supports binary frames natively. `ws.send(encodeFrame(...))` on server, `ws.onmessage` on client.

**Decision:** Each session gets its own holder process (child process spawned by daemon). Daemon communicates with holder via IPC (child_process `send()` / `message`). Browser connects to daemon WS, daemon relays to holder. This avoids exposing individual session ports.

```
Browser WS ───> daemon (server.js) ──IPC──> holder process (session)
```

### Phase 3: Relax exclusive writer lock (0.5 day)

holdpty's `attach` mode is exclusive (one writer). AirPrompt needs multiple web clients writing to same PTY.

**Changes in `client.ts` `attach()` equivalent:**
- Remove `writer` flag check in handshake
- Allow multiple `DATA_IN` senders regardless of mode
- `send()` already supports this — just make `attach()` not claim exclusivity

### Phase 4: Integrate with AirPrompt session registry (1 day)

AirPrompt has its own session tracking: daemon `Map` + disk markers (`~/.claude/.airprompt/sessions/`).

**Decision:** Keep AirPrompt's registry. Don't use holdpty's `session.ts`.

What changes:
- `register` endpoint creates holder process + writes disk markers (same as today)
- `unregister` kills holder process + removes markers
- Daemon stale sweep checks holder process aliveness (already has PID)
- Session recovery on daemon restart: list disk markers, respawn holders where tmux was used

**Session state machine stays the same:**

```
airprompt on → POST /api/sessions/register → spawn holder → write markers
airprompt off → POST /api/sessions/unregister → kill holder → remove markers
client connect → WS → daemon → find session → relay to holder
```

### Phase 5: Remove tmux from codebase (0.5 day)

Once all sessions run through holder processes:

- Remove `spawnSync('tmux', ...)` calls from all files
- Remove `airprompt-daemon` tmux session — daemon runs directly (systemd or nohup)
- Remove `airprompt-claude` tmux wrapper → Claude runs in holder process
- Remove tmux from README requirements
- Update install script: tmux → optional, not required

## Migration strategy

**Backward compatible.** Phase 1-4 can ship while tmux is still in use. Old sessions use tmux, new sessions use holder processes. Feature flag in daemon.json:

```json
{ "sessionBackend": "tmux" }  // default
{ "sessionBackend": "pty" }   // opt-in to new backend
```

Once `pty` backend is stable for a release, flip default. One release later, delete tmux code.

## Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| holdpty is archived, no upstream fixes | Vendored code is small (~1,800 loc) and self-contained. We own it. |
| PTY lifecycle bugs (orphaned processes) | Same orphan killer pattern from Layer C — daemon sweep checks PID aliveness |
| Cross-platform Windows PTY quirks | node-pty has ConPTY support. Test on Windows before flipping default. |
| Protocol overhead vs raw tmux PTY | Binary protocol is 5-byte header + payload. Negligible vs tmux overhead. |
| Multiple writers corrupting PTY state | tmux handles this natively. Without tmux, PTY serializes writes via OS tty layer. Acceptable for our use case (one human typing at a time). |

## Estimated effort

| Phase | Description | Duration |
|-------|-------------|----------|
| 1 | Vendor source code | 0.5 day |
| 2 | WebSocket transport | 1 day |
| 3 | Multi-writer support | 0.5 day |
| 4 | Session registry integration | 1 day |
| 5 | Remove tmux | 0.5 day |
| **Total** | | **3.5 days** |

## References

- [holdpty GitHub](https://github.com/marcfargas/holdpty) — archived, read-only since May 2026
- [node-pty](https://github.com/microsoft/node-pty) — `forkpty(3)` bindings, cross-platform (Linux/macOS/Windows)
- [rmux](https://github.com/Helvesec/rmux) — Rust tmux alternative, 90+ commands compatible, v0.9.1 (evaluated, rejected: separate daemon, multi-file install)
- [Current tmux feature usage table](../README.md#tmux-feature-usage) — what we'd need to replace
