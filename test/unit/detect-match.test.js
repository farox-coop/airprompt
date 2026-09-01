// test/unit/detect-match.test.js — shared detectMatch probe coverage.
//
// Covers the macapp: and vscode-ext: probe kinds (added in provider.js), which
// previously had zero coverage. Uses node:test mock to redirect os.homedir() to
// a temp dir so the probes can be exercised without a real app/extension.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const { detectMatch } = require('../../src/providers/provider');

test('detectMatch — macapp: bare name resolves ~/Applications', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airprompt-detect-'));
  fs.mkdirSync(path.join(tmp, 'Applications', 'Foo.app'), { recursive: true });
  t.mock.method(os, 'homedir', () => tmp);
  assert.strictEqual(detectMatch('macapp:Foo.app'), true);
  assert.strictEqual(detectMatch('macapp:Nope.app'), false);
});

test('detectMatch — vscode-ext: matches an installed extension id', (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airprompt-detect-'));
  fs.mkdirSync(path.join(tmp, '.vscode', 'extensions', 'openai.codex-0.1.0'), { recursive: true });
  t.mock.method(os, 'homedir', () => tmp);
  assert.strictEqual(detectMatch('vscode-ext:openai.codex'), true);
  assert.strictEqual(detectMatch('vscode-ext:other.publisher'), false);
});

test('detectMatch — empty / unknown kinds return false', () => {
  assert.strictEqual(detectMatch(''), false);
  assert.strictEqual(detectMatch('macapp:'), false);
  assert.strictEqual(detectMatch('vscode-ext:'), false);
  assert.strictEqual(detectMatch('weird:something'), false);
});
