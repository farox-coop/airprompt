// test/unit/utils.test.js — isSafeRmTarget guard tests.
//
// The Node-side `rm -rf` guard must block a misconfigured
// AIRPROMPT_SESSIONS_DIR=/home (or /tmp, /) from deleting arbitrary dirs
// during startup recovery, while still allowing deletes inside AirPrompt-owned
// dirs. Mirrors the shell `_safe_rm_rf` in bin/lib/protocol.sh.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

const { isSafeRmTarget } = require('../../src/utils');

// Env vars read at call time by provider.js — isolate each test.
function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

const DEFAULT_SESSIONS = path.join(os.homedir(), '.airprompt', 'sessions');

test('isSafeRmTarget — allows a path under the default sessions dir', () => {
  withEnv({ AIRPROMPT_INSTALL_DIR: undefined, AIRPROMPT_SESSIONS_DIR: undefined, AIRPROMPT_STATE_DIR: undefined }, () => {
    assert.strictEqual(isSafeRmTarget(path.join(DEFAULT_SESSIONS, 'claude-myproj')), true);
  });
});

test('isSafeRmTarget — allows a path under a custom sessions dir containing "airprompt"', () => {
  const dir = '/tmp/airprompt-test-sessions';
  withEnv({ AIRPROMPT_SESSIONS_DIR: dir, AIRPROMPT_STATE_DIR: undefined, AIRPROMPT_INSTALL_DIR: undefined }, () => {
    assert.strictEqual(isSafeRmTarget(path.join(dir, 'claude-x')), true);
  });
});

test('isSafeRmTarget — blocks a sibling dir sharing the "airprompt" prefix', () => {
  // path.relative must split on separators, not string prefix: a sibling
  // /tmp/airprompt-test-sessions-evil must NOT pass containment for root
  // /tmp/airprompt-test-sessions.
  const dir = '/tmp/airprompt-test-sessions';
  withEnv({ AIRPROMPT_SESSIONS_DIR: dir, AIRPROMPT_STATE_DIR: undefined, AIRPROMPT_INSTALL_DIR: undefined }, () => {
    assert.strictEqual(isSafeRmTarget('/tmp/airprompt-test-sessions-evil/claude-x'), false);
  });
});

test('isSafeRmTarget — blocks a misconfigured sessions dir (/home)', () => {
  // AIRPROMPT_SESSIONS_DIR=/home: the startup recovery loop would otherwise
  // rm -rf every dir under /home that lacks a tmux marker file.
  withEnv({ AIRPROMPT_SESSIONS_DIR: os.homedir(), AIRPROMPT_STATE_DIR: undefined }, () => {
    assert.strictEqual(isSafeRmTarget(path.join(os.homedir(), 'victim')), false);
  });
});

test('isSafeRmTarget — blocks a custom sessions dir without "airprompt" in the path', () => {
  withEnv({ AIRPROMPT_SESSIONS_DIR: '/tmp/sessions', AIRPROMPT_STATE_DIR: undefined }, () => {
    assert.strictEqual(isSafeRmTarget('/tmp/sessions/claude-x'), false);
  });
});

test('isSafeRmTarget — blocks ".." traversal escaping the sessions dir', () => {
  withEnv({ AIRPROMPT_SESSIONS_DIR: undefined, AIRPROMPT_STATE_DIR: undefined }, () => {
    const target = path.join(DEFAULT_SESSIONS, '..', '..', 'etc');
    assert.strictEqual(isSafeRmTarget(target), false);
  });
});

test('isSafeRmTarget — blocks empty, non-string, and root paths', () => {
  withEnv({ AIRPROMPT_SESSIONS_DIR: undefined, AIRPROMPT_STATE_DIR: undefined }, () => {
    assert.strictEqual(isSafeRmTarget(''), false);
    assert.strictEqual(isSafeRmTarget(null), false);
    assert.strictEqual(isSafeRmTarget(undefined), false);
    assert.strictEqual(isSafeRmTarget('/'), false);
  });
});

test('isSafeRmTarget — blocks a symlinked sessions dir resolving to a non-airprompt location', (t) => {
  const fs = require('fs');
  // Real target's full path must contain no "airprompt" — keep it in a
  // separately-named tmpdir, not under the "airprompt-symlink-" base.
  const realTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-symlink-dst-'));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'airprompt-symlink-'));
  const symlinkPath = path.join(base, 'sessions');
  try {
    try { fs.symlinkSync(realTarget, symlinkPath, 'dir'); }
    catch (_) { t.skip('symlinks not supported on this platform'); return; }

    withEnv({ AIRPROMPT_SESSIONS_DIR: symlinkPath, AIRPROMPT_STATE_DIR: undefined, AIRPROMPT_INSTALL_DIR: undefined }, () => {
      assert.strictEqual(isSafeRmTarget(path.join(symlinkPath, 'child')), false);
    });
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(realTarget, { recursive: true, force: true }); } catch (_) {}
  }
});

test('isSafeRmTarget — allows a symlinked sessions dir resolving to an airprompt-named location', (t) => {
  const fs = require('fs');
  const realTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'airprompt-symlink-dst-'));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'airprompt-symlink-'));
  const symlinkPath = path.join(base, 'sessions');
  try {
    try { fs.symlinkSync(realTarget, symlinkPath, 'dir'); }
    catch (_) { t.skip('symlinks not supported on this platform'); return; }

    withEnv({ AIRPROMPT_SESSIONS_DIR: symlinkPath, AIRPROMPT_STATE_DIR: undefined, AIRPROMPT_INSTALL_DIR: undefined }, () => {
      assert.strictEqual(isSafeRmTarget(path.join(symlinkPath, 'child')), true);
    });
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(realTarget, { recursive: true, force: true }); } catch (_) {}
  }
});
