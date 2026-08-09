// src/hooks/core/activate.js — Shared session activation logic.
//
// Provider-agnostic. Called by per-IDE wrapper hooks after parsing stdin.
// Handles: daemon startup, tmux detection, session registration, marker files,
// dead session sweeping, project name auto-apply.
//
// Exports: activateSession(ctx) → Promise<HookResult>

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const { resolveInstallDir, sessionsRootDir, sessionDir } = require('../../providers/provider');
const { post, put, detectTls, resolvePort, stateDir } = require('./shared');

// ── TLS cert auto-generation ──────────────────────────────────────────────

function ensureCerts(installDir) {
  if (process.env.AIRPROMPT_NO_TLS === '1') return;
  const sd = stateDir();
  const certFile = path.join(sd, 'airprompt-cert.pem');
  const keyFile = path.join(sd, 'airprompt-key.pem');
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) return;
  const genScript = path.join(installDir, 'bin', 'generate-cert.sh');
  if (!fs.existsSync(genScript)) return;
  spawnSync('bash', [genScript], { stdio: 'inherit', timeout: 10000 });
}

// ── Daemon management ─────────────────────────────────────────────────────

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function daemonRunning(pidFile) {
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    return pidAlive(pid);
  } catch (_) { return false; }
}

function startDaemon(installDir, port, pidFile) {
  // Clean stale PID file before spawning — server.js writePid() uses 'wx'
  // (exclusive write) which fails if the file exists, even if the PID is dead.
  if (fs.existsSync(pidFile) && !daemonRunning(pidFile)) {
    try { fs.unlinkSync(pidFile); } catch (_) {}
  }
  const serverJs = path.join(installDir, 'server.js');
  if (!fs.existsSync(serverJs)) {
    process.stderr.write(`airprompt: server.js not found at ${serverJs}\n`);
    return false;
  }
  const env = { ...process.env, PORT: String(port) };
  const child = spawn('node', [serverJs], {
    cwd: installDir, env, detached: true, stdio: 'ignore',
  });
  child.on('error', (err) => {
    process.stderr.write(`airprompt: daemon spawn failed: ${err.message}\n`);
  });
  child.unref();
  for (let i = 0; i < 30; i++) {
    if (daemonRunning(pidFile)) return true;
    const ms = (i < 10) ? 0.1 : 0.3;
    try { spawnSync('sleep', [String(ms)], { timeout: 1000 }); } catch (_) {}
  }
  return daemonRunning(pidFile);
}

// ── Tmux detection ────────────────────────────────────────────────────────

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

// ── Network ────────────────────────────────────────────────────────────────

function getLanIp() {
  try {
    const ifaces = os.networkInterfaces();
    // Collect all candidates, then pick the best one
    const candidates = [];
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          candidates.push({ name, address: iface.address });
        }
      }
    }
    // Prefer non-docker/non-bridge interfaces (filter 172.x and docker0/br-*)
    for (const c of candidates) {
      if (!c.address.startsWith('172.') && !c.address.startsWith('10.')
          && !c.name.startsWith('docker') && !c.name.startsWith('br-')
          && !c.name.startsWith('veth') && !c.name.startsWith('virbr')) {
        return c.address;
      }
    }
    // Fallback: any non-internal is better than localhost
    if (candidates.length > 0) return candidates[0].address;
  } catch (_) {}
  return 'localhost';
}

// ── Dead session sweep ────────────────────────────────────────────────────

function sweepDeadSessions(sessionsDir, port, tls) {
  if (!fs.existsSync(sessionsDir)) return;
  // Safety: only sweep dirs under ~/.airprompt/sessions/
  if (!sessionsDir.includes('.airprompt')) return;
  let entries;
  try { entries = fs.readdirSync(sessionsDir); } catch (_) { return; }
  for (const entry of entries) {
    const full = path.join(sessionsDir, entry);
    try { if (!fs.statSync(full).isDirectory()) continue; } catch (_) { continue; }
    // Read REAL tmux session name from marker. Dir name is {providerId}-{safeName}
    // so it can't be used as a fallback tmux name.
    let realTmux = '';
    try { realTmux = fs.readFileSync(path.join(full, 'tmux'), 'utf8').trim().slice(0, 128); } catch (_) {}
    if (!realTmux) continue;
    const r = spawnSync('tmux', ['has-session', '-t', realTmux], { timeout: 2000 });
    // Only delete on explicit "no session" (exit 1). Other codes (tmux error,
    // timeout, missing binary) must not trigger data loss.
    if (r.status === 1) {
      try {
        const sid = fs.readFileSync(path.join(full, 'session'), 'utf8').trim().slice(0, 128);
        if (sid) post('/api/sessions/unregister', { sessionId: sid, force: true }, port, tls).catch(() => {});
      } catch (_) {}
      try { fs.rmSync(full, { recursive: true, force: true }); } catch (_) {}
    }
  }
}

