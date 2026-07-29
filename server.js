const express = require('express');
const http = require('http');
const https = require('https');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const qrcode = require('qrcode-terminal');

const PORT = process.env.PORT || process.env.AIRPROMPT_PORT || 3210;
const PID_FILE = process.env.AIRPROMPT_PID_FILE || '/tmp/airprompt-server.pid';
const STALE_CHECK_MS = 60_000;
const DEBUG = process.env.AIRPROMPT_DEBUG === '1';

function log(level, msg, extra) {
  if (!DEBUG) return;
  const ts = new Date().toISOString();
  const extraStr = extra ? ' ' + JSON.stringify(extra) : '';
  process.stderr.write(`[airprompt:${level}] ${ts} ${msg}${extraStr}\n`);
}

const CERT_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const CERT_FILE = path.join(CERT_DIR, 'airprompt-cert.pem');
const KEY_FILE = path.join(CERT_DIR, 'airprompt-key.pem');
const TLS_ENABLED = process.env.AIRPROMPT_NO_TLS !== '1' && fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE);
const AIRPROMPT_DIR = path.join(CERT_DIR, '.airprompt');
const DAEMON_JSON = path.join(AIRPROMPT_DIR, 'daemon.json');

const sessions = new Map();

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

function tmuxExists(sessionName) {
  try {
    const r = spawnSync('tmux', ['has-session', '-t', sessionName], { timeout: 2000 });
    return r.status === 0;
  } catch (e) { return false; }
}

function createTmuxSession(sessionName, cwd) {
  try {
    const r = spawnSync('tmux', ['new-session', '-d', '-s', sessionName, '-c', cwd], { timeout: 2000 });
    return r.status === 0;
  } catch (e) { return false; }
}

function killTmuxSession(sessionName) {
  try { spawnSync('tmux', ['kill-session', '-t', sessionName], { timeout: 2000 }); } catch (e) { /* ok */ }
}

function broadcastSessionList(wss) {
  const list = Array.from(sessions.values()).map((s) => ({ id: s.sessionId, cwd: s.cwd, name: s.name || null, createdAt: s.createdAt }));
  const msg = JSON.stringify({ type: 'session_list', sessions: list });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      try { client.send(msg); } catch (e) { /* ok */ }
    }
  });
}

function writePid() {
  try {
    fs.writeFileSync(PID_FILE, String(process.pid), { flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') { console.error('PID file already exists.'); process.exit(1); }
    throw e;
  }
}

function removePid() { try { fs.unlinkSync(PID_FILE); } catch (e) { /* ok */ } }

function writeDaemonJson(protocol, port, lanIp) {
  try { fs.mkdirSync(AIRPROMPT_DIR, { recursive: true }); } catch (_) {}
  const json = JSON.stringify({ protocol, port, lanIp, url: `${protocol}://${lanIp}:${port}`, pid: process.pid });
  try { fs.writeFileSync(DAEMON_JSON, json); } catch (_) {}
}
function removeDaemonJson() { try { fs.unlinkSync(DAEMON_JSON); } catch (_) {} }

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return false; } }

