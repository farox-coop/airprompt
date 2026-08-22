// test/unit/auth-client.test.js — Server ↔ client auth interop.
//
// Verifies the browser (WebCrypto) and daemon (Node crypto) speak the same
// language: raw r||s (IEEE P1363) ECDSA signatures, and the same SPKI-SHA-256
// fingerprint. This is the contract the Stage 2 client depends on.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

// public/auth.js is a browser IIFE that attaches to `window` and uses
// WebCrypto + IndexedDB. Node has WebCrypto (globalThis.crypto) and btoa/atob;
// IndexedDB is absent but the module degrades gracefully (returns a fresh key).
global.window = {};
require('../../public/auth.js');
const clientAuth = global.window.AirPromptAuth;

const serverAuth = require('../../src/auth');

function nodeKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    publicKeyB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey,
  };
}

test('client verifies a server signature (raw r||s interop)', async () => {
  const server = nodeKeyPair();
  const nonce = 'server-nonce-abc';
  const sig = serverAuth.signNonce(nonce, server.privateKey);
  assert.strictEqual(await clientAuth.verifyServerSignature(server.publicKeyB64, nonce, sig), true);
});

test('server verifies a client signature (raw r||s interop)', async () => {
  const device = await clientAuth.loadOrCreateDeviceKey();
  const nonce = 'client-nonce-def';
  const sig = await clientAuth.signNonce(nonce, device.privateKey);
  assert.strictEqual(serverAuth.verifyNonce(nonce, sig, device.publicKeyB64), true);
});

test('client fingerprint matches server fingerprint', async () => {
  const server = nodeKeyPair();
  const serverFp = serverAuth.fingerprintOf(Buffer.from(server.publicKeyB64, 'base64'));
  const clientFp = await clientAuth.fingerprintOf(server.publicKeyB64);
  assert.strictEqual(clientFp, serverFp);
  assert.match(clientFp, /^([0-9a-f]{2}:){15}[0-9a-f]{2}$/);
});

test('client rejects a signature from the wrong key', async () => {
  const server = nodeKeyPair();
  const attacker = nodeKeyPair();
  const sig = serverAuth.signNonce('nonce', attacker.privateKey);
  assert.strictEqual(await clientAuth.verifyServerSignature(server.publicKeyB64, 'nonce', sig), false);
});
