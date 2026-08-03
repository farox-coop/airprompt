// src/utils.js — Shared Node-side utilities.
// Used by server.js. Not for browser (see public/utils.js).
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CONFIG_DIR, '.airprompt', 'sessions');

function tmuxExists(sessionName) {
  try {
    const r = spawnSync('tmux', ['has-session', '-t', sessionName], { timeout: 2000 });
    return r.status === 0;
  } catch (_) { return false; }
}

// sessionToJSON — canonical serialisation. Every session served by the daemon
// (REST + WebSocket) goes through this. Shape is the single source of truth.
function sessionToJSON(entry) {
  const safeName = String(entry.tmuxSession || '').replace(/[^a-zA-Z0-9_.-]/g, '');
  const markerDir = path.join(SESSIONS_DIR, safeName);

  const json = {
    id:              entry.sessionId,
    cwd:             entry.cwd,
    name:            entry.name || null,
    tmuxSession:     entry.tmuxSession,
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

module.exports = { tmuxExists, sessionToJSON };
