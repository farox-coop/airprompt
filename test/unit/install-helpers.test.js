'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { pkgInstallHint } = require('../../src/install-helpers');

test('pkgInstallHint — linux → sudo apt', () => {
  assert.strictEqual(pkgInstallHint(['jq'], 'linux'), 'sudo apt install jq');
});

test('pkgInstallHint — darwin → brew', () => {
  assert.strictEqual(pkgInstallHint(['jq'], 'darwin'), 'brew install jq');
});

test('pkgInstallHint — win32 → manual (no apt/brew)', () => {
  assert.strictEqual(
    pkgInstallHint(['jq'], 'win32'),
    '(Windows) install jq manually — no apt/brew'
  );
});

test('pkgInstallHint — multi-package joins with spaces', () => {
  assert.strictEqual(pkgInstallHint(['tmux', 'jq'], 'linux'), 'sudo apt install tmux jq');
});

test('pkgInstallHint — defaults to process.platform', () => {
  const expected =
    process.platform === 'darwin'
      ? 'brew install jq'
      : process.platform === 'win32'
        ? '(Windows) install jq manually — no apt/brew'
        : 'sudo apt install jq';
  assert.strictEqual(pkgInstallHint(['jq']), expected);
});
