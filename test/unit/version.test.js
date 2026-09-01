// test/unit/version.test.js — version source-of-truth + release-tag validation.
//
// Covers src/version.js (reads the root `version` file) and the set-release-tag
// TAG validation regex — the most load-bearing part of the release tooling.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');

const { VERSION } = require('../../src/version');

test('src/version.js — reads the root `version` file as semver', () => {
  assert.ok(/^\d+\.\d+\.\d+$/.test(VERSION), `version should be semver, got: ${VERSION}`);
});

test('set-release-tag.js — rejects a tag without the `v` prefix', () => {
  const script = path.join(__dirname, '..', '..', 'bin', 'lib', 'set-release-tag.js');
  const r = spawnSync(process.execPath, [script, '1.0.0'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status}`);
  assert.ok(r.stderr.includes('Usage'), `stderr: ${r.stderr}`);
});

test('set-release-tag.js — rejects a malformed tag', () => {
  const script = path.join(__dirname, '..', '..', 'bin', 'lib', 'set-release-tag.js');
  const r = spawnSync(process.execPath, [script, 'v1.0'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status}`);
});
