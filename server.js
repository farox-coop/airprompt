const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync, spawnSync } = require('child_process');
const qrcode = require('qrcode-terminal');

const PORT = process.env.PORT || process.env.AIRPROMPT_PORT || 3210;
const PID_FILE = '/tmp/airprompt-server.pid';
const STALE_CHECK_MS = 60_000;

// ── In-memory session registry ──────────────────────────────────────
const sessions = new Map();

// ── Helpers ─────────────────────────────────────────────────────────

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

function tmuxExists(sessionName) {
  try {
    const r = spawnSync('tmux', ['has-session', '-t', sessionName], { timeout: 2000 });
    return r.status === 0;
  } catch (e) {
    return false;
  }
}

function createTmuxSession(sessionName, cwd) {
  try {
    const r = spawnSync('tmux', ['new-session', '-d', '-s', sessionName, '-c', cwd], { timeout: 2000 });
    return r.status === 0;
  } catch (e) {
    return false;
  }
}

function killTmuxSession(sessionName) {
  try {
    spawnSync('tmux', ['kill-session', '-t', sessionName], { timeout: 2000 });
  } catch (e) {
    // session already dead — ok
  }
}

function broadcastSessionList(wss) {
  const list = Array.from(sessions.values()).map((s) => ({
    id: s.sessionId,
    cwd: s.cwd,
    createdAt: s.createdAt,
  }));
  const msg = JSON.stringify({ type: 'session_list', sessions: list });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      try { client.send(msg); } catch (e) { /* client gone between check and send */ }
    }
  });
}

// ── PID management ──────────────────────────────────────────────────

