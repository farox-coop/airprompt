#!/usr/bin/env node
// airprompt-deactivate.js — Stop hook.
// Unregisters this Claude session from the AirPrompt daemon.
// Stops daemon if no sessions remain.
//
// Guards against spurious Stop hook invocations by checking
// whether the registered tmux session is still alive before cleaning up.
// Per-session isolation: reads ~/.claude/.airprompt-sessions/{safe-tmux}/

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');
const { spawnSync } = require('child_process');

const PORT = process.env.PORT || process.env.AIRPROMPT_PORT || 3210;
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CONFIG_DIR, '.airprompt-sessions');
const PID_FILE = '/tmp/airprompt-server.pid';

const CERT_FILE = path.join(CONFIG_DIR, 'airprompt-cert.pem');
const KEY_FILE = path.join(CONFIG_DIR, 'airprompt-key.pem');
const TLS = process.env.AIRPROMPT_NO_TLS !== '1' && fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE);

const DEBUG = process.env.AIRPROMPT_DEBUG === '1';

function dlog(msg) {
  if (!DEBUG) return;
  try {
    const ts = new Date().toISOString();
    const logFile = '/tmp/airprompt-deactivate-debug.log';
    fs.appendFileSync(logFile, `[${ts}] PID=${process.pid} ${msg}\n`);
  } catch (_) {}
}

dlog(`INVOKED CONFIG_DIR=${CONFIG_DIR} PORT=${PORT} TLS=${TLS} TMUX=${process.env.TMUX || '(unset)'}`);

// Same sanitization as statusline.sh and activate.js
function safeDirName(name) {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '');
}

// ── Resolve current tmux session ──────────────────────────────────────
function resolveCurrentTmux() {
  if (process.env.TMUX) {
    let s = '';
    const r = spawnSync('tmux', ['display-message', '-p', '#S'], { timeout: 2000, encoding: 'utf8' });
    if (r.status === 0) s = r.stdout.trim();
    if (s && s.startsWith('airprompt-web-')) {
      const r2 = spawnSync('tmux', ['display-message', '-p', '#{session_group}'], { timeout: 2000, encoding: 'utf8' });
      if (r2.status === 0 && r2.stdout.trim()) s = r2.stdout.trim();
    }
    return s || '';
  }
  return '';
}

// ── Find my per-session dir ───────────────────────────────────────────
function findMyDir(currentTmux) {
  if (!fs.existsSync(SESSIONS_DIR)) return null;

  // Primary: per-session dir matching sanitized current tmux
  if (currentTmux) {
    const safeName = safeDirName(currentTmux);
    const dir = path.join(SESSIONS_DIR, safeName);
    if (fs.existsSync(path.join(dir, 'active'))) return dir;
  }

  // Fallback: scan per-session dirs for one whose registered tmux is dead.
  // The deactivate hook fires when session ends — if our tmux is already
  // dead, the dir belongs to us and is safe to clean.
  if (!currentTmux) {
    try {
      for (const name of fs.readdirSync(SESSIONS_DIR)) {
        const d = path.join(SESSIONS_DIR, name);
        if (!fs.statSync(d).isDirectory()) continue;
        let dirTmux = '';
        try { dirTmux = fs.readFileSync(path.join(d, 'tmux'), 'utf8').trim().slice(0, 128); } catch (_) {}
        if (!dirTmux) continue;
        const r = spawnSync('tmux', ['has-session', '-t', dirTmux], { timeout: 2000 });
        if (r.status === 1 && fs.existsSync(path.join(d, 'active'))) {
          return d; // Dead session — this is ours
        }
      }
    } catch (_) {}
  }

  return null;
}

// ── Read session ID from per-session dir ──────────────────────────────
function readSessionId(myDir) {
  if (!myDir) return '';
  try { return fs.readFileSync(path.join(myDir, 'session'), 'utf8').trim().slice(0, 128); } catch (_) {}
  return '';
}

// ── Read registered tmux from per-session dir ─────────────────────────
function readRegisteredTmux(myDir) {
  if (!myDir) return '';
  try { return fs.readFileSync(path.join(myDir, 'tmux'), 'utf8').trim().slice(0, 128); } catch (_) {}
  return '';
}

