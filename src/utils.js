// src/utils.js — Shared Node-side utilities.
// Used by server.js. Not for browser (see public/utils.js).
//
// Provider-agnostic. Sessions live in ~/.airprompt/sessions/.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { sessionsRootDir } = require('./providers/provider');

// ── Sessions dir ──────────────────────────────────────────────────────────

/**
 * Root sessions directory for per-session marker files.
 * @returns {string} ~/.airprompt/sessions/
 */
function getSessionsDir() {
  return sessionsRootDir();
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
  sessionsRootDir,
  sessionDir: require('./providers/provider').sessionDir,
};
