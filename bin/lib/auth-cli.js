#!/usr/bin/env node
// bin/lib/auth-cli.js — Host-side device auth (list/allow/deny/revoke).
//
// Operates directly on devices.json / pending.json in the state dir. No REST
// round-trip: approval must only happen on the trusted host filesystem, never
// through the unauthenticated /api/pair surface (which would let a rogue LAN
// device approve itself).
//
// Usage:
//   node auth-cli.js list
//   node auth-cli.js allow  <seq>
//   node auth-cli.js deny   <seq>
//   node auth-cli.js revoke <seq>

'use strict';

const auth = require('../../src/auth');

const cmd = process.argv[2];
const arg = process.argv[3];

function fmtTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '-' : d.toLocaleString();
}

function list() {
  const devices = auth.listDevices();
  const pending = auth.listPending();

  console.log('PAIRED:');
  if (devices.length === 0) console.log('  (none)');
  for (const d of devices) {
    console.log(`  ${d.seq}  ${d.name}  ${d.fingerprint}  last seen ${fmtTime(d.lastSeen)}`);
  }

  console.log('PENDING (awaiting approval):');
  if (pending.length === 0) console.log('  (none)');
  for (const p of pending) {
    console.log(`  ${p.seq}  ${p.name}  ${p.fingerprint}  created ${fmtTime(p.createdAt)}`);
  }
}

function seqArg() {
  if (!/^[0-9]+$/.test(arg || '')) {
    process.stderr.write(`Error: expected a positive seq number, got "${arg}"\n`);
    process.exit(1);
  }
  const n = parseInt(arg, 10);
  if (n < 1) {
    process.stderr.write(`Error: expected a positive seq number, got "${arg}"\n`);
    process.exit(1);
  }
  return n;
}

switch (cmd) {
  case 'list':
  case 'devices':
    list();
    break;

  case 'allow': {
    const entry = auth.allowBySeq(seqArg());
    if (!entry) { process.stderr.write('Error: no pending device with that seq\n'); process.exit(1); }
    console.log(`Allowed device "${entry.name}" (seq ${entry.seq})`);
    break;
  }

  case 'deny': {
    const entry = auth.denyBySeq(seqArg());
    if (!entry) { process.stderr.write('Error: no pending device with that seq\n'); process.exit(1); }
    console.log(`Denied device "${entry.name}" (seq ${entry.seq})`);
    break;
  }

  case 'revoke': {
    const entry = auth.revokeBySeq(seqArg());
    if (!entry) { process.stderr.write('Error: no paired device with that seq\n'); process.exit(1); }
    console.log(`Revoked device "${entry.name}" (seq ${entry.seq})`);
    break;
  }

  case 'name': {
    const seq = seqArg();
    const name = process.argv.slice(4).join(' ');
    const entry = auth.nameBySeq(seq, name);
    if (!entry) { process.stderr.write('Error: no paired device with that seq\n'); process.exit(1); }
    console.log(`Named device (seq ${seq}) "${entry.name}"`);
    break;
  }

  default:
    process.stderr.write('Usage: node auth-cli.js <list|allow|deny|revoke|name> [seq] [name]\n');
    process.exit(1);
}
