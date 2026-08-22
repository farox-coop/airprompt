// public/auth.js — Device pairing + mutual challenge-response (browser).
//
// WebCrypto ECDSA P-256 keypair (non-extractable, persisted in IndexedDB),
// server-fingerprint pinning (from the QR's `#fp=`), and the pairing flow.
// The WS handshake itself lives in client.js (which owns the socket); this
// module provides the crypto + persistence + pairing primitives it needs.

(function () {
  'use strict';

  const IDB_NAME = 'airprompt';
  const IDB_STORE = 'auth';
  const KEY_DEVICE = 'deviceKey';
  const KEY_FP = 'serverFingerprint';
  const PAIR_POLL_MS = 2000;
  const PAIR_TTL_MS = 70_000; // server TTL is 60s — poll a bit past it

  // ── byte <-> base64 helpers ──────────────────────────────────────────────

  function bytesToB64(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // ── IndexedDB persistence ────────────────────────────────────────────────

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch (_) { return null; }
  }

  async function idbSet(key, value) {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  // ── Device keypair ───────────────────────────────────────────────────────

  // Load the device keypair, generating + persisting it on first visit.
  // Returns { publicKeyB64, privateKey } (privateKey is a non-extractable
  // CryptoKey — it signs but can never be exported).
  async function loadOrCreateDeviceKey() {
    const existing = await idbGet(KEY_DEVICE);
    if (existing && existing.publicKeyB64 && existing.privateKey) return existing;

    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,            // non-extractable
      ['sign', 'verify']
    );
    const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
    const device = { publicKeyB64: bytesToB64(new Uint8Array(spki)), privateKey: kp.privateKey };
    try { await idbSet(KEY_DEVICE, device); } catch (_) { /* private mode — key is per-session */ }
    return device;
  }

  // ── Crypto ops ───────────────────────────────────────────────────────────

  // Sign a nonce string with the device key → base64 raw r||s (matches the
  // server's ieee-p1363 format).
  async function signNonce(nonceStr, privateKey) {
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      new TextEncoder().encode(nonceStr)
    );
    return bytesToB64(new Uint8Array(sig));
  }

  // Verify the server's signature over a data string using its public key.
  async function verifyServerSignature(serverPublicKeyB64, dataStr, signatureB64) {
    try {
      const key = await crypto.subtle.importKey(
        'spki', b64ToBytes(serverPublicKeyB64).buffer,
        { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
      );
      return await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key, b64ToBytes(signatureB64),
        new TextEncoder().encode(dataStr)
      );
    } catch (_) { return false; }
  }

  // SHA-256 of the server public key (SPKI DER), colon-hex (first 16 bytes) —
  // the same format the daemon prints and the QR carries as `#fp=…`.
  async function fingerprintOf(serverPublicKeyB64) {
    const digest = await crypto.subtle.digest('SHA-256', b64ToBytes(serverPublicKeyB64).buffer);
    const hex = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 32);
    return hex.replace(/(.{2})/g, '$1:').replace(/:$/, '');
  }

  // Read the pinned server fingerprint WITHOUT persisting: { stored, qr }.
  // The caller verifies against the live challenge, and only then persists.
  async function getPinned() {
    let qr = null;
    try { qr = new URLSearchParams(window.location.hash.slice(1)).get('fp'); } catch (_) {}
    const stored = await idbGet(KEY_FP);
    return { stored: stored || null, qr: qr || null };
  }

  async function persistFingerprint(fp) {
    try { await idbSet(KEY_FP, fp); } catch (_) {}
  }

  async function clearFingerprint() {
    try {
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(KEY_FP);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch (_) {}
  }

  // ── Pairing flow ─────────────────────────────────────────────────────────

  // POST a pairing request for this device. Returns { paired:true } if the
  // device is already whitelisted, or { paired:false, seq, requestId }.
  async function pair(publicKeyB64) {
    const res = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: publicKeyB64, name: 'AirPrompt device' }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.status === 'paired') return { paired: true };
    if (data.status !== 'pending') throw new Error(data.error || 'pairing failed');
    return { paired: false, seq: data.seq, requestId: data.requestId };
  }

  // Poll the pairing status until allowed or the request expires/denied.
  // Returns 'allowed' | 'closed'.
  async function waitForApproval(requestId) {
    const deadline = Date.now() + PAIR_TTL_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, PAIR_POLL_MS));
      try {
        const res = await fetch(`/api/pair/${requestId}`);
        const data = await res.json().catch(() => ({}));
        if (data.status === 'allowed') return 'allowed';
        if (data.status === 'closed') return 'closed';
      } catch (_) { /* daemon unreachable — keep polling */ }
    }
    return 'closed';
  }

  window.AirPromptAuth = {
    loadOrCreateDeviceKey,
    signNonce,
    verifyServerSignature,
    fingerprintOf,
    getPinned,
    persistFingerprint,
    clearFingerprint,
    pair,
    waitForApproval,
  };
})();
