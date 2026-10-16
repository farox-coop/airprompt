// test/unit/provider-install.test.js — end-to-end install()/uninstall() round-trip.
//
// Proves the highest-value untested behavior: install() wires the correct
// hooks.json, is idempotent (no duplication), preserves pre-existing hooks, and
// uninstall() removes exactly what install() added. Runs against a temp dir with
// os.homedir() mocked so no real ~/bin, ~/.claude, or ~/.airprompt is touched.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ClaudeProvider = require('../../src/providers/claude');
const CodexProvider = require('../../src/providers/codex');
const CursorProvider = require('../../src/providers/cursor');
const WindsurfProvider = require('../../src/providers/windsurf');

// Populate a fake install target with the sentinels ensureCoreInstall checks, so
// the clone/npm/cert/symlink steps short-circuit and only hook wiring runs.
function makeTarget(tmp) {
  const targetDir = path.join(tmp, 'airprompt');
  fs.mkdirSync(path.join(targetDir, 'node_modules', 'express'), { recursive: true });
  fs.mkdirSync(path.join(targetDir, 'node_modules', '@xterm', 'xterm'), { recursive: true });
  fs.mkdirSync(path.join(targetDir, 'node_modules', '@xterm', 'addon-fit'), { recursive: true });
  fs.mkdirSync(path.join(targetDir, 'src', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'src', 'hooks', 'airprompt-activate.js'), '');
  fs.writeFileSync(path.join(targetDir, 'src', 'hooks', 'airprompt-deactivate.js'), '');
  fs.mkdirSync(path.join(targetDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(targetDir, 'bin', 'airprompt-launch'), '#!/bin/bash\n');
  fs.writeFileSync(path.join(targetDir, 'bin', 'airprompt'), '#!/bin/bash\n');

  const tmpl = path.join(targetDir, 'src', 'providers', 'templates');
  fs.mkdirSync(path.join(tmpl, 'codex'), { recursive: true });
  fs.writeFileSync(path.join(tmpl, 'codex', 'SKILL.md'), '# skill');
  fs.mkdirSync(path.join(tmpl, 'cursor'), { recursive: true });
  fs.writeFileSync(path.join(tmpl, 'cursor', 'airprompt.md'), '# cmd');
  fs.writeFileSync(path.join(tmpl, 'cursor', 'airprompt.mdc'), '---\n');
  fs.mkdirSync(path.join(tmpl, 'windsurf'), { recursive: true });
  fs.writeFileSync(path.join(tmpl, 'windsurf', 'SKILL.md'), '# skill');
  fs.writeFileSync(path.join(tmpl, 'windsurf', 'airprompt.md'), '---\n');
  return targetDir;
}

function makeCtx(targetDir, configDir) {
  const noop = () => {};
  return {
    say: noop,
    note: noop,
    warn: noop,
    ok: noop,
    opts: {
      dryRun: false,
      force: false,
      targetDir,
      nonInteractive: true,
      only: [],
      withHooks: 'auto',
    },
    configDir,
    results: { detected: 0, installed: [], skipped: [], failed: [] },
  };
}

// Redirect os.homedir() + all provider env vars under tmp for the test's duration.
function setupInstallEnv(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airprompt-install-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const targetDir = makeTarget(tmp);
  const stateDir = path.join(tmp, '.airprompt', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'airprompt-cert.pem'), 'cert');
  fs.writeFileSync(path.join(stateDir, 'airprompt-key.pem'), 'key');

  t.mock.method(os, 'homedir', () => tmp);

  const saved = {
    state: process.env.AIRPROMPT_STATE_DIR,
    install: process.env.AIRPROMPT_INSTALL_DIR,
    codexHome: process.env.CODEX_HOME,
    xdg: process.env.XDG_CONFIG_HOME,
    pidFile: process.env.AIRPROMPT_PID_FILE,
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
  };
  process.env.AIRPROMPT_STATE_DIR = stateDir;
  delete process.env.AIRPROMPT_INSTALL_DIR;
  delete process.env.CODEX_HOME;
  delete process.env.XDG_CONFIG_HOME;
  // MANDATORY: ClaudeProvider.uninstall() on a full uninstall SIGTERMs the PID
  // in `AIRPROMPT_PID_FILE || /tmp/airprompt-server.pid` and deletes that file.
  // Un-isolated, a test that calls uninstall() kills the developer's live
  // daemon — which is exactly what happened, four times, before this line.
  process.env.AIRPROMPT_PID_FILE = path.join(tmp, 'not-a-daemon.pid');
  // Same class of hazard: a provider that falls back to the config dir would
  // otherwise resolve the developer's real one when a test forgets ctx.configDir.
  delete process.env.CLAUDE_CONFIG_DIR;

  return {
    tmp,
    targetDir,
    ctx: makeCtx(targetDir, ''), // configDir set per-test below
    restore: () => {
      if (saved.state === undefined) delete process.env.AIRPROMPT_STATE_DIR;
      else process.env.AIRPROMPT_STATE_DIR = saved.state;
      if (saved.install === undefined) delete process.env.AIRPROMPT_INSTALL_DIR;
      else process.env.AIRPROMPT_INSTALL_DIR = saved.install;
      if (saved.codexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved.codexHome;
      if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved.xdg;
      if (saved.pidFile === undefined) delete process.env.AIRPROMPT_PID_FILE;
      else process.env.AIRPROMPT_PID_FILE = saved.pidFile;
      if (saved.claudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved.claudeConfigDir;
    },
  };
}

test('CodexProvider — install/uninstall round-trip is idempotent and non-clobbering', async (t) => {
  const env = setupInstallEnv(t);
  const configDir = path.join(env.tmp, '.codex');
  env.ctx.configDir = configDir;
  try {
    const hooksPath = path.join(configDir, 'hooks.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          SessionStart: [
            { matcher: '*', hooks: [{ type: 'command', command: 'echo preexisting' }] },
          ],
        },
      })
    );

    await CodexProvider.install(env.ctx);
    await CodexProvider.install(env.ctx);

    const afterInstall = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    const start = afterInstall.hooks.SessionStart;
    assert.strictEqual(start.length, 2, '1 pre-existing + 1 airprompt, no duplication');
    assert.ok(
      start.some((e) => JSON.stringify(e).includes('airprompt')),
      'airprompt SessionStart wired'
    );
    assert.ok(
      start.some((e) => JSON.stringify(e).includes('preexisting')),
      'pre-existing preserved'
    );
    assert.strictEqual(afterInstall.hooks.Stop.length, 1, 'airprompt Stop wired');

    await CodexProvider.uninstall(env.ctx);

    const afterUninstall = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.strictEqual(afterUninstall.hooks.SessionStart.length, 1, 'only pre-existing remains');
    assert.ok(JSON.stringify(afterUninstall.hooks.SessionStart[0]).includes('preexisting'));
    assert.strictEqual(afterUninstall.hooks.Stop, undefined, 'airprompt Stop removed');
  } finally {
    env.restore();
  }
});

