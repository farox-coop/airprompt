// src/auth.js — Device pairing + challenge-response auth.
//
// SSH-style device auth: the daemon holds a server keypair; each device holds
// its own ECDSA P-256 keypair. A device is whitelisted on the host
// (devices.json) after an explicit approval, then every connect proves key
// possession with a signed nonce. No shared secret, per-device revocation.
//
// The host approval surface (`airprompt auth allow|deny|revoke`) and the
// daemon both read/write the same state files directly — approval never flows
// through the unauthenticated REST surface (a rogue device could approve
// itself otherwise).
//
// State files live in stateDir() (~/.airprompt/state), alongside certs.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { stateDir } = require('./providers/provider');

// Auto-reject pairing requests not approved within this window.
const PENDING_TTL_MS = 60_000; // 1 minute
const PENDING_MAX = 8;          // cap the pending list (anti-flood)
const PENDING_PER_IP_MAX = 2;   // cap distinct pending requests per source IP
const PAIR_RATE_MAX = 5;        // per-IP pair attempts
const PAIR_RATE_WINDOW_MS = 60_000;

const SERVER_KEY_FILE = 'server-key.json';
const DEVICES_FILE = 'devices.json';
const PENDING_FILE = 'pending.json';

// ── Paths ──────────────────────────────────────────────────────────────────

function stateFile(name) {
  return path.join(stateDir(), name);
}

// ── JSON I/O (0600, atomic-enough for a local single daemon) ───────────────

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return fallback; }
}

function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Atomic: write a temp file then rename, so a concurrent reader (the daemon's
  // pairing poll) never sees a truncated/partial file — which it would otherwise
  // parse as empty and could misread as "every device revoked".
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ── Fingerprint ────────────────────────────────────────────────────────────

// SHA-256 of the public key (SPKI DER), shown as colon-hex (first 16 bytes),
// SSH known_hosts style.
function fingerprintOf(publicKeyDer) {
  const hex = crypto.createHash('sha256').update(publicKeyDer).digest('hex');
  return hex.slice(0, 32).replace(/(.{2})/g, '$1:').replace(/:$/, '');
}

// Normalize a base64 public key to its canonical spelling so that storage,
// dedupe, and lookup all compare the same string (base64 has many valid
// spellings for the same bytes — whitespace, padding variants).
function canonicalPublicKey(publicKeyB64) {
  try {
    return Buffer.from(String(publicKeyB64), 'base64').toString('base64');
  } catch (_) {
    return String(publicKeyB64);
  }
}

// Device names are shown on the host terminal (`auth list`) and in desktop
// notifications — strip control/ANSI chars so a rogue device can't inject
// escape sequences into the host's terminal or spoof the approval prompt.
function sanitizeName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 64).trim() || 'device';
}

// ── Server keypair ─────────────────────────────────────────────────────────

