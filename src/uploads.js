// src/uploads.js — Uploaded-file store for the web UI.
//
// Files attached from the phone are POSTed over the LAN, written here, and
// referenced by absolute path in the prompt so the CLI can read them. This
// module owns their whole lifetime:
//
//   • writeUpload()      — sanitize + write the file, record it in the session's
//                          on-disk manifest as pending
//   • releaseForDevice() — a prompt was submitted: stamp a deadline on that
//                          device's pending files
//   • sweepUploads()     — reap files past their deadline or the TTL, whole
//                          session dirs whose tmux session is definitively gone,
//                          and empty dirs
//
// Cleanup is deliberately heuristic. AirPrompt only sees keystrokes entering the
// pty — whether the CLI actually read a file, and when, is provider-side and
// invisible here, and instrumenting it would break the provider-agnostic layer.
// So the nearest safe rule is: release the previous turn's files when the next
// prompt is submitted, keep them readable for a grace window (a still-running
// turn may read them late), and let the TTL bound anything never released.
//
// The manifest lives on disk so a daemon restart does not lose track of pending
// files; anything unlisted (crash between the write and the manifest update) is
// reaped by age.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { uploadsRootDir, uploadsSessionDir } = require('./providers/provider');
const { isSafeRmTarget, safeRmSync, tmuxState: _tmuxState } = require('./utils');

// ── Limits (env-overridable) ───────────────────────────────────────────────

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_GRACE_MS = 10 * 60 * 1000;
const DEFAULT_TOKEN_TTL_MS = 120 * 1000;
const MAX_TOKENS = 256; // global cap on outstanding upload tokens
const MAX_TOKENS_PER_DEVICE = 8; // one device can't monopolize the map

const MANIFEST_FILE = 'manifest.json';

function _envInt(name, fallback) {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function maxBytes() {
  return _envInt('AIRPROMPT_UPLOAD_MAX_BYTES', DEFAULT_MAX_BYTES);
}
function ttlMs() {
  return _envInt('AIRPROMPT_UPLOAD_TTL_MS', DEFAULT_TTL_MS);
}
function graceMs() {
  return _envInt('AIRPROMPT_UPLOAD_GRACE_MS', DEFAULT_GRACE_MS);
}
function tokenTtlMs() {
  return _envInt('AIRPROMPT_UPLOAD_TOKEN_TTL_MS', DEFAULT_TOKEN_TTL_MS);
}

// Accepted types → the extension written to disk. The extension is derived from
// this table, never from the client's filename or MIME string.
const MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

// ── Names ──────────────────────────────────────────────────────────────────

/**
 * Reduce a client-supplied filename to a safe base name (no extension — the
 * canonical one is appended from the MIME whitelist).
 * @param {string} name
 * @returns {string}
 */
function sanitizeName(name) {
  const base = path.basename(String(name || ''));
  const safe = base
    .replace(/\.[A-Za-z0-9]+$/, '') // extension is re-derived from the MIME type
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .replace(/^[-.]+/, '')
    .slice(0, 80);
  return safe || 'upload';
}

/**
 * @param {string} mime
 * @returns {string|null} extension for an accepted type, else null
 */
function extensionFor(mime) {
  return MIME_EXT[mime] || null;
}

/**
 * Directory key for a registered session entry. The sessionId is already
 * constrained to [A-Za-z0-9_-]{1,64} at registration and on recovery, so it is
 * used verbatim — no sanitizing, which would only collide distinct sessions.
 * @param {object} entry - session entry from the daemon's sessions Map
 * @returns {string} {providerId}-{sessionId}, or '' when the entry names no session
 */
function sessionKeyFor(entry) {
  const sessionId = String((entry && entry.sessionId) || '');
  if (!sessionId) return '';
  return `${(entry && entry.providerId) || 'unknown'}-${sessionId}`;
}

function sessionDirFor(entry) {
  return uploadsSessionDir((entry && entry.providerId) || 'unknown', entry && entry.sessionId);
}

// ── Manifest (per session dir, 0600, atomic) ───────────────────────────────

function manifestPath(dir) {
  return path.join(dir, MANIFEST_FILE);
}

function readManifest(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8'));
    if (data && Array.isArray(data.entries)) return data;
  } catch (_) {
    /* missing or corrupt — treated as empty */
  }
  return null;
}

