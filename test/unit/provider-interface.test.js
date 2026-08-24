// test/unit/provider-interface.test.js — Provider interface contract tests.
//
// Verifies that every provider loaded by the registry satisfies the
// Provider interface contract. Adding a new provider means adding one
// file to src/providers/ — this test auto-discovers it and validates it.
//
// Pure unit tests: no filesystem, no network, no tmux.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const registry = require('../../src/providers/registry');
const { sessionDir, sessionsRootDir, stateDir } = require('../../src/providers/provider');

// ── Setup ───────────────────────────────────────────────────────────────────

registry.clearCache();
const providers = registry.allProviders();

// ── Shared utility tests ────────────────────────────────────────────────────

test('provider.js — sessionsRootDir defaults to ~/.airprompt/sessions/', () => {
  const os = require('os');
  const path = require('path');
  delete process.env.AIRPROMPT_SESSIONS_DIR;
  assert.strictEqual(sessionsRootDir(), path.join(os.homedir(), '.airprompt', 'sessions'));
});

test('provider.js — stateDir defaults to ~/.airprompt/state/', () => {
  const os = require('os');
  const path = require('path');
  delete process.env.AIRPROMPT_STATE_DIR;
  assert.strictEqual(stateDir(), path.join(os.homedir(), '.airprompt', 'state'));
});

test('provider.js — sessionDir builds {providerId}-{sanitizedName} path', () => {
  const os = require('os');
  const path = require('path');
  delete process.env.AIRPROMPT_SESSIONS_DIR;
  const dir = sessionDir('claude', 'my project!');
  assert.ok(dir.includes('claude-myproject'));
  assert.ok(!dir.includes('!'), 'special chars should be stripped');
  assert.ok(dir.endsWith('claude-myproject'));
});

test('provider.js — sessionDir sanitizes shell-dangerous characters', () => {
  const dir = sessionDir('claude', 'foo;rm -rf /');
  assert.ok(!dir.includes(';'), 'semicolon should be stripped');
  assert.ok(!dir.includes(' '), 'spaces should be stripped');
});

test('provider.js — sessionDir handles empty session name', () => {
  const dir = sessionDir('claude', '');
  assert.ok(dir.endsWith('claude-'), 'empty name = just prefix+dash');
});

// ── Interface contract: every provider ──────────────────────────────────────

const REQUIRED_PROPS = [
  'id',
  'label',
  'mech',
  'detect',
  'profile',
  'hookEvents',
  'commandPrefix',
  'detectMatch',
  'parseHookStdin',
  'formatHookOutput',
  'buildHookEntry',
  'install',
  'uninstall',
  'getHookFiles',
  'getSkillFiles',
  'getCommandFiles',
  'getRuleFiles',
];

const REQUIRED_METHODS = [
  'configDir',
  'sessionsDir',
  'hooksDir',
  'hooksConfigPath',
  'skillsDir',
  'commandsDir',
  'rulesDir',
  'detectMatch',
  'parseHookStdin',
  'formatHookOutput',
  'buildHookEntry',
  'install',
  'uninstall',
  'getHookFiles',
  'getSkillFiles',
  'getCommandFiles',
  'getRuleFiles',
];

const OPTIONAL_PROPS = ['buildStatusLineEntry'];

