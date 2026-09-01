// test/unit/provider-claude.test.js — ClaudeProvider unit tests.
//
// Claude is the first provider implementation and the reference case.
// Every test here validates a contract that future providers must also
// satisfy — this file serves as the template for provider-X.test.js.
//
// Pure unit tests: no filesystem, no network, no tmux.
// install/uninstall are integration-tested separately.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

const ClaudeProvider = require('../../src/providers/claude');
const registry = require('../../src/providers/registry');

// ── Helpers ─────────────────────────────────────────────────────────────────

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

// ── Basic identity ──────────────────────────────────────────────────────────

test('ClaudeProvider — id', () => {
  assert.strictEqual(ClaudeProvider.id, 'claude');
});

test('ClaudeProvider — label', () => {
  assert.strictEqual(ClaudeProvider.label, 'Claude Code');
});

test('ClaudeProvider — mech', () => {
  assert.strictEqual(typeof ClaudeProvider.mech, 'string');
  assert.ok(ClaudeProvider.mech.length > 0);
});

test('ClaudeProvider — detect string', () => {
  assert.strictEqual(
    ClaudeProvider.detect,
    'command:claude||dir:$HOME/.claude||vscode-ext:anthropic.claude-code'
  );
});

test('ClaudeProvider — profile is null (native plugin installs)', () => {
  assert.strictEqual(ClaudeProvider.profile, null);
});

// ── Hook system ─────────────────────────────────────────────────────────────

test('ClaudeProvider — hookEvents', () => {
  assert.deepStrictEqual(ClaudeProvider.hookEvents, {
    sessionStart: 'SessionStart',
    stop: 'Stop',
    statusLine: 'StatusLine',
  });
});

test('ClaudeProvider — commandPrefix is /', () => {
  assert.strictEqual(ClaudeProvider.commandPrefix, '/');
});

// ── Config resolution ───────────────────────────────────────────────────────

test('ClaudeProvider — configDir defaults to ~/.claude', () => {
  withEnv({ CLAUDE_CONFIG_DIR: undefined }, () => {
    assert.strictEqual(ClaudeProvider.configDir(), path.join(os.homedir(), '.claude'));
  });
});

test('ClaudeProvider — configDir respects CLAUDE_CONFIG_DIR', () => {
  withEnv({ CLAUDE_CONFIG_DIR: '/custom/claude/config' }, () => {
    assert.strictEqual(ClaudeProvider.configDir(), '/custom/claude/config');
  });
});

test('ClaudeProvider — hooksDir is configDir/hooks', () => {
  withEnv({ CLAUDE_CONFIG_DIR: '/home/user/.claude' }, () => {
    assert.strictEqual(ClaudeProvider.hooksDir(), '/home/user/.claude/hooks');
  });
});

test('ClaudeProvider — hooksConfigPath is configDir/settings.json', () => {
  withEnv({ CLAUDE_CONFIG_DIR: '/home/user/.claude' }, () => {
    assert.strictEqual(ClaudeProvider.hooksConfigPath(), '/home/user/.claude/settings.json');
  });
});

test('ClaudeProvider — skillsDir is configDir/skills', () => {
  withEnv({ CLAUDE_CONFIG_DIR: '/home/user/.claude' }, () => {
    assert.strictEqual(ClaudeProvider.skillsDir(), '/home/user/.claude/skills');
  });
});

test('ClaudeProvider — commandsDir is configDir/commands', () => {
  withEnv({ CLAUDE_CONFIG_DIR: '/home/user/.claude' }, () => {
    assert.strictEqual(ClaudeProvider.commandsDir(), '/home/user/.claude/commands');
  });
});

test('ClaudeProvider — rulesDir returns null (Claude has no rules directory)', () => {
  assert.strictEqual(ClaudeProvider.rulesDir(), null);
});

test('ClaudeProvider — sessionsDir matches sessionsRootDir', () => {
  withEnv({ AIRPROMPT_SESSIONS_DIR: undefined }, () => {
    assert.strictEqual(
      ClaudeProvider.sessionsDir(),
      path.join(os.homedir(), '.airprompt', 'sessions')
    );
  });
});

test('ClaudeProvider — sessionsDir respects AIRPROMPT_SESSIONS_DIR', () => {
  withEnv({ AIRPROMPT_SESSIONS_DIR: '/custom/sessions' }, () => {
    assert.strictEqual(ClaudeProvider.sessionsDir(), '/custom/sessions');
  });
});