test('CursorProvider — install/uninstall round-trip is idempotent and non-clobbering', async (t) => {
  const env = setupInstallEnv(t);
  const configDir = path.join(env.tmp, '.cursor');
  env.ctx.configDir = configDir;
  try {
    const hooksPath = path.join(configDir, 'hooks.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      hooksPath,
      JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: 'echo preexisting' }] } })
    );

    await CursorProvider.install(env.ctx);
    await CursorProvider.install(env.ctx);

    const afterInstall = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.strictEqual(afterInstall.hooks.sessionStart.length, 2, 'no duplication');
    assert.strictEqual(afterInstall.hooks.sessionEnd.length, 1, 'sessionEnd wired');

    await CursorProvider.uninstall(env.ctx);

    const afterUninstall = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.strictEqual(afterUninstall.hooks.sessionStart.length, 1, 'only pre-existing remains');
    assert.strictEqual(afterUninstall.hooks.sessionEnd, undefined, 'sessionEnd removed');
  } finally {
    env.restore();
  }
});

test('WindsurfProvider — install preserves existing object-form hook (non-clobber)', async (t) => {
  const env = setupInstallEnv(t);
  const configDir = path.join(env.tmp, '.codeium', 'windsurf');
  env.ctx.configDir = configDir;
  try {
    const hooksPath = path.join(configDir, 'hooks.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      hooksPath,
      JSON.stringify({ hooks: { 'on-open': { command: 'echo user-hook' } } })
    );

    await WindsurfProvider.install(env.ctx);
    await WindsurfProvider.install(env.ctx);

    const afterInstall = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    // Existing user on-open hook preserved (NOT clobbered); post_cascade_response added.
    assert.strictEqual(afterInstall.hooks['on-open'].command, 'echo user-hook');
    assert.ok(
      JSON.stringify(afterInstall.hooks.post_cascade_response).includes('airprompt'),
      'post_cascade_response wired'
    );

    await WindsurfProvider.uninstall(env.ctx);

    const afterUninstall = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.strictEqual(
      afterUninstall.hooks['on-open'].command,
      'echo user-hook',
      'user hook survives'
    );
    assert.strictEqual(
      afterUninstall.hooks.post_cascade_response,
      undefined,
      'airprompt hook removed'
    );
  } finally {
    env.restore();
  }
});