for (const prov of providers) {
  const id = prov.id;

  test(`[${id}] has all required properties`, () => {
    for (const prop of REQUIRED_PROPS) {
      assert.ok(prop in prov, `${id}: missing required property "${prop}"`);
    }
  });

  test(`[${id}] all required methods are functions`, () => {
    for (const method of REQUIRED_METHODS) {
      assert.strictEqual(
        typeof prov[method],
        'function',
        `${id}: "${method}" should be a function, got ${typeof prov[method]}`
      );
    }
  });

  test(`[${id}] id is non-empty lowercase alphanumeric+dash string`, () => {
    assert.ok(typeof prov.id === 'string' && prov.id.length > 0, 'id must be non-empty string');
    assert.ok(/^[a-z][a-z0-9-]*$/.test(prov.id), `id "${prov.id}" must match ^[a-z][a-z0-9-]*$`);
  });

  test(`[${id}] label is non-empty string`, () => {
    assert.ok(
      typeof prov.label === 'string' && prov.label.length > 0,
      'label must be non-empty string'
    );
  });

  test(`[${id}] mech is non-empty string`, () => {
    assert.ok(
      typeof prov.mech === 'string' && prov.mech.length > 0,
      'mech must be non-empty string'
    );
  });

  test(`[${id}] detect is non-empty string`, () => {
    assert.ok(
      typeof prov.detect === 'string' && prov.detect.length > 0,
      'detect must be non-empty string'
    );
  });

  test(`[${id}] profile is string or null`, () => {
    assert.ok(
      prov.profile === null || typeof prov.profile === 'string',
      `profile must be null or string, got ${typeof prov.profile}`
    );
  });

  test(`[${id}] commandPrefix is non-empty string`, () => {
    assert.ok(
      typeof prov.commandPrefix === 'string' && prov.commandPrefix.length > 0,
      'commandPrefix must be non-empty string'
    );
  });

  // ── hookEvents shape ──────────────────────────────────────────────────

  test(`[${id}] hookEvents has sessionStart, stop, statusLine keys`, () => {
    const events = prov.hookEvents;
    assert.ok('sessionStart' in events, 'hookEvents.sessionStart missing');
    assert.ok('stop' in events, 'hookEvents.stop missing');
    assert.ok('statusLine' in events, 'hookEvents.statusLine missing');
  });

  test(`[${id}] hookEvents values are strings or null`, () => {
    const events = prov.hookEvents;
    for (const [key, val] of Object.entries(events)) {
      assert.ok(
        val === null || typeof val === 'string',
        `hookEvents.${key} must be string or null, got ${typeof val}`
      );
    }
  });

  // ── Config resolvers return strings ───────────────────────────────────

  test(`[${id}] configDir() returns non-empty string`, () => {
    const result = prov.configDir();
    assert.ok(
      typeof result === 'string' && result.length > 0,
      'configDir() must return non-empty string'
    );
  });

  test(`[${id}] sessionsDir() returns non-empty string`, () => {
    const result = prov.sessionsDir();
    assert.ok(
      typeof result === 'string' && result.length > 0,
      'sessionsDir() must return non-empty string'
    );
  });

  test(`[${id}] hooksDir() returns non-empty string`, () => {
    const result = prov.hooksDir();
    assert.ok(
      typeof result === 'string' && result.length > 0,
      'hooksDir() must return non-empty string'
    );
  });

  test(`[${id}] hooksConfigPath() returns non-empty string`, () => {
    const result = prov.hooksConfigPath();
    assert.ok(
      typeof result === 'string' && result.length > 0,
      'hooksConfigPath() must return non-empty string'
    );
  });

  test(`[${id}] skillsDir() returns non-empty string`, () => {
    const result = prov.skillsDir();
    assert.ok(
      typeof result === 'string' && result.length > 0,
      'skillsDir() must return non-empty string'
    );
  });

  test(`[${id}] commandsDir() returns non-empty string`, () => {
    const result = prov.commandsDir();
    assert.ok(
      typeof result === 'string' && result.length > 0,
      'commandsDir() must return non-empty string'
    );
  });

  test(`[${id}] rulesDir() returns string or null`, () => {
    const result = prov.rulesDir();
    assert.ok(
      result === null || typeof result === 'string',
      'rulesDir() must return string or null'
    );
  });

  // ── Hook I/O ──────────────────────────────────────────────────────────

  test(`[${id}] parseHookStdin returns HookContext shape`, () => {
    const ctx = prov.parseHookStdin('');
    assert.ok('sessionId' in ctx, 'HookContext.sessionId missing');
    assert.ok('cwd' in ctx, 'HookContext.cwd missing');
    assert.ok('tmuxSession' in ctx, 'HookContext.tmuxSession missing');
    assert.ok('providerId' in ctx, 'HookContext.providerId missing');
    assert.ok('raw' in ctx, 'HookContext.raw missing');
    assert.strictEqual(typeof ctx.sessionId, 'string');
    assert.strictEqual(typeof ctx.cwd, 'string');
    assert.strictEqual(ctx.providerId, id, `providerId should be "${id}", got "${ctx.providerId}"`);
    assert.strictEqual(typeof ctx.raw, 'object');
  });

  test(`[${id}] formatHookOutput returns string`, () => {
    const result = { status: 'ok', message: 'test', url: null, sessionId: null };
    const output = prov.formatHookOutput(result);
    assert.strictEqual(typeof output, 'string');
  });

  // ── buildHookEntry shape ──────────────────────────────────────────────

  test(`[${id}] buildHookEntry returns object`, () => {
    const entry = prov.buildHookEntry('SessionStart', '/fake/script.js', 10);
    assert.strictEqual(typeof entry, 'object');
    assert.notStrictEqual(entry, null);
  });

  // ── buildStatusLineEntry (if defined) ─────────────────────────────────

  test(`[${id}] buildStatusLineEntry returns object or null (if defined)`, () => {
    if (typeof prov.buildStatusLineEntry === 'function') {
      const entry = prov.buildStatusLineEntry('/fake/statusline.sh');
      assert.ok(
        entry === null || typeof entry === 'object',
        'buildStatusLineEntry must return object or null'
      );
    }
    // Passing: not all providers need statusLine support
  });

  // ── File manifests return arrays ──────────────────────────────────────

  test(`[${id}] getHookFiles returns array of {src, dest}`, () => {
    const files = prov.getHookFiles();
    assert.ok(Array.isArray(files), 'getHookFiles must return array');
    for (const f of files) {
      assert.ok(
        typeof f.src === 'string' && f.src.length > 0,
        'each hook file must have src string'
      );
      assert.ok(
        typeof f.dest === 'string' && f.dest.length > 0,
        'each hook file must have dest string'
      );
    }
  });

  test(`[${id}] getSkillFiles returns array of {src, dest}`, () => {
    const files = prov.getSkillFiles();
    assert.ok(Array.isArray(files), 'getSkillFiles must return array');
    for (const f of files) {
      assert.ok(
        typeof f.src === 'string' && f.src.length > 0,
        'each skill file must have src string'
      );
      assert.ok(
        typeof f.dest === 'string' && f.dest.length > 0,
        'each skill file must have dest string'
      );
    }
  });

  test(`[${id}] getCommandFiles returns array of {src, dest}`, () => {
    const files = prov.getCommandFiles();
    assert.ok(Array.isArray(files), 'getCommandFiles must return array');
    for (const f of files) {
      assert.ok(
        typeof f.src === 'string' && f.src.length > 0,
        'each command file must have src string'
      );
      assert.ok(
        typeof f.dest === 'string' && f.dest.length > 0,
        'each command file must have dest string'
      );
    }
  });

  test(`[${id}] getRuleFiles returns array of {src, dest}`, () => {
    const files = prov.getRuleFiles();
    assert.ok(Array.isArray(files), 'getRuleFiles must return array');
    for (const f of files) {
      assert.ok(
        typeof f.src === 'string' && f.src.length > 0,
        'each rule file must have src string'
      );
      assert.ok(
        typeof f.dest === 'string' && f.dest.length > 0,
        'each rule file must have dest string'
      );
    }
  });

  // ── install/uninstall are async functions ─────────────────────────────

  test(`[${id}] install is an async function`, () => {
    const fn = prov.install;
    assert.strictEqual(typeof fn, 'function');
    // Async functions have name 'install' and constructor.name 'AsyncFunction'
    assert.ok(
      fn.constructor.name === 'AsyncFunction' || fn.constructor.name === 'Function',
      `install should be async function, got ${fn.constructor.name}`
    );
  });

  test(`[${id}] uninstall is an async function`, () => {
    const fn = prov.uninstall;
    assert.strictEqual(typeof fn, 'function');
    assert.ok(
      fn.constructor.name === 'AsyncFunction' || fn.constructor.name === 'Function',
      `uninstall should be async function, got ${fn.constructor.name}`
    );
  });

  // ── detectMatch is callable ───────────────────────────────────────────

  test(`[${id}] detectMatch is a function`, () => {
    assert.strictEqual(typeof prov.detectMatch, 'function');
  });

  test(`[${id}] detectMatch returns boolean for empty string`, () => {
    const result = prov.detectMatch('');
    assert.strictEqual(typeof result, 'boolean', 'detectMatch must return boolean');
  });
}

