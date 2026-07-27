#!/usr/bin/env node
// airprompt-activate.js — SessionStart hook.
// Ensures the AirPrompt daemon is running and registers this Claude session.
// Runs on every Claude Code session start. Idempotent — re-register is safe.
// Per-session isolation: writes to ~/.claude/.airprompt-sessions/{tmux-name}/
// Multiple Claude sessions can coexist without fighting over global files.

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const PORT = process.env.AIRPROMPT_PORT || 3210;
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const AIRPROMPT_DIR = path.join(os.homedir(), '.airprompt');
const PID_FILE = '/tmp/airprompt-server.pid';
const SESSIONS_DIR = path.join(CONFIG_DIR, '.airprompt-sessions');

// Legacy global markers (cleaned up during migration)
const OLD_MARKERS = [
  path.join(CONFIG_DIR, '.airprompt-active'),
  path.join(CONFIG_DIR, '.airprompt-url'),
  path.join(CONFIG_DIR, '.airprompt-session'),
  path.join(CONFIG_DIR, '.airprompt-tmux-active'),
  path.join(CONFIG_DIR, '.airprompt-tmux-session'),
  path.join(CONFIG_DIR, '.airprompt-name'),
];

// Resolve install dir — prefer CLAUDE_PLUGIN_ROOT (plugin installed),
// fallback to ~/.airprompt/ (standalone manual install).
const INSTALL_DIR = process.env.CLAUDE_PLUGIN_ROOT || AIRPROMPT_DIR;

// Detect TLS
const CERT_FILE = path.join(CONFIG_DIR, 'airprompt-cert.pem');
const KEY_FILE = path.join(CONFIG_DIR, 'airprompt-key.pem');
const TLS = process.env.AIRPROMPT_NO_TLS !== '1' && fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE);

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

function post(p, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = {
      hostname: 'localhost', port: PORT, path: p, method: 'POST',
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
    const r = spawnSync('tmux', ['has-session', '-t', entry], { timeout: 2000 });
    // Only delete if tmux explicitly says session doesn't exist (exit code 1).
    // status null = timeout/error → don't touch (safe).
    if (r.status === 1) {
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
    const myDir = path.join(SESSIONS_DIR, currentTmux);
    const activeFile = path.join(myDir, 'active');
    if (fs.existsSync(activeFile)) {
      process.stdout.write('airprompt: session already registered (from /airprompt on)\n');
      // Still sweep dead sessions and old markers — housekeeping
      sweepDeadSessions();
      OLD_MARKERS.forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });
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
      // Write per-session markers
      const myDir = path.join(SESSIONS_DIR, tmuxSession);
      fs.mkdirSync(myDir, { recursive: true });
      const lanIp = getLanIp();
      const url = `${TLS ? 'https' : 'http'}://${lanIp}:${PORT}`;
      fs.writeFileSync(path.join(myDir, 'url'), url + '\n');
      fs.writeFileSync(path.join(myDir, 'session'), sessionId + '\n');
      fs.writeFileSync(path.join(myDir, 'tmux'), tmuxSession + '\n');
      fs.writeFileSync(path.join(myDir, 'active'), '');
      process.stdout.write(`airprompt: registered ${sessionId}\n`);
      process.stdout.write(`airprompt: mobile URL ${url}\n`);

      // Housekeeping: clean legacy global markers and dead session dirs
      OLD_MARKERS.forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });
      sweepDeadSessions();
    } else {
      process.stderr.write(`airprompt: registration failed: ${JSON.stringify(resp)}\n`);
    }
  } catch (e) {
    process.stderr.write(`airprompt: cannot reach daemon on port ${PORT} — ${e.message}\n`);
  }
}

main().catch(() => process.exit(0));