function writeManifest(dir, data) {
  const file = manifestPath(dir);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ── Writes ─────────────────────────────────────────────────────────────────

/**
 * Write an uploaded buffer to disk and record it as pending in the manifest.
 * @param {object} opts
 * @param {object} opts.entry  - registered session entry
 * @param {string} opts.name   - client-supplied filename (sanitized here)
 * @param {string} opts.mime   - client-supplied MIME (whitelisted here)
 * @param {Buffer} opts.buffer - raw body
 * @param {string} opts.device - canonical device public key that uploaded it
 * @param {number} [opts.now]
 * @returns {{ok: true, path: string, bytes: number, mime: string}
 *          | {ok: false, status: number, error: string}}
 */
function writeUpload(opts) {
  const entry = opts.entry;
  const mime = String(opts.mime || '');
  const ext = extensionFor(mime);
  if (!ext) return { ok: false, status: 415, error: 'Unsupported file type' };
  if (!Buffer.isBuffer(opts.buffer) || opts.buffer.length === 0)
    return { ok: false, status: 400, error: 'Empty upload' };
  if (opts.buffer.length > maxBytes()) return { ok: false, status: 413, error: 'File too large' };
  if (!sessionKeyFor(entry)) return { ok: false, status: 409, error: 'Session not found' };

  const now = opts.now || Date.now();
  const dir = sessionDirFor(entry);
  // Random prefix: two screenshots named "Screenshot_2026-10-08.png" in the same
  // millisecond must not collide.
  const file = `${now}-${crypto.randomBytes(2).toString('hex')}-${sanitizeName(opts.name)}${ext}`;

  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // 'wx' — never clobber an existing file, even on a name collision.
    fs.writeFileSync(path.join(dir, file), opts.buffer, { mode: 0o600, flag: 'wx' });
  } catch (e) {
    return { ok: false, status: 500, error: 'Could not store upload' };
  }

  const manifest = readManifest(dir) || {
    // tmuxSession is what the sweep probes for liveness — the dir name carries
    // the sessionId, but not the tmux name the session is attached to.
    session: {
      providerId: entry.providerId || null,
      sessionId: entry.sessionId || null,
      tmuxSession: entry.tmuxSession || null,
    },
    entries: [],
  };
  manifest.entries.push({ file: file, at: now, device: opts.device || '', deadline: null });
  try {
    writeManifest(dir, manifest);
  } catch (e) {
    /* the file is on disk and will be reaped by age — losing the manifest entry
       must not fail the upload the user is waiting on */
  }

  return { ok: true, path: path.join(dir, file), bytes: opts.buffer.length, mime: mime };
}

/**
 * A prompt was submitted: stamp a deadline on the submitting device's pending
 * files. They stay readable at their path until the sweep reaps them, so a turn
 * that reads the image late still finds it.
 * @param {object} entry
 * @param {string} device - canonical device public key of the submitting socket
 * @param {object} [opts] - { now, graceMs }
 * @returns {number} entries released
 */
function releaseForDevice(entry, device, opts) {
  opts = opts || {};
  if (!entry || !device || !sessionKeyFor(entry)) return 0;
  const dir = sessionDirFor(entry);
  const manifest = readManifest(dir);
  if (!manifest) return 0;

  const now = opts.now || Date.now();
  const grace = opts.graceMs || graceMs();
  let released = 0;
  for (const e of manifest.entries) {
    if (!e.deadline && e.device === device) {
      e.deadline = now + grace;
      released++;
    }
  }
  if (released) {
    try {
      writeManifest(dir, manifest);
    } catch (_) {
      return 0;
    }
  }
  return released;
}

// ── Sweep ──────────────────────────────────────────────────────────────────

function _listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
}

/**
 * One cleanup pass over the uploads root. Runs off the daemon's existing stale
 * interval, so every death path (kill, unregister, `airprompt off`, a crashed
 * turn, the activate/deactivate hook sweeps) converges here instead of each
 * shell script having to know about uploads.
 * @param {object} [deps] - { now, ttlMs, graceMs, tmuxState, log } (injectable for tests)
 * @returns {{removedFiles: number, removedDirs: number}}
 */
