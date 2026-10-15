// test/unit/claude-plugin.test.js — Claude Code plugin record handling.
//
// Regression cover for the stale-record bug: `installed_plugins.json` pinned an
// installPath whose cache dir no longer existed, so /plugin reported
// `Plugin "airprompt" not cached at <path>` while the installer's old
// "does `plugin list` mention airprompt?" check called it healthy and skipped
// the repair. The probe now reads the recorded path and the install goes
// through `install <name> --marketplace <owner>/<repo>`, which survives the
// marketplace being named after a repo slug that has since moved.
//
// Pure unit tests: spawn helpers and existsSync are injected, no CLI runs.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const P = require('../../src/providers/claude-plugin');

function listOutput(entries) {
  return JSON.stringify(entries);
}

// ── parseList / findRecord ──────────────────────────────────────────────────

test('parseList tolerates garbage and non-array output', () => {
  assert.deepStrictEqual(P.parseList('not json'), []);
  assert.deepStrictEqual(P.parseList('{"plugins":[]}'), []);
  assert.deepStrictEqual(P.parseList(''), []);
  assert.deepStrictEqual(P.parseList('[]'), []);
});

test('findRecord matches the plugin on any marketplace name', () => {
  const records = [
    { id: 'caveman@caveman', installPath: '/x' },
    { id: 'airprompt@airprompt', installPath: '/y' },
  ];
  assert.strictEqual(P.findRecord(records).id, 'airprompt@airprompt');
});

test('findRecord ignores plugins whose name merely contains airprompt', () => {
  const records = [{ id: 'notairprompt@x', installPath: '/x' }];
  assert.strictEqual(P.findRecord(records), null);
  assert.strictEqual(P.findRecord(null), null);
});

// ── recordHealth ────────────────────────────────────────────────────────────

test('recordHealth reports ok only when the recorded dir exists', () => {
  const record = { id: 'airprompt@m', installPath: '/cache/abc' };
  assert.strictEqual(
    P.recordHealth(record, () => true),
    'ok'
  );
  assert.strictEqual(
    P.recordHealth(record, () => false),
    'missing-dir'
  );
});

test('recordHealth treats a record with no path as missing-dir', () => {
  assert.strictEqual(
    P.recordHealth({ id: 'airprompt@m' }, () => true),
    'missing-dir'
  );
  assert.strictEqual(
    P.recordHealth({ id: 'airprompt@m', installPath: '' }, () => true),
    'missing-dir'
  );
});

test('recordHealth reports not-installed when no record exists', () => {
  assert.strictEqual(
    P.recordHealth(null, () => true),
    'not-installed'
  );
});

// ── planPluginAction ────────────────────────────────────────────────────────

test('planPluginAction skips a healthy or unverifiable record', () => {
  assert.strictEqual(P.planPluginAction({ id: 'airprompt@m' }, 'ok', false), 'skip');
  assert.strictEqual(P.planPluginAction(null, 'unknown', false), 'skip');
});

test('planPluginAction repairs a stale record and installs a missing one', () => {
  assert.strictEqual(P.planPluginAction({ id: 'airprompt@m' }, 'missing-dir', false), 'repair');
  assert.strictEqual(P.planPluginAction(null, 'not-installed', false), 'install');
});

test('planPluginAction refetches on --force instead of claiming a reinstall', () => {
  // `plugin install` on an installed plugin exits 0 as a no-op, so a forced
  // run has to go through `plugin update` to actually re-check out.
  assert.strictEqual(P.planPluginAction({ id: 'airprompt@m' }, 'ok', true), 'repair');
  assert.strictEqual(P.planPluginAction(null, 'unknown', true), 'install');
});

// ── probePlugin targets the resolved config ─────────────────────────────────

test('probePlugin forwards the resolved env to the CLI', () => {
  const H = fakeHelpers({ 'plugin list --json': { status: 0, stdout: '[]' } });
  const env = { CLAUDE_CONFIG_DIR: '/tmp/airprompt-other-config' };
  P.probePlugin(H, env);
  assert.deepStrictEqual(H.lastOpts, { env });
});

// ── command builders ────────────────────────────────────────────────────────

test('installArgs resolves the plugin by name + marketplace source', () => {
  assert.deepStrictEqual(P.installArgs('farox-coop/airprompt'), [
    'plugin',
    'install',
    'airprompt',
    '--marketplace',
    'farox-coop/airprompt',
  ]);
});

