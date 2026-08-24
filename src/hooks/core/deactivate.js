// src/hooks/core/deactivate.js — Shared session deactivation logic.
//
// Provider-agnostic. Called by per-IDE wrapper hooks after parsing stdin.
// Handles: tmux resolution, guard checks, unregister, cleanup, daemon stop.
//
// Exports: deactivateSession(ctx) → Promise<HookResult>

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { sessionsRootDir } = require('../../providers/provider');
const { safeRmSync } = require('../../utils');
const { post, get, detectTls, resolvePort } = require('./shared');

// ── Tmux resolution ──────────────────────────────────────────────────────

function resolveCurrentTmux() {
  if (process.env.AIRPROMPT_DEACTIVATE_TEST_TMUX) {
    return process.env.AIRPROMPT_DEACTIVATE_TEST_TMUX;
  }
  if (process.env.TMUX) {
    let s = '';
    const r = spawnSync('tmux', ['display-message', '-p', '#S'], {
      timeout: 2000,
      encoding: 'utf8',
    });
    if (r.status === 0) s = r.stdout.trim();
    if (s && s.startsWith('airprompt-web-')) {
      const r2 = spawnSync('tmux', ['display-message', '-p', '#{session_group}'], {
        timeout: 2000,
        encoding: 'utf8',
      });
      if (r2.status === 0 && r2.stdout.trim()) s = r2.stdout.trim();
    }
    return s || '';
  }
  return '';
}

// ── Per-session dir resolution ────────────────────────────────────────────

function findMyDir(sessionsDir, currentTmux, providerId) {
  if (!fs.existsSync(sessionsDir)) return null;

  const safeName = (name) => String(name).replace(/[^a-zA-Z0-9_.-]/g, '');

  // Primary: per-session dir matching providerId + sanitized current tmux
  if (currentTmux) {
    const dir = path.join(sessionsDir, `${providerId}-${safeName(currentTmux)}`);
    if (fs.existsSync(path.join(dir, 'active'))) return dir;
  }

  // Fallback: scan for dirs whose registered tmux is dead
  if (!currentTmux) {
    try {
      for (const name of fs.readdirSync(sessionsDir)) {
        const d = path.join(sessionsDir, name);
        if (!fs.statSync(d).isDirectory()) continue;
        // Only match dirs belonging to this provider
        if (!name.startsWith(providerId + '-')) continue;
        let dirTmux = '';
        try {
          dirTmux = fs.readFileSync(path.join(d, 'tmux'), 'utf8').trim().slice(0, 128);
        } catch (_) {}
        if (!dirTmux) continue;
        const r = spawnSync('tmux', ['has-session', '-t', dirTmux], { timeout: 2000 });
        if (r.status === 1 && fs.existsSync(path.join(d, 'active'))) {
          return d;
        }
      }
    } catch (_) {}
  }

  return null;
}

function readSessionId(myDir) {
  if (!myDir) return '';
  try {
    return fs.readFileSync(path.join(myDir, 'session'), 'utf8').trim().slice(0, 128);
  } catch (_) {}
  return '';
}

function readRegisteredTmux(myDir) {
  if (!myDir) return '';
  try {
    return fs.readFileSync(path.join(myDir, 'tmux'), 'utf8').trim().slice(0, 128);
  } catch (_) {}
  return '';
}

// ── Daemon stop ──────────────────────────────────────────────────────────

function stopDaemon(pidFile) {
  try {
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    process.kill(pid, 'SIGTERM');
    // Unlink AFTER kill — prevents racing activate from spawning duplicate
    // daemon while this one is still shutting down.
    try {
      fs.unlinkSync(pidFile);
    } catch (_) {}
  } catch (_) {}
}

// ── Main entry point ──────────────────────────────────────────────────────

/**
 * Deactivate an AirPrompt session.
 *
 * @param {object} ctx
 * @param {import('../../providers/provider').Provider} ctx.provider
 * @param {string} [ctx.sessionId] - session to unregister
 * @param {string} ctx.cwd - current working directory
 * @returns {Promise<import('../../providers/provider').HookResult>}
 */
