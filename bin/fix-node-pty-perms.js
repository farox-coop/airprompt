#!/usr/bin/env node
// Restore node-pty's spawn-helper executable bit (see
// src/fix-node-pty-perms.js). Run by the npm postinstall hook and by hand.
'use strict';

const { fixNodePtyPerms } = require('../src/fix-node-pty-perms');

const fixed = fixNodePtyPerms();
if (fixed) process.stderr.write(`airprompt: fixed node-pty spawn-helper mode (${fixed})\n`);
