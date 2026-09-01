// test/unit/resolve-provider.test.js — provider-bridge smoke test.
//
// The dispatcher's _ensure_provider shells out to bin/lib/resolve-provider.js.
// This exercises it with a controlled env: HOME pointing at a temp dir (so
// `dir:$HOME/.codex` matches) and a minimal PATH (so `command:claude`/`codex`
// cannot match) — proving dir-based GUI detection works end-to-end.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SCRIPT = path.join(__dirname, '..', '..', 'bin', 'lib', 'resolve-provider.js');

function run(extraEnv) {
  const env = { ...process.env, ...extraEnv };
  // Scrub provider-specific env vars so detection can't escape the controlled HOME.
  delete env.CODEX_HOME;
  delete env.CODEIUM_EDITOR_APP_ROOT;
  return spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
}

test('resolve-provider.js — detects codex via dir when no CLI binary is present', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airprompt-provider-'));
  fs.mkdirSync(path.join(tmp, '.codex'), { recursive: true });
  const r = run({ HOME: tmp, PATH: '/usr/bin:/bin' });
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  assert.strictEqual(r.stdout.trim(), 'codex');
});

test('resolve-provider.js — exits 1 when no provider detected', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airprompt-provider-'));
  const r = run({ HOME: tmp, PATH: '/usr/bin:/bin' });
  assert.strictEqual(r.status, 1);
  assert.ok(r.stderr.includes('no provider detected'), `stderr: ${r.stderr}`);
});
