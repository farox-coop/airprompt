#!/usr/bin/env node
// airprompt-activate.js — SessionStart hook.
// Ensures the AirPrompt daemon is running and registers this Claude session.
// Runs on every Claude Code session start. Idempotent — re-register is safe.

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
const SESSION_FILE = path.join(CONFIG_DIR, '.airprompt-session');
const MARKER = path.join(CONFIG_DIR, '.airprompt-active');
const URL_FILE = path.join(CONFIG_DIR, '.airprompt-url');
const TMUX_MARKER = path.join(CONFIG_DIR, '.airprompt-tmux-session');
const TMUX_ACTIVE_FILE = path.join(CONFIG_DIR, '.airprompt-tmux-active');

// Resolve install dir — prefer CLAUDE_PLUGIN_ROOT (plugin installed),
// fallback to ~/.airprompt/ (standalone manual install).
const INSTALL_DIR = process.env.CLAUDE_PLUGIN_ROOT || AIRPROMPT_DIR;

// Detect TLS
const CERT_FILE = path.join(CONFIG_DIR, 'airprompt-cert.pem');
const KEY_FILE = path.join(CONFIG_DIR, 'airprompt-key.pem');
const TLS = process.env.AIRPROMPT_NO_TLS !== '1' && fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE);
const API = `${TLS ? 'https' : 'http'}://localhost:${PORT}`;

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
  // Fire-and-forget: daemon runs detached, unref prevents parent from
  // waiting for it. Using spawnSync here would block forever because
  // the server never exits.
  const child = spawn('node', [serverJs], {
    cwd: INSTALL_DIR, env, detached: true, stdio: 'ignore',
  });
  child.unref();
  // Poll for daemon to be ready (PID file written + HTTP responding)
  for (let i = 0; i < 30; i++) {
    if (daemonRunning()) return true;
    const ms = (i < 10) ? 100 : 300;
    require('child_process').execSync(`sleep 0.${ms}`, { timeout: 500 });
  }
  return daemonRunning();
}

function post(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = {
      hostname: 'localhost', port: PORT, path, method: 'POST',
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

async function main() {
  // 1. Ensure daemon is running
  if (!daemonRunning()) {
    process.stdout.write('airprompt: starting daemon...');
    if (!startDaemon()) {
      process.stderr.write('failed\nairprompt: could not start daemon on port ' + PORT + '\n');
      process.exit(0); // Don't block Claude from starting
    }
    process.stdout.write('done\n');
  }

  // 2. Generate session ID
  const cwd = process.cwd();
  const cwdSafe = path.basename(cwd).replace(/[^a-zA-Z0-9_-]/g, '');
  const sessionId = `${Date.now()}-${process.pid}-${cwdSafe}`;

  // 3. Detect tmux session
  let tmuxSession = '';
  if (process.env.TMUX) {
    const r = spawnSync('tmux', ['display-message', '-p', '#S'], { timeout: 2000 });
    if (r.status === 0) tmuxSession = r.stdout.toString().trim();
  }
  if (!tmuxSession && fs.existsSync(TMUX_MARKER)) {
    tmuxSession = fs.readFileSync(TMUX_MARKER, 'utf8').trim().slice(0, 128);
    try { spawnSync('tmux', ['has-session', '-t', tmuxSession], { timeout: 2000 }); } catch (_) { tmuxSession = ''; }
  }
  if (!tmuxSession) {
    tmuxSession = `airprompt-${sessionId}`;
    spawnSync('tmux', ['new-session', '-d', '-s', tmuxSession, '-c', cwd], { timeout: 2000 });
  }

  // 4. Register with daemon
  try {
    const resp = await post('/api/sessions/register', { sessionId, cwd, tmuxSession });
    if (resp && resp.ok) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(SESSION_FILE, sessionId + '\n');
      fs.writeFileSync(MARKER, '');
      fs.writeFileSync(TMUX_ACTIVE_FILE, tmuxSession + '\n');
      fs.writeFileSync(TMUX_MARKER, tmuxSession + '\n');
      const lanIp = getLanIp();
      fs.writeFileSync(URL_FILE, `${TLS ? 'https' : 'http'}://${lanIp}:${PORT}\n`);
      process.stdout.write(`airprompt: registered ${sessionId}\n`);
      process.stdout.write(`airprompt: mobile URL ${TLS ? 'https' : 'http'}://${lanIp}:${PORT}\n`);
    } else {
      process.stderr.write(`airprompt: registration failed: ${JSON.stringify(resp)}\n`);
    }
  } catch (e) {
    process.stderr.write(`airprompt: cannot reach daemon on port ${PORT} — ${e.message}\n`);
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

main().catch(() => process.exit(0));
