#!/usr/bin/env node
// airprompt-activate.js — SessionStart hook.
// Ensures the AirPrompt daemon is running and registers this Claude session.
// Runs on every Claude Code session start. Idempotent — re-register is safe.
// Per-session isolation: writes to ~/.claude/.airprompt/sessions/{safe-name}/
// Multiple Claude sessions can coexist without fighting over global files.

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

const PORT = (() => {
  // daemon.json SSOT → env fallback → default
  try {
    const dj = path.join(CONFIG_DIR, '.airprompt', 'daemon.json');
    if (fs.existsSync(dj)) {
      const info = JSON.parse(fs.readFileSync(dj, 'utf8'));
      if (info.port) return info.port;
    }
  } catch (_) {}
  return process.env.PORT || process.env.AIRPROMPT_PORT || 3210;
})();
const AIRPROMPT_DIR = path.join(os.homedir(), '.airprompt');
const PID_FILE = process.env.AIRPROMPT_PID_FILE || '/tmp/airprompt-server.pid';
const SESSIONS_DIR = path.join(CONFIG_DIR, '.airprompt', 'sessions');

// Resolve install dir — prefer CLAUDE_PLUGIN_ROOT (plugin installed),
// fallback to ~/.airprompt/ (standalone manual install),
// then ~/projects/airprompt/ (dev checkout, same as dispatcher and autostart).
const DEV_DIR = path.join(os.homedir(), 'projects', 'airprompt');
const INSTALL_DIR = process.env.CLAUDE_PLUGIN_ROOT
  || (fs.existsSync(path.join(AIRPROMPT_DIR, 'server.js')) ? AIRPROMPT_DIR : DEV_DIR);

// Detect TLS — daemon.json SSOT → cert fallback → http
const AIRPROMPT_DATA_DIR = path.join(CONFIG_DIR, '.airprompt');
const DAEMON_JSON = path.join(AIRPROMPT_DATA_DIR, 'daemon.json');
let TLS = false;
try {
  if (fs.existsSync(DAEMON_JSON)) {
    const info = JSON.parse(fs.readFileSync(DAEMON_JSON, 'utf8'));
    TLS = info.protocol === 'https';
  }
} catch (_) {}
if (!TLS) {
  const CERT_FILE = path.join(AIRPROMPT_DATA_DIR, 'airprompt-cert.pem');
  const KEY_FILE = path.join(AIRPROMPT_DATA_DIR, 'airprompt-key.pem');
  TLS = process.env.AIRPROMPT_NO_TLS !== '1' && fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE);
}

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (_) { return false; } }

function daemonRunning() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    return pidAlive(pid);
  } catch (_) { return false; }
}

function startDaemon() {
  const serverJs = path.join(INSTALL_DIR, 'server.js');
  if (!fs.existsSync(serverJs)) {
    process.stderr.write(`airprompt: server.js not found at ${serverJs}\n`);
    return false;
  }
  const env = { ...process.env, PORT: String(PORT) };
  const child = spawn('node', [serverJs], {
    cwd: INSTALL_DIR, env, detached: true, stdio: 'ignore',
  });
  child.unref();
  for (let i = 0; i < 30; i++) {
    if (daemonRunning()) return true;
    const ms = (i < 10) ? 0.1 : 0.3;
    try { spawnSync('sleep', [String(ms)], { timeout: 1000 }); } catch (_) {}
  }
  return daemonRunning();
}

function request(method, p, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = {
      hostname: 'localhost', port: PORT, path: p, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 5000,
    };
    const mod = TLS ? https : http;
    if (TLS) opts.rejectUnauthorized = false;
    const req = mod.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (_) { resolve({ raw: data }); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function post(p, body) { return request('POST', p, body); }

function put(p, body) { return request('PUT', p, body); }

// Auto-apply project name from global cwd→name mapping.
// Called after session registration so autostart picks up saved names.
function autoApplyName(sessionId, cwd, myDir) {
  const namesFile = path.join(AIRPROMPT_DATA_DIR, 'project-names.json');
  let map;
  try { map = JSON.parse(fs.readFileSync(namesFile, 'utf8')); } catch (_) { return; }
  const savedName = map[cwd];
  if (!savedName) return;
  put('/api/sessions/name', { sessionId, name: savedName }).then((resp) => {
    if (resp && resp.ok) {
      process.stdout.write(`airprompt: auto-named '${savedName}'\n`);
      try { fs.writeFileSync(path.join(myDir, 'name'), savedName + '\n'); } catch (_) {}
    }
  }).catch(() => {});
}

// Same sanitization as statusline.sh: `tr -cd 'a-zA-Z0-9_.-'`
function safeDirName(name) {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '');
}

// Detect current tmux session, resolving web proxy sessions to parent group
function detectTmux() {
  let tmux = '';
  if (process.env.TMUX) {
    const r = spawnSync('tmux', ['display-message', '-p', '#S'], { timeout: 2000, encoding: 'utf8' });
    if (r.status === 0) {
      tmux = r.stdout.toString().trim();
      if (tmux.startsWith('airprompt-web-')) {
        const r2 = spawnSync('tmux', ['display-message', '-p', '#{session_group}'], { timeout: 2000, encoding: 'utf8' });
        if (r2.status === 0 && r2.stdout.trim()) tmux = r2.stdout.trim();
      }
    }
  }
  return tmux;
}

// Clean up session directories whose tmux sessions are dead
function sweepDeadSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return;
  let entries;
  try { entries = fs.readdirSync(SESSIONS_DIR); } catch (_) { return; }
  for (const entry of entries) {
    const full = path.join(SESSIONS_DIR, entry);
    if (!fs.statSync(full).isDirectory()) continue;
    // Read real tmux session name from dir — dir name is sanitized,
    // real name may differ (e.g. "My Session!" vs "MySession").
    let realTmux = entry;
    try { realTmux = fs.readFileSync(path.join(full, 'tmux'), 'utf8').trim().slice(0, 128); } catch (_) {}
    const r = spawnSync('tmux', ['has-session', '-t', realTmux], { timeout: 2000 });
    // Only delete if tmux explicitly says session doesn't exist (exit code 1).
    // status null = timeout/error → don't touch (safe).
    if (r.status === 1) {
      // Best-effort unregister from daemon before deleting local dir
      try {
        const sid = fs.readFileSync(path.join(full, 'session'), 'utf8').trim().slice(0, 128);
        if (sid) post('/api/sessions/unregister', { sessionId: sid, force: true }).catch(() => {});
      } catch (_) {}
      try { fs.rmSync(full, { recursive: true, force: true }); } catch (_) {}
    }
  }
}

