#!/usr/bin/env node
// bin/lib/resolve-provider.js — Resolve the detected provider id via the registry.
//
// Prints the provider id to stdout on success; exits 1 when none is detected.
// Detection runs each provider's `detect` string (command:/dir:/macapp:/vscode-ext:),
// so it correctly finds GUI providers (cursor/windsurf) that have no CLI binary.
//
// Usage: node bin/lib/resolve-provider.js

'use strict';

const path = require('path');

// Self-resolving: this script always lives at <installDir>/bin/lib/.
const installDir = path.resolve(__dirname, '../..');

let registry;
try {
  registry = require(path.join(installDir, 'src', 'providers', 'registry'));
} catch (e) {
  process.stderr.write('AirPrompt: cannot load provider registry from ' + installDir + '\n');
  process.exit(1);
}

let id;
try {
  // defaultProvider() returns the first detected provider in sorted order
  // (deterministic, alphabetical-first when multiple are installed).
  id = registry.defaultProvider();
} catch (_) {
  process.stderr.write('AirPrompt: no provider detected\n');
  process.exit(1);
}

process.stdout.write(id + '\n');
