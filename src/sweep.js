// Stale-session and orphan-mirror sweep — single-pass removal.
// Exported for testability; callers inject time/log deps, defaults work in production.

const { spawnSync: _spawnSync } = require('child_process');
const { getSessionsDir: _getSessionsDir, ownerMarkerDir, reapOwnedStandIn } = require('./utils');

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
 * @param {Function} [deps.spawnSync]     — overrides child_process.spawnSync
 * @param {Function} [deps.log]           — (level, msg, extra) logger, defaults to silent
 */
function runStaleSweep(sessions, deps) {
  deps = deps || {};
  const now = deps.now || Date.now();
  const orphanGraceMs = deps.orphanGraceMs || 120_000;
  const getSessionsDir = deps.getSessionsDir || _getSessionsDir;
  const spawnSync = deps.spawnSync || _spawnSync;
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
      // A stand-in's marker dir goes with the entry here too: a marker left
      // behind vouches for the tmux *name*, so a later session of that name (the
      // user's own, say) could be killed by a force unregister finding it.
      reapOwnedStandIn(entry.tmuxSession, entry.providerId, getSessionsDir());
      continue;
    }

    // Orphan detection: mirror/stand-in sessions (airprompt-*) that have no
    // attached clients and no recent activity are leaked shells — kill them.
    // Only sessions the daemon owns are eligible: a 'mirror' marker (written by
    // activate.js for an IDE outside tmux) or a 'standin' marker (written by the
    // register route when it had to stand the session up itself).
    // Sessions created by airprompt-launch use airprompt-* prefix but are NOT
    // owned — they must survive.
    if (!entry.tmuxSession.startsWith('airprompt-')) continue;

    const sessionsDir = getSessionsDir();
    // Same ownership resolution unregister uses: the marker may sit under another
    // provider that shares this tmux session, and the dir must describe *this*
    // session.
    const owner = ownerMarkerDir(entry.tmuxSession, entry.providerId, sessionsDir);
    if (!owner) continue;

    // A second provider may be registered against the same tmux session (two
    // providers sharing one is supported), and then it is not an orphan — but
    // only while that sibling is actually in use. Two entries that are both past
    // the grace window are one orphan, not two live sessions, so the pair is
    // reaped instead of leaking forever.
    let shared = false;
    for (const [otherId, other] of sessions) {
      if (otherId === id || other.tmuxSession !== entry.tmuxSession) continue;
      if (now - (other.lastActivity || 0) < orphanGraceMs) {
        shared = true;
        break;
      }
    }
    if (shared) continue;

    const idle = now - (entry.lastActivity || 0);
    if (idle < orphanGraceMs) continue;

    // Confirm no tmux client is attached before killing. The daemon's own phone
    // viewer attaches to a *grouped* sibling (`new-session -t <target>`), which
    // `list-clients -t <target>` cannot see — so ask every client which session
    // it sits on and compare group membership instead.
    let attached = -1; // -1 = could not confirm
    try {
      const list = spawnSync('tmux', ['list-clients', '-F', '#{client_session}'], {
        timeout: 2000,
        encoding: 'utf8',
      });
      if (list.status === 0) {
        const clientSessions = String(list.stdout || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        if (clientSessions.length === 0) {
          attached = 0;
        } else {
          const groups = new Map();
          const all = spawnSync(
            'tmux',
            ['list-sessions', '-F', '#{session_name} #{session_group}'],
            { timeout: 2000, encoding: 'utf8' }
          );
          for (const line of String(all.stdout || '').split('\n')) {
            const [name, group] = line.trim().split(' ');
            if (name) groups.set(name, group || '');
          }
          const targetGroup = groups.get(entry.tmuxSession) || '';
          attached = clientSessions.filter(
            (c) => c === entry.tmuxSession || (targetGroup && groups.get(c) === targetGroup)
          ).length;
        }
      }
    } catch (_) {}
    if (attached !== 0) continue; // a client is attached, or we could not confirm

    // No clients + idle > grace → orphan. Kill tmux + unregister.
    log('warn', 'orphan stand-in/mirror session killed', {
      id,
      tmuxSession: entry.tmuxSession,
      idleMs: idle,
    });
    try {
      spawnSync('tmux', ['kill-session', '-t', entry.tmuxSession], { timeout: 2000 });
    } catch (_) {}
    sessions.delete(id);
    removed++;
    // A stand-in owns its dir, so take the whole thing: the marker is the daemon's
    // only ownership proof, and one left behind would vouch for the tmux *name* —
    // so a later session of the same name (the user's own, say) would be killed by
    // a force unregister that found this stale marker. A mirror dir belongs to
    // activate.js, so it stays and is cleaned by its own lifecycle.
    reapOwnedStandIn(entry.tmuxSession, entry.providerId, sessionsDir);
  }

  return removed;
}

module.exports = { runStaleSweep };