// ── ClaudeProvider — plugin record handling ─────────────────────────────────
// install() used to decide "plugin already installed" by grepping
// `claude plugin list` for the word airprompt, so a record whose cache dir was
// gone — the state /plugin reports as `Plugin "airprompt" not cached at <path>`
// — read as healthy and the repair never ran. A stub `claude` on PATH pins the
// decision end to end: a stale record must go through `plugin update`, a
// healthy one must spawn nothing at all.

// Writes a stub `claude` that answers `plugin list --json`. The first call
// reports `stalePath`; every call after that reports `freshPath`, which is what
// the post-repair probe reads. `listOnly` keeps it answering `freshPath`.
function writeFakeClaude(tmp, { stalePath, freshPath, listOnly }) {
  const binDir = path.join(tmp, 'fakebin');
  fs.mkdirSync(binDir, { recursive: true });
  const log = path.join(tmp, 'claude-calls.log');
  const seen = path.join(tmp, 'claude-seen');
  const script = `#!/usr/bin/env bash
echo "$@" >> ${JSON.stringify(log)}
if [ "$1" = plugin ] && [ "$2" = list ]; then
  if [ -f ${JSON.stringify(seen)} ]; then
    printf '[{"id":"airprompt@airprompt","installPath":%s}]' ${JSON.stringify(JSON.stringify(freshPath))}
  else
    : > ${JSON.stringify(seen)}
    printf '[{"id":"airprompt@airprompt","installPath":%s}]' ${JSON.stringify(JSON.stringify(listOnly ? freshPath : stalePath))}
  fi
fi
exit 0
`;
  const file = path.join(binDir, 'claude');
  fs.writeFileSync(file, script);
  fs.chmodSync(file, 0o755);
  return { binDir, log };
}

async function withFakeClaude(t, env, opts, fn) {
  const fake = writeFakeClaude(env.tmp, opts);
  const savedPath = process.env.PATH;
  process.env.PATH = `${fake.binDir}:${savedPath}`;
  fs.writeFileSync(path.join(env.targetDir, 'src', 'hooks', 'airprompt-statusline.sh'), '');
  fs.writeFileSync(path.join(env.targetDir, 'src', 'hooks', 'airprompt-session-tokens.js'), '');
  try {
    // The log only exists once the stub has been called, so hand `fn` a reader.
    return await fn(() => fs.readFileSync(fake.log, 'utf8'));
  } finally {
    process.env.PATH = savedPath;
    env.restore();
  }
}

test('ClaudeProvider — install() repairs a stale plugin record instead of reinstalling', async (t) => {
  const env = setupInstallEnv(t);
  env.ctx.configDir = path.join(env.tmp, '.claude');
  fs.mkdirSync(path.join(env.ctx.configDir, 'hooks'), { recursive: true });
  const fresh = path.join(env.tmp, 'cache');
  fs.mkdirSync(fresh, { recursive: true });

  await withFakeClaude(
    t,
    env,
    { stalePath: path.join(env.tmp, 'cache-gone'), freshPath: fresh },
    async (readLog) => {
      await ClaudeProvider.install(env.ctx);
      const log = readLog();

      assert.match(log, /plugin update airprompt@airprompt/, 'repairs via plugin update');
      assert.doesNotMatch(log, /plugin install/, 'does not reinstall over a stale record');
      assert.ok(
        env.ctx.results.installed.includes('claude-plugin-repair'),
        'repair reported as installed work'
      );
    }
  );
});