// ── Hook I/O (adapter pattern) ──────────────────────────────────────────────

test('ClaudeProvider — parseHookStdin parses valid Claude hook JSON', () => {
  const input = JSON.stringify({
    session_id: 'claude-12345-1234567890',
    cwd: '/home/user/projects/myapp',
    tmux_session: 'claude-myproject',
  });
  const ctx = ClaudeProvider.parseHookStdin(input);
  assert.strictEqual(ctx.sessionId, 'claude-12345-1234567890');
  assert.strictEqual(ctx.cwd, '/home/user/projects/myapp');
  assert.strictEqual(ctx.tmuxSession, 'claude-myproject');
  assert.strictEqual(ctx.providerId, 'claude');
  assert.deepStrictEqual(ctx.raw, {
    session_id: 'claude-12345-1234567890',
    cwd: '/home/user/projects/myapp',
    tmux_session: 'claude-myproject',
  });
});

test('ClaudeProvider — parseHookStdin handles empty string', () => {
  const ctx = ClaudeProvider.parseHookStdin('');
  assert.strictEqual(ctx.sessionId, '');
  assert.strictEqual(ctx.cwd, process.cwd());
  assert.strictEqual(ctx.tmuxSession, null);
  assert.strictEqual(ctx.providerId, 'claude');
  assert.deepStrictEqual(ctx.raw, {});
});

test('ClaudeProvider — parseHookStdin handles whitespace-only input', () => {
  const ctx = ClaudeProvider.parseHookStdin('   \n  ');
  assert.strictEqual(ctx.sessionId, '');
  assert.strictEqual(ctx.providerId, 'claude');
});

test('ClaudeProvider — parseHookStdin handles malformed JSON gracefully', () => {
  const ctx = ClaudeProvider.parseHookStdin('not json at all {{{');
  assert.strictEqual(ctx.sessionId, '');
  assert.strictEqual(ctx.cwd, process.cwd());
  assert.strictEqual(ctx.providerId, 'claude');
  assert.deepStrictEqual(ctx.raw, {});
});

test('ClaudeProvider — parseHookStdin handles partial JSON (missing fields)', () => {
  const ctx = ClaudeProvider.parseHookStdin(JSON.stringify({ cwd: '/tmp' }));
  assert.strictEqual(ctx.sessionId, '');
  assert.strictEqual(ctx.cwd, '/tmp');
  assert.strictEqual(ctx.tmuxSession, null);
  assert.strictEqual(ctx.providerId, 'claude');
});

test('ClaudeProvider — parseHookStdin always sets providerId to claude', () => {
  // Even if raw JSON contains a different providerId, the wrapper owns this.
  const input = JSON.stringify({ session_id: 'x', provider_id: 'codex' });
  const ctx = ClaudeProvider.parseHookStdin(input);
  assert.strictEqual(ctx.providerId, 'claude');
});

test('ClaudeProvider — parseHookStdin preserves extra unknown fields in raw', () => {
  const input = JSON.stringify({ session_id: 's1', custom_field: 42, nested: { a: 1 } });
  const ctx = ClaudeProvider.parseHookStdin(input);
  assert.strictEqual(ctx.raw.custom_field, 42);
  assert.deepStrictEqual(ctx.raw.nested, { a: 1 });
});

// ── formatHookOutput ────────────────────────────────────────────────────────

test('ClaudeProvider — formatHookOutput returns JSON string', () => {
  const result = {
    status: 'ok',
    message: 'registered',
    url: 'https://192.168.1.5:3210',
    sessionId: 's1',
  };
  const output = ClaudeProvider.formatHookOutput(result);
  assert.strictEqual(output, JSON.stringify(result));
  // Verify round-trip
  assert.deepStrictEqual(JSON.parse(output), result);
});

test('ClaudeProvider — formatHookOutput handles error result', () => {
  const result = { status: 'error', message: 'daemon not running', url: null, sessionId: null };
  const output = ClaudeProvider.formatHookOutput(result);
  assert.deepStrictEqual(JSON.parse(output), result);
});

test('ClaudeProvider — formatHookOutput handles null url/sessionId', () => {
  const result = { status: 'ok', message: 'done', url: null, sessionId: null };
  const output = ClaudeProvider.formatHookOutput(result);
  const parsed = JSON.parse(output);
  assert.strictEqual(parsed.url, null);
  assert.strictEqual(parsed.sessionId, null);
});

// ── buildHookEntry ──────────────────────────────────────────────────────────

