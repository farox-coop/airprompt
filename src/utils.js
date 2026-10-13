// src/utils.js — Shared Node-side utilities.
// Used by server.js. Not for browser (see public/utils.js).
//
// Provider-agnostic. Sessions live in ~/.airprompt/sessions/.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const {
  sessionsRootDir,
  resolveInstallDir,
  stateDir,
  uploadsRootDir,
} = require('./providers/provider');

// ── Sessions dir ──────────────────────────────────────────────────────────

/**
 * Root sessions directory for per-session marker files.
 * @returns {string} ~/.airprompt/sessions/
 */
function getSessionsDir() {
  return sessionsRootDir();
}

// ── Safe rm -rf guard ─────────────────────────────────────────────────────
//
// Node-side mirror of the shell `_safe_rm_rf` (bin/lib/protocol.sh).
// `fs.rmSync(dir, { recursive: true })` is as dangerous as `rm -rf`: a
// misconfigured AIRPROMPT_SESSIONS_DIR=/home would delete arbitrary dirs
// during startup recovery. Every recursive delete MUST pass this guard.
//
// Rules (same as the shell):
//   1. Resolve the target to an absolute path (kills `..` traversal).
//   2. It must live under an AirPrompt-owned root (install / sessions / state /
//      uploads).
//   3. That root must contain "airprompt" in its path (blocks `/home`, `/`,
//      `/tmp` style misconfiguration that happens to be the configured dir).
//
// @param {string} target - path to delete
// @returns {boolean} true if safe to delete with rmSync({ recursive: true })
function isSafeRmTarget(target) {
  if (typeof target !== 'string' || !target) return false;

  // Canonicalize both target and roots (resolve symlinks) before comparing.
  const absolute = canonicalTarget(target);

  // Containment roots, in priority order. Each must be AirPrompt-owned.
  // uploadsRootDir() is a sibling of sessions/ and state/, so without it a
  // purge of an uploads dir would silently no-op in a dev/plugin install
  // (where the install dir is the checkout, not ~/.airprompt).
  const roots = [resolveInstallDir(), sessionsRootDir(), stateDir(), uploadsRootDir()];
  for (const candidate of roots) {
    const root = canonicalRoot(candidate);
    // Root itself must be AirPrompt-owned — require 'airprompt' in its path.
    if (!/airprompt/.test(root)) continue;

    const rel = path.relative(root, absolute);
    // Contained if rel is '' (target === root) or a child (no '..', not absolute).
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return true;
    }
  }
  return false;
}

// Canonicalize a root (resolve its own symlink too) with a lexical fallback.
function canonicalRoot(p) {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch (_) {
    return resolved;
  }
}

// Canonicalize a delete target: resolve the parent's symlinks, keep the
// basename. Mirrors the shell's `cd dirname && pwd -P` and stays robust when
// the leaf doesn't exist (a common cleanup case). A symlinked leaf is resolved
// by the parent step only — but rmSync unlinks a symlink rather than following
// it, so that is safe by construction.
function canonicalTarget(p) {
  const resolved = path.resolve(p);
  try {
    return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
  } catch (_) {
    return resolved;
  }
}

// Guarded recursive delete: removes `dir` only if it passes isSafeRmTarget.
// Returns true if the directory was deleted, false if blocked or errored.
function safeRmSync(dir) {
  if (!isSafeRmTarget(dir)) return false;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (_) {
    return false;
  }
}

// ── Tmux helpers ──────────────────────────────────────────────────────────

function tmuxExists(sessionName) {
  try {
    const r = spawnSync('tmux', ['has-session', '-t', sessionName], { timeout: 2000 });
    return r.status === 0;
  } catch (_) {
    return false;
  }
}