// Load the server keypair, generating + persisting it on first run.
// Returns { publicKeyDer: Buffer, privateKey: KeyObject, fingerprint, createdAt }.
function loadOrCreateServerKey() {
  const file = stateFile(SERVER_KEY_FILE);
  const existing = readJSON(file, null);
  if (existing && existing.publicKey && existing.privateKey) {
    const publicKeyDer = Buffer.from(existing.publicKey, 'base64');
    return {
      publicKeyDer,
      privateKey: crypto.createPrivateKey(existing.privateKey),
      fingerprint: fingerprintOf(publicKeyDer),
      createdAt: existing.createdAt,
    };
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  const data = {
    algorithm: 'ECDSA',
    curve: 'P-256',
    publicKey: publicKeyDer.toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    createdAt: new Date().toISOString(),
  };
  writeJSON(file, data);
  return { publicKeyDer, privateKey, fingerprint: fingerprintOf(publicKeyDer), createdAt: data.createdAt };
}

// ── Devices / pending ──────────────────────────────────────────────────────

function listDevices() {
  const data = readJSON(stateFile(DEVICES_FILE), { devices: [] });
  return Array.isArray(data.devices) ? data.devices : [];
}

// Returns the pending list, evicting expired entries (self-clean). Ordered by
// createdAt ASC == seq ASC, so ordinals never shift.
function listPending() {
  const file = stateFile(PENDING_FILE);
  const data = readJSON(file, { pending: [] });
  const pending = Array.isArray(data.pending) ? data.pending : [];
  const now = Date.now();
  const kept = pending.filter((p) => {
    const exp = p.expiresAt ? new Date(p.expiresAt).getTime() : 0;
    return now < exp;
  });
  if (kept.length !== pending.length) writeJSON(file, { pending: kept });
  return kept;
}

function nextSeq() {
  let max = 0;
  for (const d of listDevices()) max = Math.max(max, d.seq || 0);
  for (const p of listPending()) max = Math.max(max, p.seq || 0);
  return max + 1;
}

function deviceByPublicKey(publicKeyB64) {
  const canonical = canonicalPublicKey(publicKeyB64);
  return listDevices().find((d) => d.publicKey === canonical) || null;
}

// Look up an existing pending request by (canonicalized) public key.
function pendingByPublicKey(publicKeyB64) {
  const canonical = canonicalPublicKey(publicKeyB64);
  return listPending().find((p) => p.publicKey === canonical) || null;
}

// Add (or refresh) a pending pairing request. Returns the entry, or null if
// the list is full. Duplicate publicKey refreshes TTL (no new seq).
function addPending(publicKeyB64, name, ip) {
  const canonical = canonicalPublicKey(publicKeyB64);
  const pending = listPending();
  const existing = pending.find((p) => p.publicKey === canonical);
  if (existing) {
    existing.name = sanitizeName(name);
    existing.expiresAt = new Date(Date.now() + PENDING_TTL_MS).toISOString();
    writeJSON(stateFile(PENDING_FILE), { pending });
    return existing;
  }
  // Per-IP cap: one source can't monopolize the global pending list by
  // submitting many distinct keys and refreshing them each minute.
  if (ip && pending.filter((p) => p.ip === ip).length >= PENDING_PER_IP_MAX) return null;
  if (pending.length >= PENDING_MAX) return null;

  const entry = {
    seq: nextSeq(),
    id: crypto.randomUUID(),
    publicKey: canonical,
    name: sanitizeName(name),
    fingerprint: fingerprintOf(Buffer.from(canonical, 'base64')),
    ip: ip || null,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
  };
  pending.push(entry);
  writeJSON(stateFile(PENDING_FILE), { pending });
  return entry;
}

// Status of a pending request by id: 'pending' | 'allowed' | 'closed'.
function pendingStatus(id) {
  if (listDevices().some((d) => d.id === id)) return 'allowed';
  if (listPending().some((p) => p.id === id)) return 'pending';
  return 'closed';
}

function allowBySeq(seq) {
  const pending = listPending();
  const idx = pending.findIndex((p) => p.seq === seq);
  if (idx === -1) return null;
  const entry = pending.splice(idx, 1)[0];
  writeJSON(stateFile(PENDING_FILE), { pending });

  const devices = listDevices();
  devices.push({
    seq: entry.seq,
    id: entry.id,
    publicKey: entry.publicKey,
    name: entry.name,
    fingerprint: entry.fingerprint,
    createdAt: entry.createdAt,
    lastSeen: null,
  });
  writeJSON(stateFile(DEVICES_FILE), { devices });
  return entry;
}

function denyBySeq(seq) {
  const pending = listPending();
  const idx = pending.findIndex((p) => p.seq === seq);
  if (idx === -1) return null;
  const entry = pending.splice(idx, 1)[0];
  writeJSON(stateFile(PENDING_FILE), { pending });
  return entry;
}

function revokeBySeq(seq) {
  const devices = listDevices();
  const idx = devices.findIndex((d) => d.seq === seq);
  if (idx === -1) return null;
  const entry = devices.splice(idx, 1)[0];
  writeJSON(stateFile(DEVICES_FILE), { devices });
  return entry;
}

// Rename a paired device (shown in `auth list`).
function nameBySeq(seq, name) {
  const devices = listDevices();
  const d = devices.find((x) => x.seq === seq);
  if (!d) return null;
  d.name = sanitizeName(name);
  writeJSON(stateFile(DEVICES_FILE), { devices });
  return d;
}

// Update lastSeen (throttled to avoid a write on every reconnect).
function markDeviceSeen(publicKeyB64) {
  const canonical = canonicalPublicKey(publicKeyB64);
  const devices = listDevices();
  const d = devices.find((x) => x.publicKey === canonical);
  if (!d) return;
  const last = d.lastSeen ? new Date(d.lastSeen).getTime() : 0;
  if (Date.now() - last < 60_000) return;
  d.lastSeen = new Date().toISOString();
  writeJSON(stateFile(DEVICES_FILE), { devices });
}

// ── Challenge-response crypto (ECDSA P-256, raw r||s = WebCrypto format) ──

function generateNonce() {
  return crypto.randomBytes(32).toString('base64');
}

// Sign a nonce string with an ECDSA private key, raw IEEE P1363 format
// (matches WebCrypto's ECDSA signature format, unlike Node's DER default).
function signNonce(nonceStr, privateKey) {
  return crypto.sign('sha256', Buffer.from(nonceStr, 'utf8'), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64');
}

// Validate a base64 SPKI public key is an ECDSA P-256 key (reject junk from a
// rogue /api/pair caller before it reaches the pending list).
function isValidPublicKey(publicKeyB64) {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki',
    });
    return key.asymmetricKeyType === 'ec'
      && key.asymmetricKeyDetails
      && (key.asymmetricKeyDetails.namedCurve === 'prime256v1'
          || key.asymmetricKeyDetails.namedCurve === 'P-256');
  } catch (_) {
    return false;
  }
}

