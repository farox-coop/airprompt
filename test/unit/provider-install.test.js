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
  };
  process.env.AIRPROMPT_STATE_DIR = stateDir;
  delete process.env.AIRPROMPT_INSTALL_DIR;
  delete process.env.CODEX_HOME;
  delete process.env.XDG_CONFIG_HOME;

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
