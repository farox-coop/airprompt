// test/unit/auth.test.js — Device pairing + challenge-response unit tests.
//
// Pure module tests (no server, no network, no tmux). State files are isolated
// in a temp dir via AIRPROMPT_STATE_DIR.

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const auth = require('../../src/auth');

let stateDir;

function genKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    publicKeyB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey,
  };
}

before(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airprompt-auth-unit-'));
  process.env.AIRPROMPT_STATE_DIR = stateDir;
});

after(() => {
  delete process.env.AIRPROMPT_STATE_DIR;
  try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
});

// ── Server keypair ─────────────────────────────────────────────────────────

test('loadOrCreateServerKey generates + persists + reloads the same fingerprint', () => {
  const first = auth.loadOrCreateServerKey();
  assert.ok(first.privateKey);
  assert.match(first.fingerprint, /^([0-9a-f]{2}:){15}[0-9a-f]{2}$/);
  const second = auth.loadOrCreateServerKey();
  assert.strictEqual(second.fingerprint, first.fingerprint);
});

// ── isValidPublicKey ───────────────────────────────────────────────────────

test('isValidPublicKey accepts P-256, rejects junk and other curves', () => {
  const { publicKeyB64 } = genKeyPair();
  assert.strictEqual(auth.isValidPublicKey(publicKeyB64), true);
  assert.strictEqual(auth.isValidPublicKey('not-base64!!'), false);
  const { publicKey: p384 } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-384' });
  const p384b64 = p384.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.strictEqual(auth.isValidPublicKey(p384b64), false);
});

// ── sign / verify (raw IEEE P1363 = WebCrypto format) ─────────────────────

test('signNonce/verifyNonce round-trips; wrong signature fails', () => {
  const { publicKeyB64, privateKey } = genKeyPair();
  const nonce = auth.generateNonce();
  const sig = auth.signNonce(nonce, privateKey);
  assert.strictEqual(auth.verifyNonce(nonce, sig, publicKeyB64), true);
  assert.strictEqual(auth.verifyNonce(nonce, 'AAAA', publicKeyB64), false);
  assert.strictEqual(auth.verifyNonce('other-nonce', sig, publicKeyB64), false);
});

// ── pending / devices lifecycle ────────────────────────────────────────────

test('addPending assigns monotonic seq, dedupes by publicKey, allow/revoke move entries', () => {
  const a = genKeyPair();
  const b = genKeyPair();

  const e1 = auth.addPending(a.publicKeyB64, 'iPhone');
  assert.strictEqual(e1.seq, 1);

  // duplicate publicKey refreshes, no new seq
  const e1b = auth.addPending(a.publicKeyB64, 'iPhone-renamed');
  assert.strictEqual(e1b.seq, 1);
  assert.strictEqual(auth.listPending().length, 1);

  const e2 = auth.addPending(b.publicKeyB64, 'iPad');
  assert.strictEqual(e2.seq, 2);

  // no shift: deny the first, seq 2 stays seq 2
  auth.denyBySeq(1);
  assert.strictEqual(auth.listPending().map((p) => p.seq).join(','), '2');

  // allow the remaining; revoke it
  auth.allowBySeq(2);
  assert.strictEqual(auth.listDevices().length, 1);
  assert.strictEqual(auth.deviceByPublicKey(b.publicKeyB64).seq, 2);
  auth.revokeBySeq(2);
  assert.strictEqual(auth.listDevices().length, 0);
});

test('pendingStatus transitions pending → allowed → closed', () => {
  const { publicKeyB64 } = genKeyPair();
  const e = auth.addPending(publicKeyB64, 'phone');
  assert.strictEqual(auth.pendingStatus(e.id), 'pending');
  auth.allowBySeq(e.seq);
  assert.strictEqual(auth.pendingStatus(e.id), 'allowed');
  auth.revokeBySeq(e.seq);
  assert.strictEqual(auth.pendingStatus(e.id), 'closed');
});

test('expired pending entries are auto-evicted on read (1 min TTL)', () => {
  const { publicKeyB64 } = genKeyPair();
  const e = auth.addPending(publicKeyB64, 'phone');
  // Force-expire by rewriting the pending file with a past expiresAt.
  const file = auth.stateFile('pending.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.pending[0].expiresAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(data));
  assert.strictEqual(auth.listPending().length, 0, 'expired entry should be evicted');
  assert.strictEqual(auth.pendingStatus(e.id), 'closed');
});

// ── anti-flood ─────────────────────────────────────────────────────────────

test('checkPairRate allows 5 per window then blocks', () => {
  const ip = '192.0.2.1'; // TEST-NET-1, unique to this test
  for (let i = 0; i < 5; i++) assert.strictEqual(auth.checkPairRate(ip), true);
  assert.strictEqual(auth.checkPairRate(ip), false, '6th attempt within window must be blocked');
});

test('addPending returns null when the pending list is full (cap)', () => {
  for (let i = 0; i < auth.PENDING_MAX; i++) {
    const { publicKeyB64 } = genKeyPair();
    assert.ok(auth.addPending(publicKeyB64, 'device-' + i), `entry ${i} should be accepted`);
  }
  assert.strictEqual(auth.listPending().length, auth.PENDING_MAX);
  const { publicKeyB64 } = genKeyPair();
  assert.strictEqual(auth.addPending(publicKeyB64, 'overflow'), null, 'cap should refuse the next request');
});
