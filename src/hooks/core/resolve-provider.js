// src/hooks/core/resolve-provider.js — Shared provider-id argv resolution.
//
// Both hook wrappers (airprompt-activate.js / airprompt-deactivate.js) need the
// same logic: resolve a provider id from argv (positional, `--provider <id>`, or
// `--provider=<id>`), defaulting to `claude`. An invalid id never throws — it
// falls through to the next candidate.

'use strict';

const registry = require('../../providers/registry');

/**
 * Resolve a provider from hook argv. Never throws on an invalid id.
 * @param {string[]} argv
 * @returns {import('../../providers/provider').Provider}
 */
function resolveProvider(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--provider' && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      try {
        return registry.loadProvider(argv[i + 1]);
      } catch (_) {
        /* invalid id — fall through */
      }
    } else if (a.startsWith('--provider=')) {
      try {
        return registry.loadProvider(a.slice('--provider='.length));
      } catch (_) {
        /* invalid id — fall through */
      }
    }
  }
  for (const a of argv) {
    if (a.startsWith('--')) continue;
    try {
      return registry.loadProvider(a);
    } catch (_) {
      /* not a provider id — try the next positional */
    }
  }
  return registry.loadProvider('claude');
}

module.exports = { resolveProvider };