async function main() {
  const currentTmux = resolveCurrentTmux();
  const myDir = findMyDir(currentTmux);

  // 1. Read session ID
  let sessionId = readSessionId(myDir);
  dlog(`sessionId='${sessionId}' myDir=${myDir || 'none'} currentTmux='${currentTmux}'`);
  if (!sessionId) { dlog('sessionId empty — exit 0'); process.exit(0); }

  // 2. Guard: check if the registered tmux session is still alive.
  let registeredTmux = readRegisteredTmux(myDir);
  dlog(`registeredTmux='${registeredTmux}'`);

  if (!registeredTmux) {
    dlog('GUARD: no registeredTmux from files — trying session group check');
    try {
      const r = spawnSync('tmux', ['display-message', '-p', '#{session_group}'], {
        timeout: 2000, encoding: 'utf8',
      });
      if (r.status === 0 && r.stdout) {
        const group = r.stdout.trim();
        dlog(`GUARD: current session_group='${group}'`);
        const r2 = spawnSync('tmux', ['has-session', '-t', group], { timeout: 2000 });
        if (r2.status === 0) {
          dlog(`GUARD: session group '${group}' ALIVE → exit 0 (no cleanup)`);
          process.exit(0);
        }
      }
    } catch (_) {
      dlog(`GUARD: session group check failed (${_.message}) → exit 0 (safe)`);
      process.exit(0);
    }
    dlog('GUARD: could not confirm tmux state → exit 0 (safe, no cleanup)');
    process.exit(0);
  }

  try {
    const r = spawnSync('tmux', ['has-session', '-t', registeredTmux], { timeout: 2000 });
    dlog(`tmux has-session -t '${registeredTmux}' status=${r.status} error=${r.error ? r.error.code || r.error.message : 'none'}`);
    if (r.status === 0) {
      dlog('GUARD: tmux session ALIVE → exit 0 (no cleanup)');
      process.exit(0);
    }
    if (r.status === null || r.error) {
      dlog(`GUARD: tmux not available (status=${r.status} error=${r.error?.code}) → exit 0 (safe)`);
      process.exit(0);
    }
    dlog(`GUARD: tmux session CONFIRMED DEAD (status=${r.status}) → proceed with cleanup`);
  } catch (_) {
    dlog(`GUARD: spawnSync threw (${_.message}) → exit 0 (safe)`);
    process.exit(0);
  }

  // 3. Unregister from daemon — respect server response.
  // If server refuses (tmux still alive), don't delete local markers.
  let serverOk = false;
  try {
    const resp = await post('/api/sessions/unregister', { sessionId });
    dlog(`unregister response: ${JSON.stringify(resp)}`);
    if (resp && resp.ok) {
      serverOk = true;
    } else {
      dlog('GUARD: server refused unregister (tmux still alive) → skipping local cleanup');
      process.exit(0);
    }
  } catch (_) {
    // Daemon unreachable — session may already be gone, clean up locally.
    dlog(`unregister request failed (${_.message}) → proceeding with local cleanup`);
  }

  // 4. Remove per-session directory
  if (myDir) {
    try { fs.rmSync(myDir, { recursive: true, force: true }); } catch (_) {}
  }

  // 5. Stop daemon if no sessions remain
  try {
    const resp = await get('/api/sessions');
    const sessions = Array.isArray(resp) ? resp : [];
    if (sessions.length === 0) stopDaemon();
  } catch (_) {
    // Daemon unreachable — try killing by PID
    stopDaemon();
  }

  if (serverOk) {
    process.stdout.write(`airprompt: session ${sessionId} unregistered\n`);
  }
}

function post(p, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = {
      hostname: 'localhost', port: PORT, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 3000,
    };
    const mod = TLS ? https : http;
    if (TLS) opts.rejectUnauthorized = false;
    const req = mod.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (_) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function get(p) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: 'localhost', port: PORT, path: p, method: 'GET', timeout: 3000 };
    const mod = TLS ? https : http;
    if (TLS) opts.rejectUnauthorized = false;
    const req = mod.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (_) { resolve([]); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function stopDaemon() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    process.kill(pid, 'SIGTERM');
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
  } catch (_) {}
}

main().catch(() => process.exit(0));
