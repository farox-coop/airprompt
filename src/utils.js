// src/utils.js — Shared Node-side utilities.
// Used by server.js. Not for browser (see public/utils.js).
//
// Provider-agnostic. Sessions live in ~/.airprompt/sessions/.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { sessionsRootDir, resolveInstallDir, stateDir } = require('./providers/provider');

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
//   2. It must live under an AirPrompt-owned root (install / sessions / state).
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
  const roots = [resolveInstallDir(), sessionsRootDir(), stateDir()];
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
  try { return fs.realpathSync(resolved); } catch (_) { return resolved; }
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
  try { fs.rmSync(dir, { recursive: true, force: true }); return true; }
  catch (_) { return false; }
}

// ── Tmux helpers ──────────────────────────────────────────────────────────

function tmuxExists(sessionName) {
  try {
    const r = spawnSync('tmux', ['has-session', '-t', sessionName], { timeout: 2000 });
    return r.status === 0;
  } catch (_) { return false; }
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
    id:              entry.sessionId,
    cwd:             entry.cwd,
    name:            entry.name || null,
    tmuxSession:     entry.tmuxSession,
    providerId:      entry.providerId || null,
    createdAt:       entry.createdAt,
    isMirror:        false,
    isActive:        false,
    tmuxAlive:       false,
    attachedClients: 0,
    lastActivity:    entry.lastActivity || null,
  };

  // Mirror marker
  try { if (fs.existsSync(path.join(markerDir, 'mirror'))) json.isMirror = true; } catch (_) {}

  // Active marker
  try { if (fs.existsSync(path.join(markerDir, 'active'))) json.isActive = true; } catch (_) {}

  // Tmux liveness
  json.tmuxAlive = tmuxExists(entry.tmuxSession);

  // Attached clients
  if (json.tmuxAlive) {
    try {
      const clients = spawnSync('tmux', ['list-clients', '-t', entry.tmuxSession, '-F', '#{client_name}'], { timeout: 2000, encoding: 'utf8' });
      if (clients.status === 0 && clients.stdout.trim()) {
        json.attachedClients = clients.stdout.trim().split('\n').length;
      }
    } catch (_) {}
  }

  return json;
}

module.exports = {
  tmuxExists,
  sessionToJSON,
  getSessionsDir,
  isSafeRmTarget,
  safeRmSync,
  sessionsRootDir,
  sessionDir: require('./providers/provider').sessionDir,
};