function writePid() {
  try {
    fs.writeFileSync(PID_FILE, String(process.pid), { flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') {
      console.error('PID file already exists. Remove stale file or use different port.');
      process.exit(1);
    }
    throw e;
  }
}

function removePid() {
  try { fs.unlinkSync(PID_FILE); } catch (e) { /* ok */ }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

// ── createApp (returned for testing) ────────────────────────────────

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // ── REST API ────────────────────────────────────────────────────

  app.get('/api/sessions', (_req, res) => {
    const list = Array.from(sessions.values()).map((s) => ({
      id: s.sessionId,
      cwd: s.cwd,
      createdAt: s.createdAt,
    }));
    res.json(list);
  });

  app.post('/api/sessions/register', (req, res) => {
    const { sessionId, cwd } = req.body || {};
    if (!sessionId || !cwd) {
      return res.status(400).json({ error: 'Missing sessionId or cwd' });
    }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId)) {
      return res.status(400).json({ error: 'sessionId must be 1-64 alphanumeric chars (a-z, 0-9, -, _)' });
    }
    if (typeof cwd !== 'string' || cwd.length > 512) {
      return res.status(400).json({ error: 'cwd must be a string, max 512 chars' });
    }
    if (sessions.has(sessionId)) {
      return res.status(409).json({ error: 'Session already registered' });
    }
    const tmuxSession = `airprompt-${sessionId}`;
    if (!tmuxExists(tmuxSession)) {
      if (!createTmuxSession(tmuxSession, cwd)) {
        return res.status(500).json({ error: 'Failed to create tmux session' });
      }
    }
    const entry = { sessionId, cwd, tmuxSession, createdAt: new Date().toISOString() };
    sessions.set(sessionId, entry);
    broadcastSessionList(wss);
    res.json({ ok: true, sessionId });
  });

  app.post('/api/sessions/unregister', (req, res) => {
    const { sessionId } = req.body || {};
    if (!sessionId) {
      return res.status(400).json({ error: 'Missing sessionId' });
    }
    if (!sessions.has(sessionId)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const entry = sessions.get(sessionId);
    killTmuxSession(entry.tmuxSession);
    sessions.delete(sessionId);
    broadcastSessionList(wss);
    res.json({ ok: true });
  });

  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({ server: httpServer });
  wss.on('error', (err) => console.error('WebSocketServer error:', err.message));

  // ── WebSocket handler ───────────────────────────────────────────

  wss.on('connection', (ws) => {
    let ptyProcess = null;
    let activeSessionId = null;

    ws.on('error', () => { /* prevent crash on socket error */ });

    // Send current session list on connect
    const list = Array.from(sessions.values()).map((s) => ({
      id: s.sessionId,
      cwd: s.cwd,
      createdAt: s.createdAt,
    }));
    ws.send(JSON.stringify({ type: 'session_list', sessions: list }));

    function spawnPty(sessionId) {
      if (ptyProcess) {
        try { ptyProcess.kill(); } catch (e) { /* ok */ }
        ptyProcess = null;
      }
      const entry = sessions.get(sessionId);
      if (!entry) return false;

      activeSessionId = sessionId;
      try {
        ptyProcess = pty.spawn('tmux', ['attach-session', '-t', entry.tmuxSession], {
          name: 'xterm-256color',
          cols: 80,
          rows: 30,
          cwd: entry.cwd,
          env: process.env,
        });
      } catch (e) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'error', message: 'Failed to spawn terminal: ' + e.message }));
        }
        return false;
      }

      ptyProcess.onData((data) => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'output', data }));
        }
      });

      ptyProcess.onExit(() => {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'output', data: '\r\n\x1b[33m[AirPrompt: session ended]\x1b[0m\r\n' }));
        }
        ptyProcess = null;
      });

      return true;
    }

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

      switch (msg.type) {
        case 'input':
          if (ptyProcess && msg.data) {
            try { ptyProcess.write(msg.data); } catch (e) { /* fd closed */ }
          }
          break;

        case 'switch_session': {
          if (!msg.sessionId) break;
          const entry = sessions.get(msg.sessionId);
          if (entry) {
            spawnPty(msg.sessionId);
          } else {
            ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
          }
          break;
        }

        case 'list_sessions':
          broadcastSessionList(wss);
          break;

        default:
          break;
      }
    });

    ws.on('close', () => {
      if (ptyProcess) {
        try { ptyProcess.kill(); } catch (e) { /* ok */ }
        ptyProcess = null;
      }
    });
  });

  // ── Stale session cleanup ───────────────────────────────────────

  const staleInterval = setInterval(() => {
    let changed = false;
    for (const [id, entry] of sessions) {
      if (!tmuxExists(entry.tmuxSession)) {
        sessions.delete(id);
        changed = true;
      }
    }
    if (changed) broadcastSessionList(wss);
  }, STALE_CHECK_MS);

  // Clean up interval on server close (for tests)
  httpServer.on('close', () => {
    clearInterval(staleInterval);
  });
  // Don't block process exit waiting for stale cleanup
  staleInterval.unref();

  return { app, httpServer, wss };
}

// ── Exports for testing ─────────────────────────────────────────────

module.exports = { createApp, sessions };

// ── Direct execution ────────────────────────────────────────────────

if (require.main === module) {
  // Atomically claim PID file before opening port (prevents race)
  try {
    const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (pidAlive(existingPid)) {
      console.error(`AirPrompt server already running (PID ${existingPid}).`);
      console.error(`Remove ${PID_FILE} if stale.`);
      process.exit(1);
    }
    // PID file exists but process dead — clean it
    removePid();
  } catch (e) {
    // no PID file — ok, first run
  }

  // Write PID atomically before listen to prevent two servers on different ports
  writePid();

  const { httpServer } = createApp();

  httpServer.listen(PORT, '0.0.0.0', () => {
    const lanIp = getLocalIp();
    const url = `http://${lanIp}:${PORT}`;
    console.log('\n==================================================');
    console.log(`AirPrompt Server running at: ${url}`);
    console.log('Scan QR Code from your mobile phone:');
    console.log('==================================================\n');
    qrcode.generate(url, { small: true });
  });

  httpServer.on('error', (err) => {
    console.error(`Server error: ${err.message}`);
    removePid();
    process.exit(1);
  });

  // Cleanup on exit
  process.on('SIGINT', () => { removePid(); process.exit(0); });
  process.on('SIGTERM', () => { removePid(); process.exit(0); });
  process.on('exit', () => removePid());
}
