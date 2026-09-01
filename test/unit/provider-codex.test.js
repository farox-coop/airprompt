// test/unit/provider-codex.test.js — CodexProvider unit tests.
//
// Mirrors provider-claude.test.js — validates provider-specific behavior:
// config dir, snake_case stdin, JSON-only Stop output, and file manifests.
// Pure unit tests: no filesystem, no network, no tmux.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const CodexProvider = require('../../src/providers/codex');

function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('CodexProvider — id / label', () => {
  assert.strictEqual(CodexProvider.id, 'codex');
  assert.strictEqual(CodexProvider.label, 'Codex CLI');
});

test('CodexProvider — mech / detect / profile', () => {
  assert.strictEqual(CodexProvider.mech, 'direct file copy');
  assert.strictEqual(
    CodexProvider.detect,
    'command:codex||dir:$HOME/.codex||dir:$CODEX_HOME||macapp:ChatGPT.app'
  );
  assert.strictEqual(CodexProvider.profile, null);
});

test('CodexProvider — commandPrefix is $', () => {
  assert.strictEqual(CodexProvider.commandPrefix, '$');
});

test('CodexProvider — hookEvents (no statusline)', () => {
  assert.deepStrictEqual(CodexProvider.hookEvents, {
    sessionStart: 'SessionStart',
    stop: 'Stop',
    statusLine: null,
  });
});

test('CodexProvider — configDir respects CODEX_HOME', () => {
  withEnv({ CODEX_HOME: '/custom/codex' }, () => {
    assert.strictEqual(CodexProvider.configDir(), '/custom/codex');
  });
});

test('CodexProvider — configDir falls back to legacy ~/.codex or XDG', () => {
  withEnv({ CODEX_HOME: undefined }, () => {
    const dir = CodexProvider.configDir();
    const legacy = path.join(os.homedir(), '.codex');
    const xdg = process.env.XDG_CONFIG_HOME
      ? path.join(process.env.XDG_CONFIG_HOME, 'codex')
      : path.join(os.homedir(), '.config', 'codex');
    assert.ok(dir === legacy || dir === xdg, `unexpected configDir: ${dir}`);
  });
});

test('CodexProvider — parseHookStdin parses snake_case JSON', () => {
  const ctx = CodexProvider.parseHookStdin(
    JSON.stringify({
      session_id: 's1',
      cwd: '/tmp',
      hook_event_name: 'SessionStart',
      source: 'startup',
    })
  );
  assert.strictEqual(ctx.sessionId, 's1');
  assert.strictEqual(ctx.cwd, '/tmp');
  assert.strictEqual(ctx.providerId, 'codex');
  assert.strictEqual(ctx.raw.source, 'startup');
});

test('CodexProvider — parseHookStdin handles empty string', () => {
  const ctx = CodexProvider.parseHookStdin('');
  assert.strictEqual(ctx.sessionId, '');
  assert.strictEqual(ctx.cwd, process.cwd());
  assert.strictEqual(ctx.providerId, 'codex');
});

test('CodexProvider — parseHookStdin handles malformed JSON', () => {
  const ctx = CodexProvider.parseHookStdin('not json {{{');
  assert.strictEqual(ctx.sessionId, '');
  assert.strictEqual(ctx.providerId, 'codex');
});

test('CodexProvider — formatHookOutput returns {} (no-op) for ok', () => {
  const out = CodexProvider.formatHookOutput({
    status: 'ok',
    message: 'x',
    url: null,
    sessionId: null,
  });
  assert.strictEqual(out, '{}');
});

test('CodexProvider — formatHookOutput surfaces error as systemMessage', () => {
  const out = CodexProvider.formatHookOutput({
    status: 'error',
    message: 'boom',
    url: null,
    sessionId: null,
  });
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.systemMessage, 'boom');
  assert.ok(!('decision' in parsed), 'must never emit decision: block (means "continue")');
});

test('CodexProvider — formatHookOutput error falls back to default message', () => {
  const out = CodexProvider.formatHookOutput({
    status: 'error',
    message: '',
    url: null,
    sessionId: null,
  });
  assert.strictEqual(JSON.parse(out).systemMessage, 'airprompt error');
});

test('CodexProvider — buildHookEntry returns matcher-group shape', () => {
  const entry = CodexProvider.buildHookEntry('SessionStart', '/x.js', 30);
  assert.strictEqual(entry.hooks.SessionStart[0].matcher, 'startup|resume|clear');
  assert.strictEqual(entry.hooks.SessionStart[0].hooks[0].command, '/x.js');
  assert.strictEqual(entry.hooks.SessionStart[0].hooks[0].timeout, 30);
});

test('CodexProvider — buildHookEntry omits matcher for Stop', () => {
  const entry = CodexProvider.buildHookEntry('Stop', '/y.js', 30);
  assert.ok(!('matcher' in entry.hooks.Stop[0]), 'Stop does not support matcher');
});

test('CodexProvider — file manifests', () => {
  assert.deepStrictEqual(CodexProvider.getHookFiles(), []);
  assert.deepStrictEqual(CodexProvider.getCommandFiles(), []);
  assert.deepStrictEqual(CodexProvider.getRuleFiles(), []);
  assert.strictEqual(CodexProvider.getSkillFiles().length, 1);
  assert.ok(CodexProvider.getSkillFiles()[0].dest.endsWith('airprompt/SKILL.md'));
});
