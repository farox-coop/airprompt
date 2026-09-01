// test/unit/provider-windsurf.test.js — WindsurfProvider unit tests.
//
// Validates provider-specific behavior: config dir, tolerant stdin parsing
// (least-documented format), no session-end hook, and skill/rule manifests.
// Pure unit tests: no filesystem, no network, no tmux.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const WindsurfProvider = require('../../src/providers/windsurf');

test('WindsurfProvider — id / label', () => {
  assert.strictEqual(WindsurfProvider.id, 'windsurf');
  assert.strictEqual(WindsurfProvider.label, 'Windsurf');
});

test('WindsurfProvider — mech / detect / profile', () => {
  assert.strictEqual(WindsurfProvider.mech, 'direct file copy');
  assert.strictEqual(
    WindsurfProvider.detect,
    'dir:$HOME/.codeium/windsurf||macapp:Windsurf.app||dir:$CODEIUM_EDITOR_APP_ROOT'
  );
  assert.strictEqual(WindsurfProvider.profile, null);
});

test('WindsurfProvider — commandPrefix is /', () => {
  assert.strictEqual(WindsurfProvider.commandPrefix, '/');
});

test('WindsurfProvider — hookEvents (no session-end)', () => {
  assert.deepStrictEqual(WindsurfProvider.hookEvents, {
    sessionStart: 'on-open',
    stop: null,
    statusLine: null,
  });
});

test('WindsurfProvider — configDir is ~/.codeium/windsurf', () => {
  assert.strictEqual(WindsurfProvider.configDir(), path.join(os.homedir(), '.codeium', 'windsurf'));
});

test('WindsurfProvider — parseHookStdin accepts session_id', () => {
  const ctx = WindsurfProvider.parseHookStdin(JSON.stringify({ session_id: 's1', cwd: '/repo' }));
  assert.strictEqual(ctx.sessionId, 's1');
  assert.strictEqual(ctx.cwd, '/repo');
  assert.strictEqual(ctx.providerId, 'windsurf');
});

test('WindsurfProvider — parseHookStdin falls back to trajectory_id', () => {
  const ctx = WindsurfProvider.parseHookStdin(JSON.stringify({ trajectory_id: 't1' }));
  assert.strictEqual(ctx.sessionId, 't1');
});

test('WindsurfProvider — parseHookStdin falls back to workspace_roots[0]', () => {
  const ctx = WindsurfProvider.parseHookStdin(
    JSON.stringify({ cwd: '', workspace_roots: ['/repo'] })
  );
  assert.strictEqual(ctx.cwd, '/repo');
});

test('WindsurfProvider — parseHookStdin falls back to conversation_id', () => {
  const ctx = WindsurfProvider.parseHookStdin(JSON.stringify({ conversation_id: 'c1' }));
  assert.strictEqual(ctx.sessionId, 'c1');
});

test('WindsurfProvider — parseHookStdin handles empty string', () => {
  const ctx = WindsurfProvider.parseHookStdin('');
  assert.strictEqual(ctx.sessionId, '');
  assert.strictEqual(ctx.cwd, process.cwd());
  assert.strictEqual(ctx.providerId, 'windsurf');
});

test('WindsurfProvider — parseHookStdin handles malformed JSON', () => {
  const ctx = WindsurfProvider.parseHookStdin('garbage {{{');
  assert.strictEqual(ctx.sessionId, '');
  assert.strictEqual(ctx.providerId, 'windsurf');
});

test('WindsurfProvider — formatHookOutput returns {} (no-op)', () => {
  const out = WindsurfProvider.formatHookOutput({
    status: 'ok',
    message: 'x',
    url: null,
    sessionId: null,
  });
  assert.strictEqual(out, '{}');
});

test('WindsurfProvider — buildHookEntry returns event → command shape', () => {
  const entry = WindsurfProvider.buildHookEntry('on-open', '/x.js', 30);
  assert.strictEqual(entry.hooks['on-open'].command, '/x.js');
});

test('WindsurfProvider — file manifests', () => {
  assert.deepStrictEqual(WindsurfProvider.getHookFiles(), []);
  assert.deepStrictEqual(WindsurfProvider.getCommandFiles(), []);
  assert.strictEqual(WindsurfProvider.getSkillFiles().length, 1);
  assert.strictEqual(WindsurfProvider.getRuleFiles().length, 1);
  assert.ok(WindsurfProvider.getSkillFiles()[0].dest.endsWith('airprompt/SKILL.md'));
  assert.ok(WindsurfProvider.getRuleFiles()[0].dest.endsWith('airprompt.md'));
});
