// test/unit/uploads.test.js — upload store: naming, manifest, release, sweep, tokens.
//
// The store owns the lifetime of files uploaded from the phone: an upload is
// pending until the device that sent it submits a prompt, then it is released
// with a grace deadline and finally reaped by the sweep (or the TTL, or its
// session's tmux going away). These tests pin that contract and the guards that
// keep a purge from ever touching a live session's files.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const uploads = require('../../src/uploads');
const { isSafeRmTarget } = require('../../src/utils');

// Env vars are read at call time by the store and provider.js — isolate each test.
function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

// A fresh uploads root per test. The name must contain "airprompt" so the
// recursive-delete guard accepts paths under it.
function withTempRoot(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airprompt-uploads-test-'));
  try {
    return withEnv({ AIRPROMPT_UPLOADS_DIR: dir }, () => fn(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const ENTRY = { sessionId: 's1', providerId: 'claude', tmuxSession: 'airprompt-proj' };
const DEVICE = 'device-key-a';
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function store(dir, opts) {
  opts = opts || {};
  return uploads.writeUpload({
    entry: opts.entry || ENTRY,
    name: opts.name || 'Screenshot_2026-10-08.png',
    mime: opts.mime || 'image/png',
    buffer: opts.buffer || PNG,
    device: opts.device || DEVICE,
    now: opts.now || 1_000_000,
  });
}

// ── Naming ────────────────────────────────────────────────────────────────

test('sanitizeName strips directories, traversal and the extension', () => {
  assert.strictEqual(uploads.sanitizeName('../../etc/passwd.png'), 'passwd');
  assert.strictEqual(uploads.sanitizeName('/tmp/a b*c.jpg'), 'a-b-c');
  assert.strictEqual(uploads.sanitizeName(''), 'upload');
  assert.strictEqual(uploads.sanitizeName('...'), 'upload');
  assert.strictEqual(uploads.sanitizeName('x'.repeat(500)).length, 80);
});

test('extensionFor accepts the image whitelist only', () => {
  assert.strictEqual(uploads.extensionFor('image/png'), '.png');
  assert.strictEqual(uploads.extensionFor('image/jpeg'), '.jpg');
  assert.strictEqual(uploads.extensionFor('image/webp'), '.webp');
  assert.strictEqual(uploads.extensionFor('image/gif'), '.gif');
  assert.strictEqual(uploads.extensionFor('text/html'), null);
  assert.strictEqual(uploads.extensionFor('image/svg+xml'), null);
});

test('sessionKeyFor keys on the validated sessionId, verbatim', () => {
  assert.strictEqual(uploads.sessionKeyFor(ENTRY), 'claude-s1');
  // The sessionId is charset-restricted at registration, so it is used as-is —
  // mangling it would collide distinct sessions (dots, underscores, dashes).
  assert.strictEqual(
    uploads.sessionKeyFor({ providerId: 'codex', sessionId: 'a-b_c.d' }),
    'codex-a-b_c.d'
  );
  assert.strictEqual(uploads.sessionKeyFor({ sessionId: 'no-provider' }), 'unknown-no-provider');
  assert.strictEqual(uploads.sessionKeyFor({ providerId: 'claude' }), '', 'no sessionId → no key');
  assert.strictEqual(uploads.sessionKeyFor(null), '');
});

// ── Writes ────────────────────────────────────────────────────────────────

test('writeUpload stores the file under the session dir and records it pending', () => {
  withTempRoot((root) => {
    const out = store(root);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(path.dirname(out.path), path.join(root, 'claude-s1'));
    assert.strictEqual(fs.readFileSync(out.path).length, PNG.length);
    assert.strictEqual(fs.statSync(out.path).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(path.dirname(out.path)).mode & 0o777, 0o700);

    const manifest = uploads.readManifest(path.dirname(out.path));
    assert.strictEqual(manifest.session.tmuxSession, 'airprompt-proj');
    assert.strictEqual(manifest.entries.length, 1);
    assert.strictEqual(manifest.entries[0].file, path.basename(out.path));
    assert.strictEqual(manifest.entries[0].device, DEVICE);
    assert.strictEqual(manifest.entries[0].deadline, null);
  });
});

test('writeUpload rejects unsupported types, empty and oversized bodies', () => {
  withTempRoot((root) => {
    assert.strictEqual(store(root, { mime: 'text/plain' }).status, 415);
    assert.strictEqual(store(root, { buffer: Buffer.alloc(0) }).status, 400);

    withEnv({ AIRPROMPT_UPLOAD_MAX_BYTES: '8' }, () => {
      assert.strictEqual(store(root, { buffer: Buffer.alloc(9) }).status, 413);
    });
    // Nothing was written by any rejected attempt.
    assert.strictEqual(fs.existsSync(path.join(root, 'claude-s1')), false);
  });
});

test('two uploads of the same name in the same millisecond do not collide', () => {
  withTempRoot((root) => {
    const a = store(root);
    const b = store(root);
    assert.notStrictEqual(a.path, b.path);
    assert.strictEqual(fs.existsSync(a.path), true);
    assert.strictEqual(fs.existsSync(b.path), true);
  });
});

test('writeUpload derives the extension from the MIME type, not the filename', () => {
  withTempRoot((root) => {
    const out = store(root, { name: 'evil.html', mime: 'image/png' });
    assert.strictEqual(path.extname(out.path), '.png');
  });
});

// ── Release ───────────────────────────────────────────────────────────────

test('releaseForDevice stamps only the submitting device and only once', () => {
  withTempRoot((root) => {
    const mine = store(root, { device: 'dev-a' });
    const theirs = store(root, { device: 'dev-b' });
    const dir = path.dirname(mine.path);

    assert.strictEqual(
      uploads.releaseForDevice(ENTRY, 'dev-a', { now: 5_000, graceMs: 600_000 }),
      1
    );
    let entries = uploads.readManifest(dir).entries;
    const byFile = Object.fromEntries(entries.map((e) => [e.file, e]));
    assert.strictEqual(byFile[path.basename(mine.path)].deadline, 605_000);
    assert.strictEqual(byFile[path.basename(theirs.path)].deadline, null);

    // Second submit from the same device releases nothing new.
    assert.strictEqual(
      uploads.releaseForDevice(ENTRY, 'dev-a', { now: 5_000, graceMs: 600_000 }),
      0
    );
  });
});

test('releaseForDevice is a no-op for an unknown session or device', () => {
  withTempRoot(() => {
    assert.strictEqual(uploads.releaseForDevice(ENTRY, 'nobody'), 0);
    assert.strictEqual(uploads.releaseForDevice({ providerId: 'claude' }, DEVICE), 0);
    assert.strictEqual(uploads.releaseForDevice(null, DEVICE), 0);
  });
});

// ── Sweep ─────────────────────────────────────────────────────────────────

const ALIVE = () => 'alive';

test('sweep keeps a pending file whose session is alive', () => {
  withTempRoot((root) => {
    const out = store(root);
    const res = uploads.sweepUploads({ now: 1_000_001, tmuxState: ALIVE });
    assert.deepStrictEqual(res, { removedFiles: 0, removedDirs: 0 });
    assert.strictEqual(fs.existsSync(out.path), true);
  });
});

test('sweep reaps a released file once its grace deadline passes', () => {
  withTempRoot((root) => {
    const out = store(root);
    uploads.releaseForDevice(ENTRY, DEVICE, { now: 1_000_000, graceMs: 600_000 });

    // Still inside the grace window — the CLI may read the image late.
    uploads.sweepUploads({ now: 1_500_000, tmuxState: ALIVE });
    assert.strictEqual(fs.existsSync(out.path), true);

    const res = uploads.sweepUploads({ now: 1_600_001, tmuxState: ALIVE });
    assert.strictEqual(res.removedFiles, 1);
    assert.strictEqual(fs.existsSync(out.path), false);
    // Nothing left to hold — the session dir goes with it.
    assert.strictEqual(res.removedDirs, 1);
    assert.strictEqual(fs.existsSync(path.join(root, 'claude-s1')), false);
  });
});

test('sweep reaps a never-released file by TTL', () => {
  withTempRoot((root) => {
    const out = store(root, { now: 1_000_000 });
    uploads.sweepUploads({ now: 1_000_000 + uploads.ttlMs() - 1, tmuxState: ALIVE });
    assert.strictEqual(fs.existsSync(out.path), true, 'inside the TTL');

    uploads.sweepUploads({ now: 1_000_000 + uploads.ttlMs() + 1, tmuxState: ALIVE });
    assert.strictEqual(fs.existsSync(out.path), false, 'past the TTL');
  });
});

// The empty-dir removal uses rmdir (it refuses a non-empty dir, so an upload
// landing in the same tick cannot be deleted with it) — which means anything
// else sitting in the dir would keep it alive forever. A stale manifest.json.tmp
// is the reachable case: writeManifest writes the tmp then renames.
test('sweep drops a dir holding only leftovers, and never a dir holding a file', () => {
  withTempRoot((root) => {
    const out = store(root);
    const dir = path.dirname(out.path);
    fs.writeFileSync(path.join(dir, 'manifest.json.tmp'), '{}');

    // The tracked file is still pending — the dir must survive, leftovers or not.
    uploads.sweepUploads({ now: 1_000_001, tmuxState: ALIVE });
    assert.strictEqual(fs.existsSync(dir), true);

    // Release it: now the only things left are leftovers, and the dir goes too.
    uploads.releaseForDevice(ENTRY, DEVICE, { now: 1_000_002, graceMs: 1 });
    const res = uploads.sweepUploads({ now: 1_000_004, tmuxState: ALIVE });
    assert.strictEqual(res.removedFiles, 1);
    assert.strictEqual(res.removedDirs, 1);
    assert.strictEqual(fs.existsSync(dir), false, 'a stale .tmp must not pin the dir');
  });
});

test('sweep keeps a dir that still holds an unlisted young file', () => {
  withTempRoot((root) => {
    const out = store(root);
    const dir = path.dirname(out.path);
    // Anything the sweep cannot account for must keep the dir alive, because the
    // removal is a non-recursive rmdir.
    fs.writeFileSync(path.join(dir, 'stray.png'), PNG);

    uploads.releaseForDevice(ENTRY, DEVICE, { now: 1_000_002, graceMs: 1 });
    uploads.sweepUploads({ now: 1_000_004, tmuxState: ALIVE });
    assert.strictEqual(fs.existsSync(out.path), false, 'the tracked file was reaped');
    assert.strictEqual(fs.existsSync(dir), true, 'the stray file pins the dir');
  });
});

test('sweep removes a session dir only when tmux is definitively gone', () => {
  for (const state of ['alive', 'unknown']) {
    withTempRoot((root) => {
      const out = store(root);
      const res = uploads.sweepUploads({ now: 1_000_001, tmuxState: () => state });
      assert.deepStrictEqual(res, { removedFiles: 0, removedDirs: 0 }, `${state} must keep files`);
      assert.strictEqual(fs.existsSync(out.path), true);
    });
  }

  withTempRoot((root) => {
    const out = store(root);
    const res = uploads.sweepUploads({ now: 1_000_001, tmuxState: () => 'dead' });
    assert.strictEqual(res.removedDirs, 1);
    assert.strictEqual(fs.existsSync(path.dirname(out.path)), false);
  });
});

test('sweep reaps an aged unlisted file and adopts a young one', () => {
  withTempRoot((root) => {
    const out = store(root);
    const dir = path.dirname(out.path);

    // Simulate a crash between the write and the manifest update: both files are
    // on disk, one of them aged, with no matching manifest entry.
    const orphan = path.join(dir, '9999999999999-abcd-orphan.png');
    fs.writeFileSync(orphan, PNG);
    uploads.writeManifest(dir, {
      session: { providerId: 'claude', sessionId: 's1', tmuxSession: 'airprompt-proj' },
      entries: [],
    });

    const ttl = uploads.ttlMs();
    const old = Date.now() - ttl - 1000;
    fs.utimesSync(orphan, old / 1000, old / 1000);

    const res = uploads.sweepUploads({ now: Date.now(), tmuxState: ALIVE });
    assert.strictEqual(res.removedFiles, 1);
    assert.strictEqual(fs.existsSync(orphan), false, 'aged unlisted file is reaped');
    assert.strictEqual(fs.existsSync(out.path), true, 'young unlisted file survives');

    // …and is adopted, so it ages out by TTL rather than being re-scanned forever.
    const manifest = uploads.readManifest(dir);
    assert.deepStrictEqual(
      manifest.entries.map((e) => e.file),
      [path.basename(out.path)]
    );
  });
});

test('sweep tolerates a missing uploads root', () => {
  withEnv({ AIRPROMPT_UPLOADS_DIR: path.join(os.tmpdir(), 'airprompt-does-not-exist') }, () => {
    assert.deepStrictEqual(uploads.sweepUploads({ tmuxState: ALIVE }), {
      removedFiles: 0,
      removedDirs: 0,
    });
  });
});

test('purgeSession removes the session dir, guarded', () => {
  withTempRoot((root) => {
    const out = store(root);
    assert.strictEqual(uploads.purgeSession(ENTRY), true);
    assert.strictEqual(fs.existsSync(path.dirname(out.path)), false);
    assert.strictEqual(uploads.purgeSession({ providerId: 'claude' }), false);
  });
});

// ── Guards ────────────────────────────────────────────────────────────────

test('the uploads root passes the recursive-delete guard', () => {
  withTempRoot((root) => {
    assert.strictEqual(isSafeRmTarget(path.join(root, 'claude-s1')), true);
    assert.strictEqual(isSafeRmTarget(root), true);
  });
});

test('a custom uploads root without "airprompt" in its path is refused', () => {
  withEnv({ AIRPROMPT_UPLOADS_DIR: path.join(os.tmpdir(), 'uploads-elsewhere') }, () => {
    assert.strictEqual(isSafeRmTarget(path.join(os.tmpdir(), 'uploads-elsewhere', 'x')), false);
  });
});

// ── Tokens ────────────────────────────────────────────────────────────────

test('a token is single-use and expires', () => {
  const token = uploads.mintToken('dev-a', 's1', 1_000);
  assert.strictEqual(typeof token, 'string');
  assert.deepStrictEqual(uploads.takeToken(token, 1_001), { device: 'dev-a', sessionId: 's1' });
  assert.strictEqual(uploads.takeToken(token, 1_001), null, 'second redemption must fail');

  const expiring = uploads.mintToken('dev-a', 's1', 1_000);
  assert.strictEqual(uploads.takeToken(expiring, 1_000 + uploads.tokenTtlMs() + 1), null);
});

test('tokens are rejected when empty, unknown, or the device cap is reached', () => {
  assert.strictEqual(uploads.takeToken('', 1), null);
  assert.strictEqual(uploads.takeToken(undefined, 1), null);
  assert.strictEqual(uploads.takeToken('not-a-token', 1), null);

  const minted = [];
  for (let i = 0; i < 32; i++) minted.push(uploads.mintToken('dev-cap', 's1', 1_000));
  assert.ok(minted.includes(null), 'a single device must not mint unbounded tokens');
  assert.ok(minted.filter(Boolean).length <= 8);
});

test('dropTokensForDevice invalidates only that device', () => {
  const a = uploads.mintToken('dev-x', 's1', 1_000);
  const b = uploads.mintToken('dev-y', 's1', 1_000);
  assert.strictEqual(uploads.dropTokensForDevice('dev-x'), 1);
  assert.strictEqual(uploads.takeToken(a, 1_001), null);
  assert.deepStrictEqual(uploads.takeToken(b, 1_001), { device: 'dev-y', sessionId: 's1' });
});
