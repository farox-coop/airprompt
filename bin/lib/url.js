#!/usr/bin/env node
// bin/lib/url.js — Web UI URL + QR helper for shell scripts (on.sh / status.sh).
//
// Reads server-key.json + devices.json from the state dir and prints the web
// UI URL (carrying the server fingerprint as `#fp=`) plus paired-device status.
// Reuses src/auth.js so the fingerprint format and stateDir() stay in one place.
//
// Usage:
//   node url.js info  <proto> <port> <ip>   # prints: URL=…  then  PAIRED=0|1
//   node url.js qr    <url>                 # prints the QR code for <url>

'use strict';

const fs = require('fs');
const auth = require('../../src/auth');

const cmd = process.argv[2];

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function info() {
  const [proto, port, ip] = process.argv.slice(3);

  let fp = '';
  const key = readJSON(auth.stateFile('server-key.json'));
  if (key && key.publicKey) fp = auth.fingerprintOf(Buffer.from(key.publicKey, 'base64'));

  const paired = auth.listDevices().length > 0 ? 1 : 0;
  const url = `${proto}://${ip}:${port}` + (fp ? `/#fp=${fp}` : '');

  console.log(`URL=${url}`);
  console.log(`PAIRED=${paired}`);
}

function qr() {
  const url = process.argv[3] || '';
  try {
    require('qrcode-terminal').generate(url, { small: true });
  } catch (_) {}
}

if (cmd === 'qr') qr();
else info();
