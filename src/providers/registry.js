// src/providers/registry.js — Provider registry.
//
// Auto-discovers providers from src/providers/*.js.
// Base code calls registry.loadProvider(id) or registry.defaultProvider()
// without hardcoding IDE names.

'use strict';

const fs = require('fs');
const path = require('path');

// ── Internal cache ─────────────────────────────────────────────────────────

/** @type {Map<string, import('./provider').Provider>} */
let _cache = null;

// ── Discovery ──────────────────────────────────────────────────────────────

/**
 * Scan src/providers/ for provider files and load them.
 * Skips provider.js (interface) and registry.js (this file).
 * Each discovered file must export an object with at least `id` and `configDir`.
 * @returns {Map<string, import('./provider').Provider>}
 */
function discover() {
  if (_cache) return _cache;

  const map = new Map();
  const dir = __dirname;

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return map; // don't cache on failure — transient errors retry next call
  }

  for (const entry of entries) {
    if (!entry.endsWith('.js')) continue;
    if (entry === 'provider.js' || entry === 'registry.js') continue;

    const fullPath = path.join(dir, entry);
    let mod;
    try {
      mod = require(fullPath);
    } catch (e) {
      // Provider file with syntax errors or missing deps — skip, don't crash
      if (process.env.AIRPROMPT_DEBUG === '1') {
        process.stderr.write(`airprompt: registry — cannot load ${entry}: ${e.message}\n`);
      }
      continue;
    }

    if (!mod || typeof mod !== 'object' || !mod.id || typeof mod.configDir !== 'function') {
      if (process.env.AIRPROMPT_DEBUG === '1') {
        process.stderr.write(`airprompt: registry — skipping ${entry}: missing id or configDir()\n`);
      }
      continue;
    }

    map.set(mod.id, mod);
  }

  _cache = map; // only cache on success
  return _cache;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Load a provider by id.
 * @param {string} id - e.g. 'claude', 'codex'
 * @returns {import('./provider').Provider}
 * @throws {Error} if provider not found
 */
function loadProvider(id) {
  const providers = discover();
  const prov = providers.get(id);
  if (!prov) {
    throw new Error(`airprompt: unknown provider '${id}'. Available: ${[...providers.keys()].join(', ')}`);
  }
  return prov;
}

/**
 * List all available provider ids.
 * @returns {string[]}
 */
function listProviders() {
  return [...discover().keys()];
}

/**
 * Return all loaded provider instances.
 * @returns {import('./provider').Provider[]}
 */
function allProviders() {
  return [...discover().values()];
}

/**
 * Detect which providers are installed on this machine.
 * Runs detectMatch() against each provider's detect string.
 * @returns {string[]} provider ids that matched
 */
function detectInstalledProviders() {
  const detected = [];
  for (const [id, prov] of discover()) {
    if (typeof prov.detectMatch === 'function' && prov.detectMatch(prov.detect)) {
      detected.push(id);
    }
  }
  return detected;
}

/**
 * Return the best default provider.
 * First detected provider wins.
 * @returns {string} provider id
 * @throws {Error} if no provider detected or available
 */
function defaultProvider() {
  const detected = detectInstalledProviders();
  if (detected.length === 0) {
    throw new Error('airprompt: no provider detected. Set AIRPROMPT_PROVIDER env var or use --provider.');
  }
  return detected.sort()[0];  // deterministic order regardless of readdir
}

/**
 * Clear the provider cache (for testing).
 */
function clearCache() {
  _cache = null;
}

module.exports = {
  loadProvider,
  listProviders,
  allProviders,
  detectInstalledProviders,
  defaultProvider,
  clearCache,
};