test('legacyId matches the marketplace name the CLI derives from the repo', () => {
  assert.strictEqual(P.legacyId(), 'airprompt@airprompt');
  assert.deepStrictEqual(P.legacyInstallArgs(), ['plugin', 'install', P.legacyId()]);
});

test('repairArgs uses the recorded id, not a rebuilt one', () => {
  assert.deepStrictEqual(P.repairArgs('airprompt@airprompt'), [
    'plugin',
    'update',
    'airprompt@airprompt',
  ]);
});

// ── probePlugin ─────────────────────────────────────────────────────────────

function fakeHelpers(responses) {
  return {
    captured: [],
    lastOpts: null,
    captureSpawn(cmd, args, opts) {
      this.captured.push(args.join(' '));
      this.lastOpts = opts;
      const key = args.join(' ');
      return responses[key] || { status: 1, stdout: '' };
    },
    runSpawn(cmd, args) {
      this.captured.push(args.join(' '));
      const key = args.join(' ');
      return responses[key] || { status: 1 };
    },
    spawnOk: (r) => !!r && r.status === 0,
  };
}

test('probePlugin reads the recorded path from plugin list --json', () => {
  const H = fakeHelpers({
    'plugin list --json': {
      status: 0,
      stdout: listOutput([{ id: 'airprompt@airprompt', installPath: __dirname }]),
    },
  });
  const { record, health } = P.probePlugin(H);
  assert.strictEqual(record.id, 'airprompt@airprompt');
  assert.strictEqual(health, 'ok');
});

test('probePlugin flags a record whose cache dir is gone', () => {
  const H = fakeHelpers({
    'plugin list --json': {
      status: 0,
      stdout: listOutput([
        { id: 'airprompt@airprompt', installPath: '/nonexistent/airprompt-cache-xyz' },
      ]),
    },
  });
  assert.strictEqual(P.probePlugin(H).health, 'missing-dir');
});

test('probePlugin falls back to a text probe on CLIs without --json', () => {
  const H = fakeHelpers({
    'plugin list': { status: 0, stdout: 'airprompt@airprompt\n  Status: enabled' },
  });
  const { record, health } = P.probePlugin(H);
  assert.strictEqual(record, null);
  assert.strictEqual(health, 'unknown');
});

test('probePlugin reports not-installed when the CLI has no airprompt entry', () => {
  const H = fakeHelpers({
    'plugin list --json': { status: 0, stdout: '[]' },
  });
  assert.strictEqual(P.probePlugin(H).health, 'not-installed');
});

test('probePlugin reports not-installed when the claude CLI is absent', () => {
  const H = fakeHelpers({});
  assert.strictEqual(P.probePlugin(H).health, 'not-installed');
});

// ── installPlugin / repairPlugin ────────────────────────────────────────────

test('installPlugin prefers --marketplace and falls back to the legacy id', () => {
  const H = fakeHelpers({
    'plugin marketplace add farox-coop/airprompt': { status: 0 },
    'plugin install airprompt --marketplace farox-coop/airprompt': { status: 1 },
    'plugin install airprompt@airprompt': { status: 0 },
  });
  const r = P.installPlugin(H, 'farox-coop/airprompt', {}, false);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.args, ['plugin', 'install', 'airprompt@airprompt']);
  assert.ok(
    H.captured.includes('plugin install airprompt --marketplace farox-coop/airprompt'),
    'tried the name-based install first'
  );
});

test('installPlugin reports failure when every install form fails', () => {
  const H = fakeHelpers({});
  assert.strictEqual(P.installPlugin(H, 'farox-coop/airprompt', {}, false).ok, false);
});

test('repairPlugin verifies the record is healthy afterwards', () => {
  const H = fakeHelpers({
    'plugin update airprompt@airprompt': { status: 0 },
    'plugin list --json': {
      status: 0,
      stdout: listOutput([{ id: 'airprompt@airprompt', installPath: __dirname }]),
    },
  });
  const r = P.repairPlugin(H, 'airprompt@airprompt', {}, false);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.health, 'ok');
});

test('repairPlugin reports failure when the record stays stale', () => {
  const H = fakeHelpers({
    'plugin update airprompt@airprompt': { status: 0 },
    'plugin list --json': {
      status: 0,
      stdout: listOutput([
        { id: 'airprompt@airprompt', installPath: '/nonexistent/airprompt-cache-xyz' },
      ]),
    },
  });
  const r = P.repairPlugin(H, 'airprompt@airprompt', {}, false);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.health, 'missing-dir');
});