async function deactivateSession(ctx) {
  const provider = ctx.provider;
  const providerId = ctx.providerId || provider.id;
  const port = resolvePort();
  const tls = detectTls();
  const pidFile = process.env.AIRPROMPT_PID_FILE || '/tmp/airprompt-server.pid';
  const sessionsDir = sessionsRootDir();

  const currentTmux = resolveCurrentTmux();
  const myDir = findMyDir(sessionsDir, currentTmux, providerId);

  // 1. Read session ID
  let sessionId = ctx.sessionId || readSessionId(myDir);
  if (!sessionId) {
    return { status: 'ok', message: 'no session to unregister', url: null, sessionId: null };
  }

  // 2. Guard: check if registered tmux is still alive
  let registeredTmux = readRegisteredTmux(myDir);

  if (!registeredTmux) {
    // Try session group check
    try {
      const r = spawnSync('tmux', ['display-message', '-p', '#{session_group}'], {
        timeout: 2000,
        encoding: 'utf8',
      });
      if (r.status === 0 && r.stdout) {
        const group = r.stdout.trim();
        const r2 = spawnSync('tmux', ['has-session', '-t', group], { timeout: 2000 });
        if (r2.status === 0) {
          return {
            status: 'ok',
            message: 'session group alive — no cleanup',
            url: null,
            sessionId: null,
          };
        }
      }
    } catch (_) {
      return {
        status: 'ok',
        message: 'cannot confirm tmux state — safe exit',
        url: null,
        sessionId: null,
      };
    }
    return {
      status: 'ok',
      message: 'cannot confirm tmux state — safe exit',
      url: null,
      sessionId: null,
    };
  }

  try {
    const r = spawnSync('tmux', ['has-session', '-t', registeredTmux], { timeout: 2000 });
    if (r.status === 0) {
      // Mirror sessions: kill tmux and clean up. Real sessions: leave alone.
      const mirrorFile = myDir ? path.join(myDir, 'mirror') : '';
      if (mirrorFile && fs.existsSync(mirrorFile)) {
        spawnSync('tmux', ['kill-session', '-t', registeredTmux], { timeout: 2000 });
        // Fall through to cleanup
      } else {
        return {
          status: 'ok',
          message: 'tmux session alive — no cleanup',
          url: null,
          sessionId: null,
        };
      }
    }
    if (r.status === null || r.error) {
      return {
        status: 'ok',
        message: 'tmux not available — safe exit',
        url: null,
        sessionId: null,
      };
    }
  } catch (_) {
    return { status: 'ok', message: 'tmux check error — safe exit', url: null, sessionId: null };
  }

  // 3. Unregister from daemon
  let serverOk = false;
  try {
    const resp = await post('/api/sessions/unregister', { sessionId }, port, tls);
    if (resp && resp.ok) {
      serverOk = true;
    } else {
      // Server refused — may be 409 stale-state (mirror killed but daemon
      // disagrees). Retry with force:true if we already killed the mirror.
      const mirrorFile = myDir ? path.join(myDir, 'mirror') : '';
      if (mirrorFile && fs.existsSync(mirrorFile)) {
        try {
          await post('/api/sessions/unregister', { sessionId, force: true }, port, tls);
          serverOk = true;
        } catch (_) {}
      }
      // Always fall through to local cleanup — the per-session dir is stale
    }
  } catch (_) {
    // Daemon unreachable — clean up locally
  }

  // 4. Remove per-session directory
  if (myDir) safeRmSync(myDir);

  // 5. Stop daemon if zero sessions remain
  try {
    const resp = await get('/api/sessions', port, tls);
    if (Array.isArray(resp) && resp.length === 0) stopDaemon(pidFile);
  } catch (_) {
    // Daemon unreachable — don't kill
  }

  return {
    status: 'ok',
    message: serverOk ? `session ${sessionId} unregistered` : 'session cleaned up locally',
    url: null,
    sessionId,
  };
}

module.exports = { deactivateSession };