// ── Project name auto-apply ───────────────────────────────────────────────

async function autoApplyName(sessionId, cwd, myDir, port, tls) {
  const nameFilePath = path.join(myDir, 'name');
  let resolvedName = null;

  // 1. Existing name file (written by airprompt-launch)
  try {
    if (fs.existsSync(nameFilePath)) {
      const existing = fs.readFileSync(nameFilePath, 'utf8').trim().slice(0, 64);
      if (existing && /^[a-zA-Z0-9 _-]+$/.test(existing)) {
        resolvedName = existing;
      }
    }
  } catch (_) {}

  // 2. Fallback: project-names.json cwd→name mapping (in state dir)
  if (!resolvedName) {
    const namesFile = path.join(stateDir(), 'project-names.json');
    try {
      const map = JSON.parse(fs.readFileSync(namesFile, 'utf8'));
      const savedName = map[cwd];
      if (savedName) resolvedName = savedName;
    } catch (_) {}
  }

  if (!resolvedName) return;

  // 3. Write name to disk synchronously
  try { fs.writeFileSync(nameFilePath, resolvedName + '\n'); } catch (_) {}

  // 4. Sync to daemon (await so name is set before hook returns)
  try {
    const resp = await put('/api/sessions/name', { sessionId, name: resolvedName }, port, tls);
    if (resp && resp.ok) {
      process.stdout.write(`airprompt: auto-named '${resolvedName}'\n`);
    }
  } catch (_) {}
}

// ── Main entry point ──────────────────────────────────────────────────────

/**
 * Activate an AirPrompt session.
 *
 * @param {object} ctx
 * @param {import('../../providers/provider').Provider} ctx.provider
 * @param {string} [ctx.sessionId] - generated if not provided
 * @param {string} ctx.cwd - current working directory
 * @param {string|null} [ctx.tmuxSession] - detected if not provided
 * @returns {Promise<import('../../providers/provider').HookResult>}
 */
