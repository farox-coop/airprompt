// test/unit/fix-node-pty-perms.test.js — spawn-helper permission repair.
//
// node-pty 1.1.x ships macOS prebuilds at mode 0644, so pty.spawn() fails
// until the bit is restored. The repair must fix exactly that, stay a no-op on
// layouts without a helper, and never fail the install when chmod is denied.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { fixNodePtyPerms } = require('../../src/fix-node-pty-perms');

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'airprompt-npty-'));
  return {
    root,
    nodePtyDir: path.join(root, 'node-pty'),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function writeHelper(dir, mode) {
  fs.mkdirSync(dir, { recursive: true });
  const helper = path.join(dir, 'spawn-helper');
  fs.writeFileSync(helper, '#!/bin/sh\n');
  fs.chmodSync(helper, mode);
  return helper;
}

test('fixNodePtyPerms — restores the exec bit on a prebuild helper', () => {
  const t = makeTree();
  try {
    const helper = writeHelper(path.join(t.nodePtyDir, 'prebuilds', 'darwin-x64'), 0o644);
    assert.strictEqual(fixNodePtyPerms({ nodePtyDir: t.nodePtyDir }), 1);
    assert.strictEqual(fs.statSync(helper).mode & 0o111, 0o111);
  } finally {
    t.cleanup();
  }
});

test('fixNodePtyPerms — leaves an executable helper untouched, second run is a no-op', () => {
  const t = makeTree();
  try {
    const helper = writeHelper(path.join(t.nodePtyDir, 'prebuilds', 'darwin-arm64'), 0o755);
    const before = fs.statSync(helper);
    assert.strictEqual(fixNodePtyPerms({ nodePtyDir: t.nodePtyDir }), 0);
    assert.strictEqual(fs.statSync(helper).mtimeMs, before.mtimeMs);
    assert.strictEqual(fixNodePtyPerms({ nodePtyDir: t.nodePtyDir }), 0);
  } finally {
    t.cleanup();
  }
});

test('fixNodePtyPerms — fixes build/Release as well as prebuilds', () => {
  const t = makeTree();
  try {
    const release = writeHelper(path.join(t.nodePtyDir, 'build', 'Release'), 0o644);
    const prebuilt = writeHelper(path.join(t.nodePtyDir, 'prebuilds', 'darwin-x64'), 0o644);
    assert.strictEqual(fixNodePtyPerms({ nodePtyDir: t.nodePtyDir }), 2);
    assert.strictEqual(fs.statSync(release).mode & 0o111, 0o111);
    assert.strictEqual(fs.statSync(prebuilt).mode & 0o111, 0o111);
  } finally {
    t.cleanup();
  }
});

test('fixNodePtyPerms — missing node-pty and missing prebuilds are silent no-ops', () => {
  const t = makeTree();
  try {
    assert.strictEqual(fixNodePtyPerms({ nodePtyDir: t.nodePtyDir }), 0);
    fs.mkdirSync(t.nodePtyDir, { recursive: true });
    assert.strictEqual(fixNodePtyPerms({ nodePtyDir: t.nodePtyDir }), 0);
  } finally {
    t.cleanup();
  }
});

test('fixNodePtyPerms — an unreadable prebuilds path is reported, not thrown', () => {
  const t = makeTree();
  try {
    fs.mkdirSync(t.nodePtyDir, { recursive: true });
    fs.writeFileSync(path.join(t.nodePtyDir, 'prebuilds'), ''); // ENOTDIR on readdir
    let stderr = '';
    const fixed = fixNodePtyPerms({
      nodePtyDir: t.nodePtyDir,
      stderr: { write: (s) => (stderr += s) },
    });
    assert.strictEqual(fixed, 0);
    assert.match(stderr, /cannot scan .*prebuilds/);
  } finally {
    t.cleanup();
  }
});

test('fixNodePtyPerms — a denied chmod is reported with a remedy, never thrown', () => {
  const t = makeTree();
  try {
    writeHelper(path.join(t.nodePtyDir, 'prebuilds', 'darwin-x64'), 0o644);
    // chmod needs ownership but not directory write access, so the EACCES case
    // (a root-owned install) is forced by stubbing the call.
    const realChmod = fs.chmodSync;
    fs.chmodSync = () => {
      const err = new Error('EPERM: operation not permitted');
      err.code = 'EPERM';
      throw err;
    };
    let stderr = '';
    try {
      const fixed = fixNodePtyPerms({
        nodePtyDir: t.nodePtyDir,
        stderr: { write: (s) => (stderr += s) },
      });
      assert.strictEqual(fixed, 0);
    } finally {
      fs.chmodSync = realChmod;
    }
    assert.match(stderr, /could not chmod/);
    assert.match(stderr, /sudo chmod \+x/);
  } finally {
    t.cleanup();
  }
});