// ── Startup recovery: scan per-session dirs and re-register alive sessions ──
// Daemon restart loses in-memory state. On-disk markers survive.
// Rebuild session registry from ~/.claude/.airprompt-sessions/{tmux}/
function recoverSessionsFromDisk() {
  if (process.env.AIRPROMPT_SKIP_RECOVERY === '1') return;
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const sessionsDir = path.join(configDir, '.airprompt-sessions');
  if (!fs.existsSync(sessionsDir)) return;

  let entries;
  try { entries = fs.readdirSync(sessionsDir, { withFileTypes: true }); } catch (_) { return; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(sessionsDir, entry.name);

    // Read REAL tmux session name from marker file.
    // Directory name is sanitized (a-zA-Z0-9_.-), but the actual
    // tmux session may have spaces or special characters.
    let realTmux = entry.name;
    try { realTmux = fs.readFileSync(path.join(dir, 'tmux'), 'utf8').trim().slice(0, 128); } catch (_) {}

    // Check if tmux session is still alive
    if (!tmuxExists(realTmux)) {
      // Dead session — clean up on-disk markers
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
      continue;
    }

    // Read metadata from disk
    let sessionId, name;
    try { sessionId = fs.readFileSync(path.join(dir, 'session'), 'utf8').trim().slice(0, 128); } catch (_) { sessionId = realTmux; }
    // Validate format — must match registration endpoint regex
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId)) sessionId = realTmux;
    try { name = fs.readFileSync(path.join(dir, 'name'), 'utf8').trim().slice(0, 64) || null; } catch (_) { name = null; }

    // Derive cwd from tmux session
    let cwd = process.env.HOME || '/';
    try {
      const r = spawnSync('tmux', ['display-message', '-t', realTmux, '-p', '#{pane_current_path}'], { timeout: 2000, encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) cwd = r.stdout.trim();
    } catch (_) {}

    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { sessionId, cwd, name, tmuxSession: realTmux, createdAt: new Date().toISOString() });
      log('info', 'session recovered from disk', { sessionId, tmuxSession: realTmux, cwd, name });
    }
  }

  if (sessions.size > 0) log('info', 'recovery complete', { recovered: sessions.size });
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/sessions', (_req, res) => {
    res.json(Array.from(sessions.values()).map((s) => ({ id: s.sessionId, cwd: s.cwd, name: s.name || null, createdAt: s.createdAt })));
  });

  app.post('/api/sessions/register', (req, res) => {
    const { sessionId, cwd, tmuxSession, name } = req.body || {};
    if (!sessionId || !cwd) return res.status(400).json({ error: 'Missing sessionId or cwd' });
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId)) return res.status(400).json({ error: 'Invalid sessionId format' });
    if (typeof cwd !== 'string' || cwd.length > 512) return res.status(400).json({ error: 'cwd too long' });
    if (name !== undefined && (typeof name !== 'string' || name.length > 64 || !/^[a-zA-Z0-9 _-]{1,64}$/.test(name)))
      return res.status(400).json({ error: 'Invalid name: max 64 chars, alphanumeric + spaces, dashes, underscores' });
    if (sessions.has(sessionId)) return res.status(409).json({ error: 'Session already registered' });

    let actualTmuxSession;
    if (tmuxSession && /^[a-zA-Z0-9_-]{1,64}$/.test(tmuxSession) && tmuxExists(tmuxSession)) {
      actualTmuxSession = tmuxSession;
    } else {
      actualTmuxSession = `airprompt-${sessionId}`;
      if (!tmuxExists(actualTmuxSession)) {
        if (!createTmuxSession(actualTmuxSession, cwd)) {
          return res.status(500).json({ error: 'Failed to create tmux session' });
        }
      }
    }
    // Dedupe by tmux session: two hooks may fire simultaneously with
    // different sessionIds but the same tmux session (plugin + settings.json).
    for (const [existingId, existing] of sessions) {
      if (existing.tmuxSession === actualTmuxSession) {
        // Update existing entry in-place — preserve original createdAt
        existing.cwd = cwd;
        existing.sessionId = sessionId;
        if (name !== undefined) existing.name = name || null;
        sessions.delete(existingId);
        sessions.set(sessionId, existing);
        log('info', 'session re-registered (deduped by tmux)', { oldId: existingId, newId: sessionId, tmuxSession: actualTmuxSession });
        broadcastSessionList(wss);
        return res.json({ ok: true, sessionId });
      }
    }
    sessions.set(sessionId, { sessionId, cwd, name: name || null, tmuxSession: actualTmuxSession, createdAt: new Date().toISOString() });
    log('info', 'session registered', { sessionId, tmuxSession: actualTmuxSession, cwd, name: name || null });
    broadcastSessionList(wss);
    res.json({ ok: true, sessionId });
  });

  app.post('/api/sessions/unregister', (req, res) => {
    const { sessionId, force } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
    if (!sessions.has(sessionId)) return res.status(404).json({ error: 'Session not found' });
    const entry = sessions.get(sessionId);
    // Guard: if the registered tmux session is still alive, refuse to unregister.
    // This is a server-side safety net against spurious Stop hook invocations.
    // force: true bypasses this — used by explicit /airprompt off user command.
    if (!force && entry.tmuxSession && tmuxExists(entry.tmuxSession)) {
      log('warn', 'unregister refused — tmux session still alive', { sessionId, tmuxSession: entry.tmuxSession });
      return res.status(409).json({ error: 'Session still active', ok: false });
    }
    sessions.delete(sessionId);
    log('info', 'session unregistered', { sessionId, tmuxSession: entry.tmuxSession });
    // Clean airprompt- prefixed sessions when orphaned
    if (entry.tmuxSession && entry.tmuxSession.startsWith('airprompt-')) {
      let shared = false;
      for (const [, other] of sessions) {
        if (other.tmuxSession === entry.tmuxSession) { shared = true; break; }
      }
      if (!shared) killTmuxSession(entry.tmuxSession);
    }
    // Non-airprompt tmux sessions are real Claude sessions — never kill them
    broadcastSessionList(wss);
    res.json({ ok: true });
  });

  app.post('/api/notify', (req, res) => {
    const input = req.body || {};
    if (!input.notification_type) return res.status(400).json({ error: 'Missing notification_type' });

    log('info', 'notification received', { type: input.notification_type, session_id: input.session_id });
    // Broadcast to all connected web clients
    const msg = JSON.stringify({ ...input, type: 'notification' });
    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        try { client.send(msg); } catch (e) { /* ok */ }
      }
    });
    res.json({ ok: true });
  });

  app.post('/api/sessions/kill', async (req, res) => {
    try {
      const { sessionId } = req.body || {};
      if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
      const entry = sessions.get(sessionId);
      if (!entry) return res.status(404).json({ error: 'Session not found' });

      const tmux = entry.tmuxSession;
      if (!tmux) {
        sessions.delete(sessionId);
        broadcastSessionList(wss);
        return res.json({ ok: true, killed: false, reason: 'no tmux session' });
      }

      if (!tmuxExists(tmux)) {
        sessions.delete(sessionId);
        broadcastSessionList(wss);
        return res.json({ ok: true, killed: false, reason: 'already dead' });
      }

      // Phase 1: Graceful — send `/airprompt off` into the tmux session
      spawnSync('tmux', ['send-keys', '-t', tmux, '/airprompt off', 'Enter'], { timeout: 2000 });

      // Phase 2: Wait up to 5s for session to die
      var deadline = Date.now() + 5000;
      var died = false;
      while (Date.now() < deadline) {
        await new Promise(function (r) { setTimeout(r, 300); });
        if (!tmuxExists(tmux)) { died = true; break; }
      }

      // Phase 3: If still alive, force kill (airprompt-* only)
      if (!died && tmuxExists(tmux)) {
        if (tmux.startsWith('airprompt-')) {
          spawnSync('tmux', ['kill-session', '-t', tmux], { timeout: 2000 });
        }
        // Non-airprompt sessions are real Claude sessions — never kill them.
        // The stale interval will clean up when Claude eventually exits.
      }

      sessions.delete(sessionId);
      broadcastSessionList(wss);
      res.json({ ok: true, killed: !died, graceful: died });
    } catch (err) {
      log('error', 'session kill failed', { sessionId: req.body && req.body.sessionId, error: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.put('/api/sessions/name', (req, res) => {
    const { sessionId, name } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
    if (!sessions.has(sessionId)) return res.status(404).json({ error: 'Session not found' });
    // Reject non-string non-nullish values (numbers, objects, booleans)
    if (name != null && typeof name !== 'string')
      return res.status(400).json({ error: 'name must be a string' });
    // Empty string clears the name; non-empty must pass validation
    if (typeof name === 'string' && name.length > 0 && !/^[a-zA-Z0-9 _-]{1,64}$/.test(name))
      return res.status(400).json({ error: 'Invalid name: max 64 chars, alphanumeric + spaces, dashes, underscores' });
    const entry = sessions.get(sessionId);
    const prev = entry.name;
    entry.name = (typeof name === 'string' && name.length > 0) ? name : null;
    log('info', 'session named', { sessionId, name: entry.name, prev: prev || null });
    broadcastSessionList(wss);
    res.json({ ok: true, name: entry.name });
  });

  const tlsOptions = TLS_ENABLED ? { key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CERT_FILE) } : null;
  const httpServer = tlsOptions ? https.createServer(tlsOptions, app) : http.createServer(app);
  const wss = new WebSocketServer({ server: httpServer, pingInterval: 30000, pingTimeout: 5000 });
  wss.on('error', (err) => console.error('WebSocketServer error:', err.message));

  wss.on('connection', (ws) => {
    let ptyProcess = null;
    let activeSessionId = null;
    const clientId = Math.random().toString(36).slice(2, 8);
    log('info', 'ws client connected', { clientId });

    ws.on('error', (e) => { log('warn', 'ws client error', { clientId, error: e.message }); });

    ws.send(JSON.stringify({
      type: 'session_list',
      sessions: Array.from(sessions.values()).map((s) => ({ id: s.sessionId, cwd: s.cwd, name: s.name || null, createdAt: s.createdAt })),
    }));

    function spawnPty(sessionId) {
      // Capture old pty reference before killing — its onExit/onData
      // callbacks fire asynchronously after kill(). Must compare by
      // identity, not the shared ptyProcess variable, to avoid
      // nullifying a newly-spawned pty.
      const oldPty = ptyProcess;
      if (oldPty) {
        const oldWeb = oldPty._airpromptWebSession;
        try { oldPty.kill(); } catch (e) { /* ok */ }
        ptyProcess = null;
        // Kill old webSession — prevents orphan session accumulation
        if (oldWeb) spawnSync('tmux', ['kill-session', '-t', oldWeb], { timeout: 1000 });
      }
      const entry = sessions.get(sessionId);
      if (!entry) return false;

      activeSessionId = sessionId;
      const termCols = ws._airpromptCols || 120;
      const termRows = ws._airpromptRows || 40;

      // Per-client grouped tmux session. Prefix with random suffix
      // to prevent Date.now() collisions in same-millisecond spawns.
      const rnd = Math.random().toString(36).slice(2, 6);
      const webSession = `airprompt-web-${sessionId}-${Date.now()}-${rnd}`;

      const r1 = spawnSync('tmux', ['new-session', '-d', '-t', entry.tmuxSession, '-s', webSession,
        '-x', String(termCols), '-y', String(termRows)], { timeout: 2000 });
      if (r1.status !== 0) {
        log('warn', 'tmux new-session failed', { clientId, webSession, status: r1.status, stderr: String(r1.stderr || '').trim() });
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', message: 'Failed to create terminal session' }));
        return false;
      }
      spawnSync('tmux', ['set-option', '-t', webSession, 'status', 'off'], { timeout: 1000 });
      spawnSync('tmux', ['set-option', '-t', webSession, 'pane-border-status', 'off'], { timeout: 1000 });

      const thisPty = pty.spawn('tmux', ['attach-session', '-t', webSession], {
        name: 'xterm-256color', cols: termCols, rows: termRows, cwd: entry.cwd, env: process.env,
      });
      thisPty._airpromptWebSession = webSession;
      ptyProcess = thisPty;
      log('info', 'pty spawned', { clientId, webSession, sessionId, cols: termCols, rows: termRows });

      thisPty.onData((data) => {
        // Guard: only forward data from the currently-active pty
        if (ptyProcess !== thisPty || ws.readyState !== 1) return;
        ws.send(JSON.stringify({ type: 'output', data }));
      });
      thisPty.onExit(({ exitCode, signal }) => {
        log('info', 'pty exited', { clientId, webSession, exitCode, signal: signal || 0 });
        // Guard: only clean up if THIS pty is still the active one
        if (ptyProcess !== thisPty) return;
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'output', data: '\r\n\x1b[33m[AirPrompt: session ended]\x1b[0m\r\n' }));
        ptyProcess = null;
      });

      // Notify client that PTY is ready
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'pty_spawned', sessionId }));
      return true;
    }

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) {
        log('debug', 'ws malformed message', { clientId, raw: String(raw).slice(0, 100) });
        return;
      }

      switch (msg.type) {
        case 'ping': break;  // keepalive ack — no action needed
        case 'debug':
          log('debug', '[client] ' + (msg.msg || ''), { level: msg.level, extra: msg.extra });
          break;
        case 'input':
          if (ptyProcess && msg.data) { try { ptyProcess.write(msg.data); } catch (e) { /* ok */ } }
          break;
        case 'switch_session':
          if (msg.sessionId && sessions.has(msg.sessionId)) spawnPty(msg.sessionId);
          else ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
          break;
        case 'resize':
          if (ptyProcess && typeof msg.cols === 'number' && typeof msg.rows === 'number'
            && msg.cols > 0 && msg.cols <= 500 && msg.rows > 0 && msg.rows <= 200) {
            ws._airpromptCols = msg.cols;
            ws._airpromptRows = msg.rows;
            try { ptyProcess.resize(msg.cols, msg.rows); } catch (e) { /* ok */ }
          }
          break;
        case 'list_sessions': broadcastSessionList(wss); break;
        case 'copy_buffer':
          if (msg.data) {
            try {
              spawnSync('tmux', ['load-buffer', '-'], { input: msg.data, encoding: 'utf8', timeout: 2000 });
            } catch (e) { /* ok */ }
          }
          break;
        case 'paste_buffer':
          if (ptyProcess) {
            try {
              var result = spawnSync('tmux', ['save-buffer', '-'], { encoding: 'utf8', timeout: 2000 });
              if (result.status === 0 && result.stdout) {
                ptyProcess.write(result.stdout);
              }
            } catch (e) { /* ok */ }
          }
          break;
      }
    });

    ws.on('close', () => {
      log('info', 'ws client disconnected', { clientId, activeSessionId });
      if (ptyProcess) {
        const wsess = ptyProcess._airpromptWebSession;
        try { ptyProcess.kill(); } catch (e) { /* ok */ }
        ptyProcess = null;
        if (wsess) spawnSync('tmux', ['kill-session', '-t', wsess], { timeout: 2000 });
      }
    });
  });

  const staleInterval = setInterval(() => {
    let changed = false;
    for (const [id, entry] of sessions) {
      if (!tmuxExists(entry.tmuxSession)) { sessions.delete(id); changed = true; log('warn', 'stale session removed', { id, tmuxSession: entry.tmuxSession }); }
    }
    if (changed) broadcastSessionList(wss);
  }, STALE_CHECK_MS);

  httpServer.on('close', () => clearInterval(staleInterval));
  staleInterval.unref();

  return { app, httpServer, wss, tlsOptions };
}