function getLanIp() {
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
      }
    }
  } catch (_) {}
  return 'localhost';
}

async function main() {
  // 1. Ensure daemon is running
  if (!daemonRunning()) {
    process.stdout.write('airprompt: starting daemon...');
    if (!startDaemon()) {
      process.stderr.write('failed\nairprompt: could not start daemon on port ' + PORT + '\n');
      process.exit(0);
    }
    process.stdout.write('done\n');
  }

  // 2. Detect current tmux session
  const currentTmux = detectTmux();

  // 3. Idempotency: check per-session dir (no cross-session conflicts possible)
  // Daemon recovers state from on-disk markers on startup, so a simple
  // file check is sufficient — no need to double-check with daemon API.
  if (currentTmux) {
    const safeName = safeDirName(currentTmux);
    const myDir = path.join(SESSIONS_DIR, safeName);
    const activeFile = path.join(myDir, 'active');
    if (fs.existsSync(activeFile)) {
      process.stdout.write('airprompt: session already registered (from /airprompt on)\n');
      // Still auto-apply project name mapping
      let sid = '';
      try { sid = fs.readFileSync(path.join(myDir, 'session'), 'utf8').trim().slice(0, 128); } catch (_) {}
      if (sid) autoApplyName(sid, process.cwd(), myDir);
      sweepDeadSessions();
      return;
    }
  }

  // 4. Generate session ID
  const cwd = process.cwd();
  const cwdSafe = path.basename(cwd).replace(/[^a-zA-Z0-9_-]/g, '');
  const sessionId = `${Date.now()}-${process.pid}-${cwdSafe}`;

  // 5. Resolve tmux session (reuse currentTmux, or create one)
  let tmuxSession = currentTmux;
  if (!tmuxSession) {
    tmuxSession = `airprompt-${sessionId}`;
    spawnSync('tmux', ['new-session', '-d', '-s', tmuxSession, '-c', cwd], { timeout: 2000 });
  }

  // 6. Register with daemon
  try {
    const resp = await post('/api/sessions/register', { sessionId, cwd, tmuxSession });
    if (resp && resp.ok) {
      // Write per-session markers (wrapped in try-catch for disk errors)
      const safeName = safeDirName(tmuxSession);
      const myDir = path.join(SESSIONS_DIR, safeName);
      const lanIp = getLanIp();
      const url = `${TLS ? 'https' : 'http'}://${lanIp}:${PORT}`;

      let markersWritten = false;
      try {
        fs.mkdirSync(myDir, { recursive: true });
        fs.writeFileSync(path.join(myDir, 'url'), url + '\n');
        fs.writeFileSync(path.join(myDir, 'session'), sessionId + '\n');
        fs.writeFileSync(path.join(myDir, 'tmux'), tmuxSession + '\n');
        fs.writeFileSync(path.join(myDir, 'active'), '');
        markersWritten = true;
      } catch (e) {
        process.stderr.write(`airprompt: marker write failed: ${e.message}\n`);
        // Daemon registration succeeded but local markers failed.
        // Try to unregister to avoid orphaned daemon entry.
        try { await post('/api/sessions/unregister', { sessionId, force: true }); } catch (_) {}
        return;
      }

      process.stdout.write(`airprompt: registered ${sessionId}\n`);
      process.stdout.write(`airprompt: mobile URL ${url}\n`);

      // Auto-apply saved project name
      autoApplyName(sessionId, cwd, myDir);

      sweepDeadSessions();
    } else {
      process.stderr.write(`airprompt: registration failed: ${JSON.stringify(resp)}\n`);
    }
  } catch (e) {
    process.stderr.write(`airprompt: cannot reach daemon on port ${PORT} — ${e.message}\n`);
  }
}

main().catch(() => process.exit(0));
