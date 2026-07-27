#!/usr/bin/env node
// airprompt-deactivate.js — Stop hook.
// Unregisters this Claude session from the AirPrompt daemon.
// Stops daemon if no sessions remain.
//
// Guards against spurious Stop hook invocations by checking
// whether the registered tmux session is still alive before cleaning up.

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');
const { spawnSync } = require('child_process');

const PORT = process.env.AIRPROMPT_PORT || 3210;
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PID_FILE = '/tmp/airprompt-server.pid';
const SESSION_FILE = path.join(CONFIG_DIR, '.airprompt-session');
const MARKER = path.join(CONFIG_DIR, '.airprompt-active');
const URL_FILE = path.join(CONFIG_DIR, '.airprompt-url');
const TMUX_ACTIVE_FILE = path.join(CONFIG_DIR, '.airprompt-tmux-active');
const TMUX_SESSION_FILE = path.join(CONFIG_DIR, '.airprompt-tmux-session');

const CERT_FILE = path.join(CONFIG_DIR, 'airprompt-cert.pem');
const KEY_FILE = path.join(CONFIG_DIR, 'airprompt-key.pem');
const TLS = process.env.AIRPROMPT_NO_TLS !== '1' && fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE);
const API = `${TLS ? 'https' : 'http'}://localhost:${PORT}`;

const DEBUG = process.env.AIRPROMPT_DEBUG === '1';

function dlog(msg) {
  if (!DEBUG) return;
  try {
    const ts = new Date().toISOString();
    const logFile = '/tmp/airprompt-deactivate-debug.log';
    fs.appendFileSync(logFile, `[${ts}] PID=${process.pid} ${msg}\n`);
  } catch (_) {}
}

dlog(`INVOKED CONFIG_DIR=${CONFIG_DIR} PORT=${PORT} TLS=${TLS} HOME=${process.env.HOME} TMUX=${process.env.TMUX || '(unset)'}`);

async function main() {
  // 1. Read session ID
  let sessionId = '';
  try {
    sessionId = fs.readFileSync(SESSION_FILE, 'utf8').trim().slice(0, 128);
    dlog(`sessionId='${sessionId}' from ${SESSION_FILE}`);
  } catch (_) {
    dlog(`no session file at ${SESSION_FILE} — exit 0`);
    process.exit(0);
  }

  if (!sessionId) { dlog('sessionId empty — exit 0'); process.exit(0); }

  // 2. Guard: check if the registered tmux session is still alive.
  // Try multiple sources — .airprompt-tmux-active (primary) and
  // .airprompt-tmux-session (fallback). Both are written by airprompt-on.sh.
  let registeredTmux = '';
  for (const f of [TMUX_ACTIVE_FILE, TMUX_SESSION_FILE]) {
    try {
      registeredTmux = fs.readFileSync(f, 'utf8').trim().slice(0, 128);
      if (registeredTmux) { dlog(`registeredTmux='${registeredTmux}' from ${f}`); break; }
    } catch (_) {
      dlog(`file ${f} not readable — ${_.message}`);
    }
  }

  // Last-resort guard: if no file was readable, check whether ANY tmux
  // session from the same session group is still alive. If we can't even
  // run tmux, err on the safe side and refuse cleanup.
  if (!registeredTmux) {
    dlog('GUARD: no registeredTmux from files — trying session group check');
    try {
      const r = spawnSync('tmux', ['display-message', '-p', '#{session_group}'], {
        timeout: 2000, encoding: 'utf8',
      });
      if (r.status === 0 && r.stdout) {
        const group = r.stdout.trim();
        dlog(`GUARD: current session_group='${group}'`);
        // If we're inside a session group, check whether the group itself
        // exists as a tmux session (it does for group-named sessions).
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
    // If we truly can't confirm anything, play it safe and exit.
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
    // Server returns { ok: true } on success, or error message on refusal.
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

  // 4. Remove all marker files (only if server confirmed or is unreachable)
  try { fs.unlinkSync(MARKER); } catch (_) {}
  try { fs.unlinkSync(URL_FILE); } catch (_) {}
  try { fs.unlinkSync(SESSION_FILE); } catch (_) {}
  try { fs.unlinkSync(TMUX_ACTIVE_FILE); } catch (_) {}
  try { fs.unlinkSync(TMUX_SESSION_FILE); } catch (_) {}

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

function post(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = {
      hostname: 'localhost', port: PORT, path, method: 'POST',
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

function get(path) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: 'localhost', port: PORT, path, method: 'GET', timeout: 3000 };
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