module.exports = { createApp, sessions };

if (require.main === module) {
  try {
    const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (pidAlive(existingPid)) {
      console.error(`AirPrompt already running (PID ${existingPid}).`);
      process.exit(1);
    }
    removePid();
  } catch (e) { /* ok */ }

  writePid();
  writeDaemonJson(TLS_ENABLED ? 'https' : 'http', PORT, getLocalIp());
  log('info', 'daemon starting', { port: PORT, pid: process.pid, tls: TLS_ENABLED, debug: DEBUG });
  // Rebuild session registry from on-disk markers BEFORE listen
  // so first WS client sees recovered sessions immediately.
  recoverSessionsFromDisk();
  const { httpServer, tlsOptions: tls } = createApp();

  httpServer.listen(PORT, '0.0.0.0', () => {
    const lanIp = getLocalIp();
    const url = `${tls ? 'https' : 'http'}://${lanIp}:${PORT}`;
    console.log('\n' + '='.repeat(50));
    console.log(`AirPrompt Server running at: ${url}`);
    if (tls) console.log('TLS: self-signed (accept warning on first connect)');
    console.log('='.repeat(50) + '\n');
    qrcode.generate(url, { small: true });
  });

  httpServer.on('error', (err) => { console.error(`Server error: ${err.message}`); removePid(); removeDaemonJson(); process.exit(1); });
  function gracefulShutdown(signal) {
    log('info', 'daemon shutting down', { signal, sessions: sessions.size });
    removePid();
    removeDaemonJson();
    process.exit(0);
  }
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));
  process.on('exit', () => { removePid(); removeDaemonJson(); });
}
