#!/usr/bin/env node
// bin/lib/resolve-config-dir.js — Resolve IDE config dir via provider registry.
//
// Prints config dir path to stdout on success.
// Exits 1 on failure (no provider found).
//
// Usage: AIRPROMPT_INSTALL_DIR=... node bin/lib/resolve-config-dir.js [providerId]
//   If providerId given, looks up that specific provider.
//   Otherwise uses first available provider from the registry.

'use strict';

const installDir = process.env.AIRPROMPT_INSTALL_DIR || '';
if (!installDir) {
  process.stderr.write('AirPrompt: AIRPROMPT_INSTALL_DIR not set\n');
  process.exit(1);
}

let registry;
try {
  registry = require(installDir + '/src/providers/registry');
} catch (e) {
  process.stderr.write('AirPrompt: cannot load provider registry from ' + installDir + '\n');
  process.exit(1);
}

const targetId = process.argv[2] || '';
const providers = registry.allProviders();

if (providers.length === 0) {
  process.stderr.write('AirPrompt: no provider found\n');
  process.exit(1);
}

let provider;
if (targetId) {
  provider = providers.find((p) => p.id === targetId);
  if (!provider) {
    process.stderr.write('AirPrompt: provider "' + targetId + '" not found\n');
    process.exit(1);
  }
} else {
  // Use first detected (installed) provider, not allProviders()[0] which is
  // readdir-order and non-deterministic when multiple provider files exist.
  const detectedIds = registry.detectInstalledProviders();
  if (detectedIds.length === 0) {
    process.stderr.write('AirPrompt: no provider detected\n');
    process.exit(1);
  }
  provider = registry.loadProvider(detectedIds.sort()[0]);
}

if (typeof provider.configDir !== 'function') {
  process.stderr.write('AirPrompt: provider "' + provider.id + '" has no configDir()\n');
  process.exit(1);
}

process.stdout.write(provider.configDir() + '\n');