test('ClaudeProvider — buildHookEntry returns Claude-format hook entry', () => {
  const entry = ClaudeProvider.buildHookEntry('SessionStart', '/path/to/script.js', 10);
  assert.deepStrictEqual(entry, {
    hooks: [
      {
        type: 'command',
        command: '/path/to/script.js',
        timeout: 10,
      },
    ],
  });
});

test('ClaudeProvider — buildHookEntry with Stop event', () => {
  const entry = ClaudeProvider.buildHookEntry('Stop', '/path/to/deactivate.js', 5);
  assert.deepStrictEqual(entry, {
    hooks: [
      {
        type: 'command',
        command: '/path/to/deactivate.js',
        timeout: 5,
      },
    ],
  });
});

test('ClaudeProvider — buildHookEntry timeout is number, not string', () => {
  const entry = ClaudeProvider.buildHookEntry('SessionStart', '/x.js', 10);
  assert.strictEqual(typeof entry.hooks[0].timeout, 'number');
});

// ── buildStatusLineEntry ────────────────────────────────────────────────────

test('ClaudeProvider — buildStatusLineEntry returns command-type entry', () => {
  const entry = ClaudeProvider.buildStatusLineEntry('/path/to/statusline.sh');
  assert.deepStrictEqual(entry, {
    type: 'command',
    command: 'bash "/path/to/statusline.sh"',
  });
});

test('ClaudeProvider — buildStatusLineEntry uses bash wrapper', () => {
  const entry = ClaudeProvider.buildStatusLineEntry('/home/user/airprompt-statusline.sh');
  assert.ok(entry.command.startsWith('bash "'));
  assert.ok(entry.command.includes('airprompt-statusline.sh'));
});

// ── File manifests ──────────────────────────────────────────────────────────

test('ClaudeProvider — getHookFiles returns 3 hook files', () => {
  const files = ClaudeProvider.getHookFiles();
  assert.strictEqual(files.length, 3);
  for (const f of files) {
    assert.ok(typeof f.src === 'string' && f.src.length > 0, 'src must be non-empty string');
    assert.ok(typeof f.dest === 'string' && f.dest.length > 0, 'dest must be non-empty string');
  }
});

test('ClaudeProvider — getHookFiles includes all expected hooks', () => {
  const files = ClaudeProvider.getHookFiles();
  const names = files.map((f) => path.basename(f.src));
  assert.ok(names.includes('airprompt-activate.js'));
  assert.ok(names.includes('airprompt-deactivate.js'));
  assert.ok(names.includes('airprompt-statusline.sh'));
});

test('ClaudeProvider — getHookFiles dest paths end in hooksDir', () => {
  const files = ClaudeProvider.getHookFiles();
  for (const f of files) {
    assert.ok(f.dest.includes('/hooks/'), `dest should be in hooks dir: ${f.dest}`);
  }
});

test('ClaudeProvider — getSkillFiles returns empty array (skills shipped via plugin manifest)', () => {
  const files = ClaudeProvider.getSkillFiles();
  assert.deepStrictEqual(files, []);
});

test('ClaudeProvider — getCommandFiles returns 2 command files', () => {
  const files = ClaudeProvider.getCommandFiles();
  assert.strictEqual(files.length, 2);
  const names = files.map((f) => path.basename(f.src));
  assert.ok(names.includes('airprompt.md'));
  assert.ok(names.includes('airprompt.toml'));
});

test('ClaudeProvider — getCommandFiles dest paths end in commandsDir', () => {
  const files = ClaudeProvider.getCommandFiles();
  for (const f of files) {
    assert.ok(f.dest.includes('/commands/'), `dest should be in commands dir: ${f.dest}`);
  }
});

test('ClaudeProvider — getRuleFiles returns empty array', () => {
  const files = ClaudeProvider.getRuleFiles();
  assert.deepStrictEqual(files, []);
});

// ── detectMatch — command: probes ───────────────────────────────────────────

test('ClaudeProvider — detectMatch handles empty/null spec', () => {
  assert.strictEqual(ClaudeProvider.detectMatch(''), false);
  assert.strictEqual(ClaudeProvider.detectMatch(null), false);
  assert.strictEqual(ClaudeProvider.detectMatch(undefined), false);
});

test('ClaudeProvider — detectMatch: command: probes a known binary (node exists)', () => {
  // node is guaranteed available (we're running on it)
  assert.strictEqual(ClaudeProvider.detectMatch('command:node'), true);
});

