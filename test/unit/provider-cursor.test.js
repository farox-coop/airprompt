// test/unit/provider-cursor.test.js — CursorProvider unit tests.
//
// Validates provider-specific behavior: config dir, camelCase stdin with the
// empty-cwd → workspace_roots[0] fallback, and command/rule manifests.
// Pure unit tests: no filesystem, no network, no tmux.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const CursorProvider = require('../../src/providers/cursor');

test('CursorProvider — id / label', () => {
  assert.strictEqual(CursorProvider.id, 'cursor');
  assert.strictEqual(CursorProvider.label, 'Cursor');
});

test('CursorProvider — mech / detect / profile', () => {
  assert.strictEqual(CursorProvider.mech, 'direct file copy');
  assert.strictEqual(CursorProvider.detect, 'dir:$HOME/.cursor||macapp:Cursor.app');
  assert.strictEqual(CursorProvider.profile, null);
});

test('CursorProvider — commandPrefix is /', () => {
  assert.strictEqual(CursorProvider.commandPrefix, '/');
});

test('CursorProvider — hookEvents (sessionEnd, no statusline)', () => {
  assert.deepStrictEqual(CursorProvider.hookEvents, {
    sessionStart: 'sessionStart',
    stop: 'sessionEnd',
    statusLine: null,
  });
});

test('CursorProvider — configDir is ~/.cursor', () => {
  assert.strictEqual(CursorProvider.configDir(), path.join(os.homedir(), '.cursor'));
});

test('CursorProvider — parseHookStdin parses camelCase JSON', () => {
  const ctx = CursorProvider.parseHookStdin(
    JSON.stringify({ hook_event_name: 'sessionStart', session_id: 's1', cwd: '/repo' })
  );
  assert.strictEqual(ctx.sessionId, 's1');
  assert.strictEqual(ctx.cwd, '/repo');
  assert.strictEqual(ctx.providerId, 'cursor');
});

test('CursorProvider — parseHookStdin falls back to workspace_roots[0] when cwd empty', () => {
  const ctx = CursorProvider.parseHookStdin(
    JSON.stringify({ session_id: 's1', cwd: '', workspace_roots: ['/repo'] })
  );
  assert.strictEqual(ctx.cwd, '/repo');
});

test('CursorProvider — parseHookStdin falls back to conversation_id', () => {
  const ctx = CursorProvider.parseHookStdin(JSON.stringify({ conversation_id: 'c1' }));
  assert.strictEqual(ctx.sessionId, 'c1');
});

test('CursorProvider — parseHookStdin handles empty string', () => {
  const ctx = CursorProvider.parseHookStdin('');
  assert.strictEqual(ctx.sessionId, '');
  assert.strictEqual(ctx.cwd, process.cwd());
  assert.strictEqual(ctx.providerId, 'cursor');
});

test('CursorProvider — parseHookStdin handles malformed JSON', () => {
  const ctx = CursorProvider.parseHookStdin('garbage {{{');
  assert.strictEqual(ctx.sessionId, '');
  assert.strictEqual(ctx.providerId, 'cursor');
});

test('CursorProvider — formatHookOutput returns {} (fire-and-forget no-op)', () => {
  const out = CursorProvider.formatHookOutput({
    status: 'ok',
    message: 'x',
    url: null,
    sessionId: null,
  });
  assert.strictEqual(out, '{}');
});

test('CursorProvider — buildHookEntry returns version-1 shape', () => {
  const entry = CursorProvider.buildHookEntry('sessionStart', '/x.js', 30);
  assert.strictEqual(entry.version, 1);
  assert.strictEqual(entry.hooks.sessionStart[0].command, '/x.js');
  assert.strictEqual(entry.hooks.sessionStart[0].timeout, 30);
});

test('CursorProvider — file manifests', () => {
  assert.deepStrictEqual(CursorProvider.getHookFiles(), []);
  assert.deepStrictEqual(CursorProvider.getSkillFiles(), []);
  assert.strictEqual(CursorProvider.getCommandFiles().length, 1);
  assert.strictEqual(CursorProvider.getRuleFiles().length, 1);
  assert.ok(CursorProvider.getCommandFiles()[0].dest.endsWith('airprompt.md'));
  assert.ok(CursorProvider.getRuleFiles()[0].dest.endsWith('airprompt.mdc'));
});
