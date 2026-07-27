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

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return false; } }

// ── Startup recovery: scan per-session dirs and re-register alive sessions ──
// Daemon restart loses in-memory state. On-disk markers survive.
// Rebuild session registry from ~/.claude/.airprompt-sessions/{tmux}/
function recoverSessionsFromDisk() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const sessionsDir = path.join(configDir, '.airprompt-sessions');
  if (!fs.existsSync(sessionsDir)) return;

  let entries;
  try { entries = fs.readdirSync(sessionsDir); } catch (_) { return; }

  for (const entry of entries) {
    const dir = path.join(sessionsDir, entry);
    if (!fs.statSync(dir).isDirectory()) continue;

    // Check if tmux session is still alive
    if (!tmuxExists(entry)) {
      // Dead session — clean up on-disk markers
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
      continue;
    }

    // Read metadata from disk
    let sessionId, name;
    try { sessionId = fs.readFileSync(path.join(dir, 'session'), 'utf8').trim().slice(0, 128); } catch (_) { sessionId = entry; }
    try { name = fs.readFileSync(path.join(dir, 'name'), 'utf8').trim().slice(0, 64) || null; } catch (_) { name = null; }

    // Derive cwd from tmux session
    let cwd = process.env.HOME || '/';
    try {
      const r = spawnSync('tmux', ['display-message', '-t', entry, '-p', '#{pane_current_path}'], { timeout: 2000, encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) cwd = r.stdout.trim();
    } catch (_) {}

    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { sessionId, cwd, name, tmuxSession: entry, createdAt: new Date().toISOString() });
      log('info', 'session recovered from disk', { sessionId, tmuxSession: entry, cwd, name });
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
    // Only kill tmux if no other registered entry shares it
    if (entry.tmuxSession && !entry.tmuxSession.startsWith('airprompt-')) {
      let shared = false;
      for (const [, other] of sessions) {
        if (other.tmuxSession === entry.tmuxSession) { shared = true; break; }
      }
      if (!shared) {
        // session is a real Claude tmux session — never kill it
        // (airprompt- prefixed sessions are ours and can be cleaned)
      }
    }
    // Always clean airprompt- prefixed sessions when they're orphaned
    if (entry.tmuxSession && entry.tmuxSession.startsWith('airprompt-')) {
      let shared = false;
      for (const [, other] of sessions) {
        if (other.tmuxSession === entry.tmuxSession) { shared = true; break; }
      }
      if (!shared) killTmuxSession(entry.tmuxSession);
    }
    broadcastSessionList(wss);
    res.json({ ok: true });
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
      if (ptyProcess) {
        const oldWeb = ptyProcess._airpromptWebSession;
        try { ptyProcess.kill(); } catch (e) { /* ok */ }
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

      spawnSync('tmux', ['new-session', '-d', '-t', entry.tmuxSession, '-s', webSession,
        '-x', String(termCols), '-y', String(termRows)], { timeout: 2000 });
      spawnSync('tmux', ['set-option', '-t', webSession, 'status', 'off'], { timeout: 1000 });
      spawnSync('tmux', ['set-option', '-t', webSession, 'pane-border-status', 'off'], { timeout: 1000 });

      try {
        ptyProcess = pty.spawn('tmux', ['attach-session', '-t', webSession], {
          name: 'xterm-256color', cols: termCols, rows: termRows, cwd: entry.cwd, env: process.env,
        });
        ptyProcess._airpromptWebSession = webSession;
        ptyProcess._airpromptAlive = true;
        log('info', 'pty spawned', { clientId, webSession, sessionId, cols: termCols, rows: termRows });
      } catch (e) {
        // Clean up orphaned webSession on spawn failure
        spawnSync('tmux', ['kill-session', '-t', webSession], { timeout: 1000 });
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'error', message: 'Failed to spawn: ' + e.message }));
        return false;
      }

      ptyProcess.onData((data) => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'output', data })); });
      ptyProcess.onExit(({ exitCode, signal }) => {
        log('info', 'pty exited', { clientId, webSession, exitCode, signal: signal || 0 });
        // Guard: only notify if this ptyProcess is still the active one
        // (prevents stale onExit from old pty overwriting new pty's state)
        if (!ptyProcess || !ptyProcess._airpromptAlive) return;
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'output', data: '\r\n\x1b[33m[AirPrompt: session ended]\x1b[0m\r\n' }));
        ptyProcess = null;
      });
      return true;
    }

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

      switch (msg.type) {
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
  log('info', 'daemon starting', { port: PORT, pid: process.pid, tls: TLS_ENABLED, debug: DEBUG });
  const { httpServer, tlsOptions: tls } = createApp();

  httpServer.listen(PORT, '0.0.0.0', () => {
    // Rebuild session registry from on-disk markers (survives daemon restart)
    recoverSessionsFromDisk();
    const lanIp = getLocalIp();
    const url = `${tls ? 'https' : 'http'}://${lanIp}:${PORT}`;
    console.log('\n' + '='.repeat(50));
    console.log(`AirPrompt Server running at: ${url}`);
    if (tls) console.log('TLS: self-signed (accept warning on first connect)');
    console.log('='.repeat(50) + '\n');
    qrcode.generate(url, { small: true });
  });

  httpServer.on('error', (err) => { console.error(`Server error: ${err.message}`); removePid(); process.exit(1); });
  function gracefulShutdown(signal) {
    log('info', 'daemon shutting down', { signal, sessions: sessions.size });
    removePid();
    process.exit(0);
  }
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));
  process.on('exit', () => removePid());
}