test('ClaudeProvider — detectMatch: command: probes non-existent binary', () => {
  assert.strictEqual(ClaudeProvider.detectMatch('command:zzz_nonexistent_binary_42'), false);
});

test('ClaudeProvider — detectMatch: command: whitespace in spec', () => {
  assert.strictEqual(ClaudeProvider.detectMatch('  command:node  '), true);
});

test('ClaudeProvider — detectMatch: OR logic (first clause matches)', () => {
  // node exists → true regardless of second clause
  assert.strictEqual(ClaudeProvider.detectMatch('command:node||command:zzz'), true);
});

test('ClaudeProvider — detectMatch: OR logic (second clause matches)', () => {
  assert.strictEqual(ClaudeProvider.detectMatch('command:zzz||command:node'), true);
});

test('ClaudeProvider — detectMatch: OR logic (all false)', () => {
  assert.strictEqual(ClaudeProvider.detectMatch('command:zzz||command:yyy'), false);
});

test('ClaudeProvider — detectMatch: empty clause in OR chain', () => {
  // Empty clause skipped, node found → true
  assert.strictEqual(ClaudeProvider.detectMatch('command:zzz||  ||command:node'), true);
});

// ── detectMatch — dir: probes ───────────────────────────────────────────────

test('ClaudeProvider — detectMatch: dir: existing directory', () => {
  assert.strictEqual(ClaudeProvider.detectMatch(`dir:${os.homedir()}`), true);
});

test('ClaudeProvider — detectMatch: dir: nonexistent directory', () => {
  assert.strictEqual(ClaudeProvider.detectMatch('dir:/zzz/nonexistent/path/42'), false);
});

test('ClaudeProvider — detectMatch: dir: with $HOME expansion', () => {
  // $HOME is expanded by the provider
  assert.strictEqual(ClaudeProvider.detectMatch('dir:$HOME'), true);
});

test('ClaudeProvider — detectMatch: dir: with ~ expansion', () => {
  assert.strictEqual(ClaudeProvider.detectMatch('dir:~'), true);
});

test('ClaudeProvider — detectMatch: mixed command + dir OR', () => {
  assert.strictEqual(ClaudeProvider.detectMatch(`command:zzz||dir:${os.homedir()}`), true);
});

test('ClaudeProvider — detectMatch: spec with no colon (treated as bare command)', () => {
  // When there's no colon, kind=spec, val='' — the hasCmd('') call returns false
  assert.strictEqual(ClaudeProvider.detectMatch('nocolon'), false);
});

// ── Registry integration ────────────────────────────────────────────────────

test('ClaudeProvider — registered in provider registry', () => {
  registry.clearCache();
  const provider = registry.loadProvider('claude');
  assert.strictEqual(provider.id, 'claude');
  assert.strictEqual(provider.label, 'Claude Code');
});

test('ClaudeProvider — appears in listProviders', () => {
  registry.clearCache();
  const providers = registry.listProviders();
  assert.ok(providers.includes('claude'));
});

test('ClaudeProvider — appears in allProviders', () => {
  registry.clearCache();
  const all = registry.allProviders();
  const claude = all.find((p) => p.id === 'claude');
  assert.ok(claude);
  assert.strictEqual(typeof claude.configDir, 'function');
});

// ── Property existence (interface contract) ─────────────────────────────────

test('ClaudeProvider — has all required Provider interface properties', () => {
  const requiredProps = [
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
    'buildStatusLineEntry',
    'install',
    'uninstall',
    'getHookFiles',
    'getSkillFiles',
    'getCommandFiles',
    'getRuleFiles',
  ];
  for (const prop of requiredProps) {
    assert.ok(prop in ClaudeProvider, `missing property: ${prop}`);
  }
});

test('ClaudeProvider — has all required Provider interface methods as functions', () => {
  const methods = [
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
    'buildStatusLineEntry',
    'install',
    'uninstall',
    'getHookFiles',
    'getSkillFiles',
    'getCommandFiles',
    'getRuleFiles',
  ];
  for (const method of methods) {
    assert.strictEqual(
      typeof ClaudeProvider[method],
      'function',
      `ClaudeProvider.${method} should be a function`
    );
  }
});

test('ClaudeProvider — hookEvents has no null values (all three hooks supported)', () => {
  const events = ClaudeProvider.hookEvents;
  assert.notStrictEqual(events.sessionStart, null);
  assert.notStrictEqual(events.stop, null);
  assert.notStrictEqual(events.statusLine, null);
});