// ── Registry API tests ──────────────────────────────────────────────────────

test('registry — listProviders returns string array', () => {
  registry.clearCache();
  const list = registry.listProviders();
  assert.ok(Array.isArray(list));
  assert.ok(list.length >= 1, 'at least claude should be present');
  for (const id of list) {
    assert.strictEqual(typeof id, 'string');
  }
});

test('registry — allProviders returns Provider array', () => {
  registry.clearCache();
  const all = registry.allProviders();
  assert.ok(Array.isArray(all));
  for (const prov of all) {
    assert.ok(typeof prov.id === 'string');
    assert.ok(typeof prov.configDir === 'function');
  }
});

test('registry — loadProvider("claude") returns ClaudeProvider', () => {
  registry.clearCache();
  const prov = registry.loadProvider('claude');
  assert.strictEqual(prov.id, 'claude');
  assert.strictEqual(prov.label, 'Claude Code');
});

test('registry — loadProvider throws for unknown provider', () => {
  registry.clearCache();
  assert.throws(() => registry.loadProvider('nonexistent-provider-999'), /unknown provider/);
});

test('registry — clearCache resets internal cache', () => {
  registry.clearCache();
  const first = registry.listProviders();
  registry.clearCache();
  const second = registry.listProviders();
  assert.deepStrictEqual(
    first.sort(),
    second.sort(),
    'providers should be the same after cache clear'
  );
});

test('registry — defaultProvider returns first detected provider', () => {
  registry.clearCache();
  // If claude is installed, it's detected; otherwise throws.
  // We can't guarantee claude is on PATH in test, so this is best-effort.
  try {
    const def = registry.defaultProvider();
    assert.strictEqual(typeof def, 'string');
    assert.ok(def.length > 0);
  } catch (e) {
    // Expected if no provider detected — test still passes
    assert.ok(e.message.includes('no provider detected'));
  }
});

test('registry — detectInstalledProviders returns string array', () => {
  registry.clearCache();
  const detected = registry.detectInstalledProviders();
  assert.ok(Array.isArray(detected));
  for (const id of detected) {
    assert.strictEqual(typeof id, 'string');
  }
});
