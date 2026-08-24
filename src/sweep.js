// Stale-session and orphan-mirror sweep — single-pass removal.
// Exported for testability; callers inject time/log deps, defaults work in production.

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { getSessionsDir: _getSessionsDir } = require('./utils');

/**
 * One pass over `sessions` Map:
 *  - Removes entries whose tmux session no longer exists.
 *  - Kills orphan mirror sessions (airprompt-* prefix + mirror marker file,
 *    no tmux clients attached, idle > orphanGraceMs).
 *
 * Returns the number of entries removed.
 *
 * @param {Map} sessions  — Map of sessionId → entry
 * @param {object} [deps] — injectable dependencies for tests
 * @param {number} [deps.now]            — timestamp (ms), defaults to Date.now()
 * @param {number} [deps.orphanGraceMs]  — idle threshold before killing, default 120_000
 * @param {Function} [deps.getSessionsDir] — overrides getSessionsDir()
 * @param {Function} [deps.log]           — (level, msg, extra) logger, defaults to silent
 */
function runStaleSweep(sessions, deps) {
  deps = deps || {};
  const now = deps.now || Date.now();
  const orphanGraceMs = deps.orphanGraceMs || 120_000;
  const getSessionsDir = deps.getSessionsDir || _getSessionsDir;
  const log = deps.log || (() => {});

  let removed = 0;

  for (const [id, entry] of sessions) {
    // Dead tmux — remove only on explicit "no session" (exit code 1).
    // Other non-zero codes (tmux error, timeout, missing binary) must NOT
    // trigger data loss — same guard as server.js recoverSessionsFromDisk.
    let tmuxDead = false;
    try {
      const r = spawnSync('tmux', ['has-session', '-t', entry.tmuxSession], { timeout: 2000 });
      if (r.status === 1) tmuxDead = true;
    } catch (_) {}
    if (tmuxDead) {
      sessions.delete(id);
      removed++;
      log('warn', 'stale session removed', { id, tmuxSession: entry.tmuxSession });
      continue;
    }

    // Orphan detection: mirror sessions (airprompt-*) that have no attached
    // clients and no recent activity are leaked shells — kill them.
    // Only sessions with a 'mirror' marker file are real mirrors.
    // Sessions created by airprompt-launch use airprompt-* prefix but are NOT mirrors.
    if (!entry.tmuxSession.startsWith('airprompt-')) continue;

    const sessionsDir = getSessionsDir();
    const safeName =
      entry.tmuxSession.replace(/[^a-zA-Z0-9_.-]/g, '') ||
      entry.tmuxSession.replace(/[^a-zA-Z0-9]/g, '') ||
      'unknown';
    const mirrorFile = path.join(
      sessionsDir,
      `${entry.providerId || 'unknown'}-${safeName}`,
      'mirror'
    );
    let isMirror = false;
    try {
      isMirror = fs.existsSync(mirrorFile);
    } catch (_) {}
    if (!isMirror) continue;

    const idle = now - (entry.lastActivity || 0);
    if (idle < orphanGraceMs) continue;

    // Confirm no tmux client is attached before killing
    let canConfirmNoClients = false;
    try {
      const clients = spawnSync(
        'tmux',
        ['list-clients', '-t', entry.tmuxSession, '-F', '#{client_name}'],
        { timeout: 2000, encoding: 'utf8' }
      );
      if (clients.status === 0) {
        canConfirmNoClients = true;
        if (clients.stdout.trim()) continue; // has attached client → not orphan
      }
    } catch (_) {}
    if (!canConfirmNoClients) continue;

    // No clients + idle > grace → orphan. Kill tmux + unregister.
    log('warn', 'orphan mirror session killed', {
      id,
      tmuxSession: entry.tmuxSession,
      idleMs: idle,
    });
    try {
      spawnSync('tmux', ['kill-session', '-t', entry.tmuxSession], { timeout: 2000 });
    } catch (_) {}
    sessions.delete(id);
    removed++;
  }

  return removed;
}

module.exports = { runStaleSweep };