// Verify a signature over a nonce against a device's public key (SPKI DER b64).
function verifyNonce(nonceStr, signatureB64, publicKeyB64) {
  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki',
    });
    return crypto.verify('sha256', Buffer.from(nonceStr, 'utf8'), {
      key: publicKey,
      dsaEncoding: 'ieee-p1363',
    }, Buffer.from(signatureB64, 'base64'));
  } catch (_) {
    return false;
  }
}

// ── Anti-flood (in-memory, per-IP) ─────────────────────────────────────────

const _pairAttempts = new Map(); // ip -> [timestamps]

function checkPairRate(ip) {
  const now = Date.now();
  const arr = (_pairAttempts.get(ip) || []).filter((t) => now - t < PAIR_RATE_WINDOW_MS);
  if (arr.length === 0) _pairAttempts.delete(ip);
  if (arr.length >= PAIR_RATE_MAX) {
    _pairAttempts.set(ip, arr);
    return false;
  }
  arr.push(now);
  _pairAttempts.set(ip, arr);
  // Bound memory on a busy LAN (IPv6 privacy addresses rotate): drop
  // fully-expired entries once the map grows large.
  if (_pairAttempts.size > 1024) {
    for (const [k, times] of _pairAttempts) {
      if (times.every((t) => now - t >= PAIR_RATE_WINDOW_MS)) _pairAttempts.delete(k);
    }
  }
  return true;
}

module.exports = {
  PENDING_TTL_MS,
  PENDING_MAX,
  PENDING_PER_IP_MAX,
  loadOrCreateServerKey,
  fingerprintOf,
  listDevices,
  listPending,
  addPending,
  pendingStatus,
  allowBySeq,
  denyBySeq,
  revokeBySeq,
  nameBySeq,
  deviceByPublicKey,
  pendingByPublicKey,
  markDeviceSeen,
  generateNonce,
  signNonce,
  verifyNonce,
  isValidPublicKey,
  checkPairRate,
  stateFile,
};