async function activateSession(ctx) {
  const provider = ctx.provider;
  const providerId = ctx.providerId || provider.id;
  const port = resolvePort();
  const pidFile = process.env.AIRPROMPT_PID_FILE || '/tmp/airprompt-server.pid';
  const installDir = resolveInstallDir();
  const rootDir = sessionsRootDir();

  // 1. Ensure TLS certs exist (auto-generate if missing)
  // MUST run before detectTls() — otherwise first activation on clean
  // machine captures tls=false, generates certs, then sends http to https port.
  ensureCerts(installDir);
  const tls = detectTls();

  // 2. Ensure daemon is running
  if (!daemonRunning(pidFile)) {
    process.stdout.write('airprompt: starting daemon...');
    if (!startDaemon(installDir, port, pidFile)) {
      return {
        status: 'error',
        message: `could not start daemon on port ${port}`,
        url: null,
        sessionId: null,
      };
    }
    process.stdout.write('done\n');
  }

  // 3. Detect current tmux session
  const currentTmux = ctx.tmuxSession || detectTmux();

  // 4. Idempotency: check per-session dir at ~/.airprompt/sessions/{providerId}-{safeTmux}/
  const sessionsDir = rootDir;

  if (currentTmux) {
    const myDir = sessionDir(providerId, currentTmux);
    const activeFile = path.join(myDir, 'active');
    if (fs.existsSync(activeFile)) {
      // Verify tmux session is still alive — stale active marker with dead
      // tmux means the session was dropped by daemon but dir not cleaned.
      const r = spawnSync('tmux', ['has-session', '-t', currentTmux], { timeout: 2000 });
      if (r.status === 1) {
        // Tmux session definitely dead — clean up stale marker and proceed to re-register
        try { fs.unlinkSync(activeFile); } catch (_) {}
      } else if (r.status === 0) {
        process.stdout.write('airprompt: session already registered (from /airprompt on)\n');

        // Still auto-apply project name
        let sid = '';
        try { sid = fs.readFileSync(path.join(myDir, 'session'), 'utf8').trim().slice(0, 128); } catch (_) {}
        if (sid) await autoApplyName(sid, ctx.cwd, myDir, port, tls);

        sweepDeadSessions(sessionsDir, port, tls);

        return {
          status: 'ok',
          message: 'session already registered',
          url: null,
          sessionId: sid || null,
        };
      }
    }
  }

  // 5. Generate session ID
  const cwd = ctx.cwd || process.cwd();
  const cwdSafe = path.basename(cwd).replace(/[^a-zA-Z0-9_-]/g, '');
  const sessionId = ctx.sessionId || `${Date.now()}-${process.pid}-${cwdSafe}`.slice(0, 64);

  // 6. Resolve tmux session
  let tmuxSession = currentTmux;
  let isMirror = false;
  if (!tmuxSession) {
    tmuxSession = `airprompt-${sessionId}`;
    const mirrorResult = spawnSync('tmux', ['new-session', '-d', '-s', tmuxSession, '-c', cwd], { timeout: 2000 });
    isMirror = mirrorResult.status === 0;
  }

  // 7. Register with daemon
  try {
    const resp = await post('/api/sessions/register', { sessionId, cwd, tmuxSession, providerId }, port, tls);
    if (resp && resp.ok) {
      const myDir = sessionDir(providerId, tmuxSession);
      const lanIp = getLanIp();
      const url = `${tls ? 'https' : 'http'}://${lanIp}:${port}`;

      try {
        fs.mkdirSync(myDir, { recursive: true });
        fs.writeFileSync(path.join(myDir, 'url'), url + '\n');
        fs.writeFileSync(path.join(myDir, 'session'), sessionId + '\n');
        fs.writeFileSync(path.join(myDir, 'tmux'), tmuxSession + '\n');
        fs.writeFileSync(path.join(myDir, 'provider'), providerId + '\n');
        fs.writeFileSync(path.join(myDir, 'active'), '');
        if (isMirror) fs.writeFileSync(path.join(myDir, 'mirror'), '');
      } catch (e) {
        process.stderr.write(`airprompt: marker write failed: ${e.message}\n`);
        try { await post('/api/sessions/unregister', { sessionId, force: true }, port, tls); } catch (_) {}
        return {
          status: 'error',
          message: `marker write failed: ${e.message}`,
          url: null,
          sessionId: null,
        };
      }

      process.stdout.write(`airprompt: registered ${sessionId}\n`);
      process.stdout.write(`airprompt: mobile URL ${url}\n`);

      await autoApplyName(sessionId, cwd, myDir, port, tls);
      sweepDeadSessions(sessionsDir, port, tls);

      return {
        status: 'ok',
        message: `registered ${sessionId}`,
        url,
        sessionId,
      };
    } else {
      // 409 = daemon already has session (disk recovery on restart).
      // Don't overwrite session ID — daemon owns it. Just fill in
      // missing marker files so subsequent lookups find the session.
      const already = resp && resp.error === 'Session already registered';
      if (already) {
        // If we created a mirror tmux for this registration attempt,
        // kill it — the daemon already has the session under a different tmux.
        if (isMirror) {
          try { spawnSync('tmux', ['kill-session', '-t', tmuxSession], { timeout: 2000 }); } catch (_) {}
        }

        const myDir = sessionDir(providerId, tmuxSession);
        const lanIp = getLanIp();
        const url = `${tls ? 'https' : 'http'}://${lanIp}:${port}`;
        let markerOk = true;
        try {
          fs.mkdirSync(myDir, { recursive: true });
          // Only write files that are missing (airprompt-launch writes tmux+provider)
          if (!fs.existsSync(path.join(myDir, 'tmux'))) fs.writeFileSync(path.join(myDir, 'tmux'), tmuxSession + '\n');
          if (!fs.existsSync(path.join(myDir, 'provider'))) fs.writeFileSync(path.join(myDir, 'provider'), providerId + '\n');
          // Write url so statusline badge works after recovery
          if (!fs.existsSync(path.join(myDir, 'url'))) fs.writeFileSync(path.join(myDir, 'url'), url + '\n');
          fs.writeFileSync(path.join(myDir, 'active'), '');  // always write — this is what idempotency checks
          if (isMirror) fs.writeFileSync(path.join(myDir, 'mirror'), '');
        } catch (e) {
          process.stderr.write(`airprompt: marker write failed: ${e.message}\n`);
          markerOk = false;
        }

        if (!markerOk) {
          return {
            status: 'error',
            message: 'marker write failed — session exists in daemon but disk state incomplete',
            url: null,
            sessionId: null,
          };
        }

        // Read existing session ID from disk (may be missing — fallback handled by name.sh/status)
        let existingSid = '';
        try { existingSid = fs.readFileSync(path.join(myDir, 'session'), 'utf8').trim().slice(0, 128); } catch (_) {}
        if (existingSid) {
          await autoApplyName(existingSid, cwd, myDir, port, tls);
        }

        sweepDeadSessions(sessionsDir, port, tls);

        return {
          status: 'ok',
          message: 'session already registered (recovered)',
          url: null,
          sessionId: existingSid || null,
        };
      }

      return {
        status: 'error',
        message: `registration failed: ${JSON.stringify(resp)}`,
        url: null,
        sessionId: null,
      };
    }
  } catch (e) {
    return {
      status: 'error',
      message: `cannot reach daemon on port ${port} — ${e.message}`,
      url: null,
      sessionId: null,
    };
  }
}

module.exports = { activateSession };
