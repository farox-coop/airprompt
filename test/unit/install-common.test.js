// test/unit/install-common.test.js — install-common.js shared helper tests.
//
// Covers the highest-value untested surface: readJson (JSONC + null sentinel),
// removeAirPromptHooks (array-form AND object-form), writeJson, copyManifestFiles,
// hasAirPromptEntry, and hookCommand. Pure unit tests over temp dirs.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  readJson,
  writeJson,
  removeAirPromptHooks,
  hasAirPromptEntry,
  hookCommand,
  copyManifestFiles,
} = require('../../src/providers/install-common');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'airprompt-install-common-'));
}

// ── readJson ──────────────────────────────────────────────────────────────

test('readJson — missing file → {}', () => {
  const d = tmpdir();
  assert.deepStrictEqual(readJson(path.join(d, 'nope.json')), {});
});

test('readJson — empty file → {}', () => {
  const d = tmpdir();
  const f = path.join(d, 'empty.json');
  fs.writeFileSync(f, '');
  assert.deepStrictEqual(readJson(f), {});
});

test('readJson — valid object', () => {
  const d = tmpdir();
  const f = path.join(d, 'ok.json');
  fs.writeFileSync(f, '{"a":1}');
  assert.deepStrictEqual(readJson(f), { a: 1 });
});

test('readJson — JSONC comments tolerated (//)', () => {
  const d = tmpdir();
  const f = path.join(d, 'jsonc.json');
  fs.writeFileSync(f, '{ // comment\n "a": 1\n}');
  assert.deepStrictEqual(readJson(f), { a: 1 });
});

test('readJson — malformed → null', () => {
  const d = tmpdir();
  const f = path.join(d, 'bad.json');
  fs.writeFileSync(f, '{bad');
  assert.strictEqual(readJson(f), null);
});

test('readJson — top-level array → null', () => {
  const d = tmpdir();
  const f = path.join(d, 'arr.json');
  fs.writeFileSync(f, '[1,2,3]');
  assert.strictEqual(readJson(f), null);
});

test('readJson — JSONC block comment + trailing comma', () => {
  const d = tmpdir();
  const f = path.join(d, 'jsonc2.json');
  fs.writeFileSync(f, '{ /* c */ "a": 1, }');
  assert.deepStrictEqual(readJson(f), { a: 1 });
});

test('readJson — top-level scalar → null', () => {
  const d = tmpdir();
  const f = path.join(d, 'scalar.json');
  fs.writeFileSync(f, '42');
  assert.strictEqual(readJson(f), null);
});

// ── writeJson ─────────────────────────────────────────────────────────────

test('writeJson — creates parent dirs and round-trips', () => {
  const d = tmpdir();
  const f = path.join(d, 'sub', 'dir', 'hooks.json');
  writeJson(f, { a: 1 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { a: 1 });
});

// ── hasAirPromptEntry ─────────────────────────────────────────────────────

test('hasAirPromptEntry — detects airprompt, ignores others', () => {
  assert.strictEqual(hasAirPromptEntry([{ command: 'node airprompt-activate.js' }]), true);
  assert.strictEqual(hasAirPromptEntry([{ command: 'echo other' }]), false);
  assert.strictEqual(hasAirPromptEntry([]), false);
  assert.strictEqual(hasAirPromptEntry(undefined), false);
});

// ── removeAirPromptHooks — array form (codex/cursor) ──────────────────────

test('removeAirPromptHooks — array-form removes airprompt, preserves unrelated', () => {
  const d = tmpdir();
  const f = path.join(d, 'hooks.json');
  fs.writeFileSync(
    f,
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [{ type: 'command', command: 'node airprompt-activate.js codex' }],
          },
          { hooks: [{ type: 'command', command: 'echo other' }] },
        ],
        Stop: [{ hooks: [{ type: 'command', command: 'node airprompt-deactivate.js codex' }] }],
      },
    })
  );
  const removed = removeAirPromptHooks(f);
  assert.strictEqual(removed, 2);
  const after = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(after.hooks.SessionStart.length, 1); // only 'echo other'
  assert.strictEqual(after.hooks.Stop, undefined); // emptied event key removed
});

// ── removeAirPromptHooks — object form (windsurf) ─────────────────────────

test('removeAirPromptHooks — object-form (windsurf) removed', () => {
  const d = tmpdir();
  const f = path.join(d, 'hooks.json');
  fs.writeFileSync(
    f,
    JSON.stringify({
      hooks: {
        'on-open': { command: 'node airprompt-activate.js windsurf' },
        post_cascade_response: { command: 'node airprompt-activate.js windsurf' },
      },
    })
  );
  const removed = removeAirPromptHooks(f);
  assert.strictEqual(removed, 2);
  const after = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepStrictEqual(after, {});
});

// ── removeAirPromptHooks — safety edge cases ──────────────────────────────

test('removeAirPromptHooks — missing file does not create a stray file', () => {
  const d = tmpdir();
  const f = path.join(d, 'missing.json');
  assert.strictEqual(removeAirPromptHooks(f), 0);
  assert.strictEqual(fs.existsSync(f), false);
});

test('removeAirPromptHooks — corrupt file untouched', () => {
  const d = tmpdir();
  const f = path.join(d, 'hooks.json');
  fs.writeFileSync(f, '{not json');
  assert.strictEqual(removeAirPromptHooks(f), 0);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), '{not json');
});

// ── hookCommand ───────────────────────────────────────────────────────────

test('hookCommand — builds shell-safe absolute command', () => {
  const script = path.join('/repo', 'src', 'hooks', 'airprompt-activate.js');
  const expected = `"${process.execPath}" "${script}" codex`;
  assert.strictEqual(hookCommand('/repo', 'codex', 'airprompt-activate.js'), expected);
});

// ── copyManifestFiles ─────────────────────────────────────────────────────

test('copyManifestFiles — copies files, honors dry-run', () => {
  const d = tmpdir();
  const src = path.join(d, 'SKILL.md');
  const dest = path.join(d, 'out', 'SKILL.md');
  fs.writeFileSync(src, '# hi');
  copyManifestFiles({ note: () => {}, opts: { dryRun: true } }, [{ src, dest }]);
  assert.strictEqual(fs.existsSync(dest), false);
  copyManifestFiles({ note: () => {}, opts: { dryRun: false } }, [{ src, dest }]);
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), '# hi');
});

test('copyManifestFiles — missing source skipped (non-fatal)', () => {
  const d = tmpdir();
  const ctx = { note: () => {}, opts: { dryRun: false } };
  copyManifestFiles(ctx, [{ src: path.join(d, 'nope.md'), dest: path.join(d, 'out', 'x.md') }]);
  assert.strictEqual(fs.existsSync(path.join(d, 'out', 'x.md')), false);
});
