// test/unit/hook-resolve-provider.test.js — hook argv provider resolution.
//
// Covers resolveProvider(argv) — the shared logic both hook wrappers use to pick
// the provider from argv (positional, --provider, --provider=), defaulting to
// claude and never throwing on an invalid id.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { resolveProvider } = require('../../src/hooks/core/resolve-provider');

test('resolveProvider — positional id', () => {
  assert.strictEqual(resolveProvider(['codex']).id, 'codex');
  assert.strictEqual(resolveProvider(['cursor']).id, 'cursor');
  assert.strictEqual(resolveProvider(['windsurf']).id, 'windsurf');
});

test('resolveProvider — --provider <id>', () => {
  assert.strictEqual(resolveProvider(['--provider', 'codex']).id, 'codex');
});

test('resolveProvider — --provider=<id>', () => {
  assert.strictEqual(resolveProvider(['--provider=codex']).id, 'codex');
});

test('resolveProvider — invalid ids fall through to claude (never throws)', () => {
  assert.strictEqual(resolveProvider(['bogus']).id, 'claude');
  assert.strictEqual(resolveProvider(['--provider', 'bogus']).id, 'claude');
  assert.strictEqual(resolveProvider(['--provider=bogus']).id, 'claude');
  assert.strictEqual(resolveProvider(['--provider']).id, 'claude'); // no value
});

test('resolveProvider — empty argv defaults to claude', () => {
  assert.strictEqual(resolveProvider([]).id, 'claude');
});

test('resolveProvider — --dump-stdin flag ignored, provider still resolved', () => {
  assert.strictEqual(resolveProvider(['codex', '--dump-stdin']).id, 'codex');
});

test('resolveProvider — explicit --provider wins over positional', () => {
  assert.strictEqual(resolveProvider(['codex', '--provider', 'cursor']).id, 'cursor');
});