function sweepUploads(deps) {
  deps = deps || {};
  const now = deps.now || Date.now();
  const ttl = deps.ttlMs || ttlMs();
  const tmuxState = deps.tmuxState || _tmuxState;

  let removedFiles = 0;
  let removedDirs = 0;
  let rootEntries;
  try {
    rootEntries = fs.readdirSync(uploadsRootDir(), { withFileTypes: true });
  } catch (_) {
    return { removedFiles: 0, removedDirs: 0 }; // no uploads yet
  }

  for (const dirent of rootEntries) {
    if (!dirent.isDirectory()) continue;
    const dir = path.join(uploadsRootDir(), dirent.name);
    const manifest = readManifest(dir);
    const names = _listDir(dir).filter((n) => n !== MANIFEST_FILE && !n.endsWith('.tmp'));
    const tmuxName = manifest && manifest.session && manifest.session.tmuxSession;

    // Whole-session purge — only on tmux's definitive "no such session", so a
    // tmux error or timeout can never delete a live session's files.
    if (tmuxState(tmuxName) === 'dead') {
      if (safeRmSync(dir)) removedDirs++;
      continue;
    }

    const entries = manifest ? manifest.entries : [];
    const kept = [];

    for (const e of entries) {
      const expired = e.deadline ? e.deadline <= now : e.at + ttl <= now;
      if (expired) {
        try {
          fs.unlinkSync(path.join(dir, e.file));
          removedFiles++;
        } catch (_) {
          /* already gone */
        }
        continue;
      }
      if (names.indexOf(e.file) === -1) continue; // vanished behind our back
      kept.push(e);
    }

    // Files with no surviving manifest entry (crash between the write and the
    // manifest update) are reaped by age instead of by deadline, and adopted
    // into the manifest while they are still young.
    for (const name of names) {
      if (kept.some((e) => e.file === name)) continue;
      let stat;
      try {
        stat = fs.statSync(path.join(dir, name));
      } catch (_) {
        continue;
      }
      if (now - stat.mtimeMs > ttl) {
        try {
          fs.unlinkSync(path.join(dir, name));
          removedFiles++;
        } catch (_) {
          /* already gone */
        }
      } else {
        kept.push({ file: name, at: stat.mtimeMs, device: '', deadline: null });
      }
    }

    if (kept.length === 0) {
      // Nothing left to hold — drop the dir, with no empty manifest persisted first.
      //
      // Non-recursive on purpose: rmdir cannot remove content, so this can never
      // take an upload with it. (The daemon cannot interleave here — writeUpload
      // is synchronous, mkdir through manifest, and so is this sweep — but an
      // external purge or a future async writer would be a real race, and this
      // costs nothing to keep.) It also self-heals dirs emptied by anything else.
      //
      // The manifest and any stale manifest.json.tmp go first: the file list
      // above ignores .tmp names, so a leftover from a crash inside writeManifest
      // would otherwise pin the dir non-empty forever.
      if (isSafeRmTarget(dir)) {
        for (const leftover of [manifestPath(dir), manifestPath(dir) + '.tmp']) {
          try {
            fs.unlinkSync(leftover);
          } catch (_) {
            /* nothing to drop */
          }
        }
        try {
          fs.rmdirSync(dir);
          removedDirs++;
        } catch (_) {
          /* not empty — something the sweep cannot account for pins the dir */
        }
      }
    } else if (JSON.stringify(entries) !== JSON.stringify(kept)) {
      // Persist only on a real change — this runs every stale interval.
      const next = manifest || {
        // No manifest to read the identity from: the dir can only age out via
        // the TTL, never via the dead-tmux rule, because we cannot name its
        // tmux session. Safe direction.
        session: { providerId: null, sessionId: null, tmuxSession: null },
        entries: [],
      };
      next.entries = kept;
      try {
        writeManifest(dir, next);
      } catch (_) {
        /* keep the dir; the next pass retries */
      }
    }
  }

  return { removedFiles: removedFiles, removedDirs: removedDirs };
}

/**
 * Remove a session's whole uploads dir (session death paths that can name the
 * session). The sweep also catches these; this is the prompt path.
 * @param {object} entry
 * @returns {boolean} true if a directory was removed
 */
function purgeSession(entry) {
  if (!entry || !sessionKeyFor(entry)) return false;
  return safeRmSync(sessionDirFor(entry));
}

// ── Upload tokens ──────────────────────────────────────────────────────────
//
// Minted over the authenticated WS, redeemed once by the LAN upload POST. The
// token — not the loopback gate — is what authenticates that endpoint, so it is
// device-bound, single-use, short-lived, and re-validated against the paired
// device list when redeemed (a revoke must also kill in-flight uploads).

const _tokens = new Map(); // token -> { device, sessionId, expiresAt }

function _evictExpired(now) {
  for (const [token, rec] of _tokens) {
    if (rec.expiresAt <= now) _tokens.delete(token);
  }
}

function _countForDevice(device) {
  let n = 0;
  for (const rec of _tokens.values()) if (rec.device === device) n++;
  return n;
}

/**
 * @param {string} device - canonical device public key
 * @param {string} sessionId
 * @param {number} [now]
 * @returns {string|null} token, or null when a cap is hit
 */
function mintToken(device, sessionId, now) {
  now = now || Date.now();
  _evictExpired(now);
  if (_tokens.size >= MAX_TOKENS) return null;
  if (_countForDevice(device) >= MAX_TOKENS_PER_DEVICE) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  _tokens.set(token, { device: device, sessionId: sessionId, expiresAt: now + tokenTtlMs() });
  return token;
}

/**
 * Redeem a token. Single use: the token is consumed whether or not the upload
 * that follows succeeds, so the client re-mints on retry.
 * @param {string} token
 * @param {number} [now]
 * @returns {{device: string, sessionId: string}|null}
 */
function takeToken(token, now) {
  now = now || Date.now();
  if (typeof token !== 'string' || !token) return null;
  const rec = _tokens.get(token);
  if (!rec) return null;
  _tokens.delete(token);
  if (rec.expiresAt <= now) return null;
  return { device: rec.device, sessionId: rec.sessionId };
}

/**
 * Drop a device's outstanding tokens — used when a device is revoked.
 * @param {string} device
 * @returns {number} tokens dropped
 */
function dropTokensForDevice(device) {
  let n = 0;
  for (const [token, rec] of _tokens) {
    if (rec.device === device) {
      _tokens.delete(token);
      n++;
    }
  }
  return n;
}

module.exports = {
  MIME_EXT,
  maxBytes,
  ttlMs,
  graceMs,
  tokenTtlMs,
  sanitizeName,
  extensionFor,
  sessionKeyFor,
  sessionDirFor,
  writeUpload,
  releaseForDevice,
  sweepUploads,
  purgeSession,
  mintToken,
  takeToken,
  dropTokensForDevice,
  // exported for tests
  readManifest,
  writeManifest,
};