// Tri-state liveness probe for callers that DELETE on "gone": exit code 1 is
// tmux's definitive "no such session", while any other failure (timeout, error,
// missing binary) is unknown and must not be read as death. Same discipline as
// runStaleSweep.
// @returns {'alive'|'dead'|'unknown'}
function tmuxState(sessionName) {
  if (!sessionName) return 'unknown';
  try {
    const r = spawnSync('tmux', ['has-session', '-t', sessionName], { timeout: 2000 });
    if (r.status === 0) return 'alive';
    if (r.status === 1) return 'dead';
    return 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

// ── Session-marker ownership ──────────────────────────────────────────────
//
// A tmux session the daemon owns carries a marker file in its per-session dir:
// `standin` (the register route stood the session up itself, because the client
// had no live tmux) or `mirror` (activate.js, for an IDE running outside tmux).
// Ownership is recorded under the provider that created it, but the entry being
// unregistered or swept may belong to a *different* provider — two providers can
// share one tmux session — so every dir is considered. A dir only counts when its
// own `tmux` file names this exact session: matching on the name suffix alone
// would let `-airprompt-a` match `airprompt--airprompt-a`.
//
// The dir-name component a tmux session's marker dir uses — one sanitizer, so
// every writer and reader agrees on which dir belongs to which session.
function markerSafeName(tmuxSession) {
  return (
    String(tmuxSession || '').replace(/[^a-zA-Z0-9_.-]/g, '') ||
    String(tmuxSession || '').replace(/[^a-zA-Z0-9]/g, '') ||
    'unknown'
  );
}

// @returns {{dir: string, kind: 'standin'|'mirror'}|null}
function ownerMarkerDir(tmuxSession, providerId, sessionsDirOverride) {
  if (!tmuxSession) return null;
  const sessionsDir = sessionsDirOverride || getSessionsDir();
  const safeName = markerSafeName(tmuxSession);

  const candidates = [path.join(sessionsDir, `${providerId || 'unknown'}-${safeName}`)];
  try {
    for (const entry of fs.readdirSync(sessionsDir)) {
      const dir = path.join(sessionsDir, entry);
      if (!candidates.includes(dir)) candidates.push(dir);
    }
  } catch (_) {
    /* unreadable sessions dir — only the provider-local candidate is tried */
  }

  for (const dir of candidates) {
    try {
      const tmuxFile = path.join(dir, 'tmux');
      if (!fs.existsSync(tmuxFile)) continue;
      if (fs.readFileSync(tmuxFile, 'utf8').trim() !== tmuxSession) continue;
      if (fs.existsSync(path.join(dir, 'standin'))) return { dir, kind: 'standin' };
      if (fs.existsSync(path.join(dir, 'mirror'))) return { dir, kind: 'mirror' };
    } catch (_) {}
  }
  return null;
}

// Reap the marker dir of a stand-in the daemon stood up itself. Called from
// every path that removes such a session (unregister, the kill endpoint, both
// sweep branches) so the marker never outlives the session it vouches for: a
// leftover marker names a tmux *session*, so a later session of that name — the
// user's own, say — could be killed by a force unregister that found it.
// A mirror dir belongs to activate.js and is left alone.
// @returns {boolean} true when a stand-in dir was removed
function reapOwnedStandIn(tmuxSession, providerId, sessionsDirOverride) {
  const owner = ownerMarkerDir(tmuxSession, providerId, sessionsDirOverride);
  if (!owner || owner.kind !== 'standin') return false;
  return safeRmSync(owner.dir);
}

// ── sessionToJSON — canonical serialisation ───────────────────────────────
//
// Every session served by the daemon (REST + WebSocket) goes through this.
// Shape is the single source of truth.
//
// @param {object} entry — session entry with { sessionId, cwd, tmuxSession, ... }
// @param {string} [sessionsDir] — override sessions directory (for testing)
function sessionToJSON(entry, sessionsDirOverride) {
  const safeName = String(entry.tmuxSession || '').replace(/[^a-zA-Z0-9_.-]/g, '');
  const providerId = entry.providerId || 'unknown';
  const dirName = `${providerId}-${safeName}`;
  const markerDir = path.join(sessionsDirOverride || getSessionsDir(), dirName);

  const json = {
    id: entry.sessionId,
    cwd: entry.cwd,
    name: entry.name || null,
    tmuxSession: entry.tmuxSession,
    providerId: entry.providerId || null,
    createdAt: entry.createdAt,
    isMirror: false,
    isActive: false,
    tmuxAlive: false,
    attachedClients: 0,
    lastActivity: entry.lastActivity || null,
  };

  // Mirror marker
  try {
    if (fs.existsSync(path.join(markerDir, 'mirror'))) json.isMirror = true;
  } catch (_) {}

  // Active marker
  try {
    if (fs.existsSync(path.join(markerDir, 'active'))) json.isActive = true;
  } catch (_) {}

  // Tmux liveness
  json.tmuxAlive = tmuxExists(entry.tmuxSession);

  // Attached clients
  if (json.tmuxAlive) {
    try {
      const clients = spawnSync(
        'tmux',
        ['list-clients', '-t', entry.tmuxSession, '-F', '#{client_name}'],
        { timeout: 2000, encoding: 'utf8' }
      );
      if (clients.status === 0 && clients.stdout.trim()) {
        json.attachedClients = clients.stdout.trim().split('\n').length;
      }
    } catch (_) {}
  }

  return json;
}

module.exports = {
  tmuxExists,
  tmuxState,
  ownerMarkerDir,
  markerSafeName,
  reapOwnedStandIn,
  sessionToJSON,
  getSessionsDir,
  isSafeRmTarget,
  safeRmSync,
  sessionsRootDir,
  uploadsRootDir,
  uploadsSessionDir: require('./providers/provider').uploadsSessionDir,
  sessionDir: require('./providers/provider').sessionDir,
};