test('ClaudeProvider — install() leaves a healthy plugin record alone', async (t) => {
  const env = setupInstallEnv(t);
  env.ctx.configDir = path.join(env.tmp, '.claude');
  fs.mkdirSync(path.join(env.ctx.configDir, 'hooks'), { recursive: true });
  const fresh = path.join(env.tmp, 'cache');
  fs.mkdirSync(fresh, { recursive: true });

  await withFakeClaude(t, env, { freshPath: fresh, listOnly: true }, async (readLog) => {
    await ClaudeProvider.install(env.ctx);
    const log = readLog();

    assert.match(log, /plugin list --json/, 'probes the record');
    assert.doesNotMatch(log, /plugin (update|install|marketplace)/, 'spawns no mutation');
    assert.ok(
      env.ctx.results.skipped.some(([id]) => id === 'claude'),
      'reports the plugin as already installed'
    );
  });
});

test('ClaudeProvider — a checkout without the session-tokens helper still wires the hooks', async (t) => {
  const env = setupInstallEnv(t);
  env.ctx.configDir = path.join(env.tmp, '.claude');
  fs.mkdirSync(path.join(env.ctx.configDir, 'hooks'), { recursive: true });
  // The helper did not exist in older checkouts, and ensureCoreInstall does not
  // refresh an existing target. Reachable whenever the plugin install fails
  // (no `claude` CLI, offline, error): the standalone path, where installHooks()
  // runs. That loop returns on the first missing source *before* settings.json
  // is touched — so with the helper in HOOK_FILES this would leave SessionStart
  // and Stop unwired, silently.
  fs.writeFileSync(path.join(env.targetDir, 'src', 'hooks', 'airprompt-statusline.sh'), '');
  fs.rmSync(path.join(env.targetDir, 'src', 'hooks', 'airprompt-session-tokens.js'), {
    force: true,
  });

  const emptyBin = path.join(env.tmp, 'emptybin');
  fs.mkdirSync(emptyBin, { recursive: true });
  const savedPath = process.env.PATH;
  process.env.PATH = emptyBin; // no `claude` → the plugin install cannot succeed
  try {
    await ClaudeProvider.install(env.ctx);
  } finally {
    process.env.PATH = savedPath;
  }

  const settings = JSON.parse(
    fs.readFileSync(path.join(env.ctx.configDir, 'settings.json'), 'utf8')
  );
  assert.ok(JSON.stringify(settings).includes('airprompt-activate'), 'SessionStart still wired');
  assert.ok(
    env.ctx.results.failed.some(([id]) => id === 'claude-session-tokens'),
    'the missing helper is reported as a failure, not swallowed'
  );
  env.restore();
});

test('ClaudeProvider — install() copies the session-tokens helper even on the plugin path', async (t) => {
  const env = setupInstallEnv(t);
  env.ctx.configDir = path.join(env.tmp, '.claude');
  fs.mkdirSync(path.join(env.ctx.configDir, 'hooks'), { recursive: true });
  const fresh = path.join(env.tmp, 'cache');
  fs.mkdirSync(fresh, { recursive: true });

  // A healthy plugin record means the standalone hook wiring is skipped, so the
  // helper has to be copied by install() itself — the plugin manifest declares
  // event handlers, not the file a settings.json hook resolves by path.
  await withFakeClaude(t, env, { freshPath: fresh, listOnly: true }, async () => {
    await ClaudeProvider.install(env.ctx);

    const helper = path.join(env.ctx.configDir, 'hooks', 'airprompt-session-tokens.js');
    assert.ok(fs.existsSync(helper), 'session-tokens helper copied into hooksDir');

    await ClaudeProvider.uninstall(env.ctx);
    assert.ok(!fs.existsSync(helper), 'uninstall removes it again');
  });
});
