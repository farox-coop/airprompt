// src/version.js — Single source of truth for the AirPrompt version.
//
// Reads the `version` file at the repo root (plain `X.Y.Z`, no `v`). Used by the
// installer (to pin the clone to `v{version}`) and by `airprompt status` (to
// display it). When run directly (`node src/version.js`), prints the version.

'use strict';

const fs = require('fs');
const path = require('path');

function readVersion() {
  try {
    const v = fs.readFileSync(path.join(__dirname, '..', 'version'), 'utf8').trim();
    return v || '0.0.0';
  } catch (_) {
    return '0.0.0';
  }
}

const VERSION = readVersion();

if (require.main === module) {
  process.stdout.write(VERSION + '\n');
}

module.exports = { VERSION };
