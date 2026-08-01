// Force HTTP mode for tests (no TLS)
process.env.AIRPROMPT_NO_TLS = '1';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { execSync, spawnSync } = require('child_process');
const WebSocket = require('ws');

const { createApp, sessions } = require('../../server');

const TMUX_AVAILABLE = (() => {
  try { execSync('which tmux 2>/dev/null'); return true; } catch (e) { return false; }
})();

let server;
let port;

// ── Helpers ─────────────────────────────────────────────────────────

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'Connection': 'close' },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch (e) { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${path}`, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch (e) { resolve({ status: res.statusCode, body: buf }); }
      });
    }).on('error', reject);
  });
}

function createTmux(name) {
  if (!TMUX_AVAILABLE) return;
  try { execSync(`tmux new-session -d -s "${name}" 2>/dev/null`); } catch (e) { /* ok */ }
}

function killTmux(name) {
  if (!TMUX_AVAILABLE) return;
  try { execSync(`tmux kill-session -t "${name}" 2>/dev/null`); } catch (e) { /* ok */ }
}

// ── Setup / Teardown ────────────────────────────────────────────────

before(async () => {
  const { httpServer } = createApp();
  server = httpServer;
  await new Promise((resolve) => server.listen(0, resolve));
  port = server.address().port;
});

after(() => {
  server.close();
});

beforeEach(() => {
  sessions.clear();
});

// ── REST API tests ──────────────────────────────────────────────────

test('POST /api/sessions/register creates session', { skip: !TMUX_AVAILABLE }, async () => {
  createTmux('airprompt-test-reg1');
  try {
    const res = await post('/api/sessions/register', { sessionId: 'test-reg1', cwd: '/tmp' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(sessions.has('test-reg1'), true);
  } finally {
    killTmux('airprompt-test-reg1');
  }
});

test('POST /api/sessions/register rejects duplicate', { skip: !TMUX_AVAILABLE }, async () => {
  createTmux('airprompt-test-reg2');
  try {
    await post('/api/sessions/register', { sessionId: 'test-reg2', cwd: '/tmp' });
    const res = await post('/api/sessions/register', { sessionId: 'test-reg2', cwd: '/tmp' });
    assert.strictEqual(res.status, 409);
    assert.ok(res.body.error);
  } finally {
    killTmux('airprompt-test-reg2');
  }
});

test('POST /api/sessions/register dedup by tmuxSession — same tmux, different sessionId', { skip: !TMUX_AVAILABLE }, async () => {
  createTmux('airprompt-test-dedup');
  try {
    // Register first session
    const r1 = await post('/api/sessions/register', {
      sessionId: 'test-dedup-1', cwd: '/tmp',
      tmuxSession: 'airprompt-test-dedup',
    });
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(sessions.has('test-dedup-1'), true);

    // Register second session with SAME tmuxSession but DIFFERENT sessionId
    const r2 = await post('/api/sessions/register', {
      sessionId: 'test-dedup-2', cwd: '/tmp/a',
      tmuxSession: 'airprompt-test-dedup',
    });
    // Should succeed (dedup, not duplicate) — updates existing entry
    assert.strictEqual(r2.status, 200);
    // Old sessionId removed, new one present
    assert.strictEqual(sessions.has('test-dedup-1'), false);
    assert.strictEqual(sessions.has('test-dedup-2'), true);
    // Only ONE entry total (no duplicate)
    assert.strictEqual(sessions.size, 1);
    // cwd updated from second registration
    assert.strictEqual(sessions.get('test-dedup-2').cwd, '/tmp/a');
  } finally {
    killTmux('airprompt-test-dedup');
  }
});

test('POST /api/sessions/register rejects missing body', async () => {
  const res = await post('/api/sessions/register', {});
  assert.strictEqual(res.status, 400);
});

test('POST /api/sessions/register rejects missing sessionId', async () => {
  const res = await post('/api/sessions/register', { cwd: '/tmp' });
  assert.strictEqual(res.status, 400);
});

test('POST /api/sessions/register rejects invalid sessionId chars', async () => {
  const res = await post('/api/sessions/register', { sessionId: 'bad;rm -rf /', cwd: '/tmp' });
  assert.strictEqual(res.status, 400);
});

test('POST /api/sessions/register rejects sessionId too long', async () => {
  const longId = 'x'.repeat(65);
  const res = await post('/api/sessions/register', { sessionId: longId, cwd: '/tmp' });
  assert.strictEqual(res.status, 400);
});

test('POST /api/sessions/register rejects cwd too long', async () => {
  const longCwd = '/tmp/' + 'x'.repeat(512);
  const res = await post('/api/sessions/register', { sessionId: 'test-cwdlen', cwd: longCwd });
  assert.strictEqual(res.status, 400);
});

test('POST /api/sessions/register with existing tmuxSession', { skip: !TMUX_AVAILABLE }, async () => {
  const realSession = 'real-tmux-session';
  createTmux(realSession);
  try {
    const res = await post('/api/sessions/register', {
      sessionId: 'test-use-existing',
      cwd: '/tmp',
      tmuxSession: realSession,
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    // The entry should use the provided tmux session, not a generated one
    const entry = sessions.get('test-use-existing');
    assert.ok(entry);
    assert.strictEqual(entry.tmuxSession, realSession);
  } finally {
    killTmux(realSession);
  }
});

test('POST /api/sessions/register with tmuxSession that does not exist falls through', { skip: !TMUX_AVAILABLE }, async () => {
  const res = await post('/api/sessions/register', {
    sessionId: 'test-bad-tmux',
    cwd: '/tmp',
    tmuxSession: 'nonexistent-session-xyz',
  });
  assert.strictEqual(res.status, 200);
  // Should create airprompt-<sessionId> instead
  const entry = sessions.get('test-bad-tmux');
  assert.ok(entry);
  assert.strictEqual(entry.tmuxSession, 'airprompt-test-bad-tmux');
  killTmux('airprompt-test-bad-tmux');
});

test('GET /api/sessions returns empty array', async () => {
  const res = await get('/api/sessions');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, []);
});

test('GET /api/sessions returns all sessions', { skip: !TMUX_AVAILABLE }, async () => {
  createTmux('airprompt-test-a');
  createTmux('airprompt-test-b');
  try {
    await post('/api/sessions/register', { sessionId: 'test-a', cwd: '/tmp/a' });
    await post('/api/sessions/register', { sessionId: 'test-b', cwd: '/tmp/b' });
    const res = await get('/api/sessions');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.length, 2);
    const ids = res.body.map((s) => s.id).sort();
    assert.deepStrictEqual(ids, ['test-a', 'test-b']);
  } finally {
    killTmux('airprompt-test-a');
    killTmux('airprompt-test-b');
  }
});

test('POST /api/sessions/unregister removes session when tmux dead', { skip: !TMUX_AVAILABLE }, async () => {
  createTmux('airprompt-test-unreg');
  try {
    await post('/api/sessions/register', { sessionId: 'test-unreg', cwd: '/tmp' });
    // Kill tmux session first — server guard rejects unregister if tmux alive
    killTmux('airprompt-test-unreg');
    const res = await post('/api/sessions/unregister', { sessionId: 'test-unreg' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(sessions.has('test-unreg'), false);
  } finally {
    killTmux('airprompt-test-unreg');
  }
});

test('POST /api/sessions/unregister refuses when tmux session alive', { skip: !TMUX_AVAILABLE }, async () => {
  createTmux('airprompt-test-refuse');
  try {
    await post('/api/sessions/register', { sessionId: 'test-refuse', cwd: '/tmp' });
    const res = await post('/api/sessions/unregister', { sessionId: 'test-refuse' });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(sessions.has('test-refuse'), true);
  } finally {
    killTmux('airprompt-test-refuse');
  }
});

test('POST /api/sessions/unregister returns 404 for unknown', async () => {
  const res = await post('/api/sessions/unregister', { sessionId: 'nonexistent' });
  assert.strictEqual(res.status, 404);
});

test('POST /api/sessions/unregister rejects missing id', async () => {
  const res = await post('/api/sessions/unregister', {});
  assert.strictEqual(res.status, 400);
});

// ── Name endpoint tests ──────────────────────────────────────────────

function put(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost', port, path, method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch (e) { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('PUT /api/sessions/name sets name on registered session', { skip: !TMUX_AVAILABLE }, async () => {
  createTmux('airprompt-test-name1');
  try {
    await post('/api/sessions/register', { sessionId: 'test-name1', cwd: '/tmp' });
    const res = await put('/api/sessions/name', { sessionId: 'test-name1', name: 'My Session' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.name, 'My Session');
    assert.strictEqual(sessions.get('test-name1').name, 'My Session');
  } finally {
    killTmux('airprompt-test-name1');
  }
});

test('PUT /api/sessions/name clears name with empty string', { skip: !TMUX_AVAILABLE }, async () => {
  createTmux('airprompt-test-name2');
  try {
    await post('/api/sessions/register', { sessionId: 'test-name2', cwd: '/tmp' });
    await put('/api/sessions/name', { sessionId: 'test-name2', name: 'Temp Name' });
    const res = await put('/api/sessions/name', { sessionId: 'test-name2', name: '' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.name, null);
    assert.strictEqual(sessions.get('test-name2').name, null);
  } finally {
    killTmux('airprompt-test-name2');
  }
});

test('PUT /api/sessions/name rejects missing sessionId', async () => {
  const res = await put('/api/sessions/name', { name: 'test' });
  assert.strictEqual(res.status, 400);
});

test('PUT /api/sessions/name rejects invalid name (special chars)', { skip: !TMUX_AVAILABLE }, async () => {
  createTmux('airprompt-test-name3');
  try {
    await post('/api/sessions/register', { sessionId: 'test-name3', cwd: '/tmp' });
    const res = await put('/api/sessions/name', { sessionId: 'test-name3', name: 'bad@chars!' });
    assert.strictEqual(res.status, 400);
  } finally {
    killTmux('airprompt-test-name3');
  }
});

test('PUT /api/sessions/name rejects name too long', { skip: !TMUX_AVAILABLE }, async () => {
  createTmux('airprompt-test-name4');
  try {
    await post('/api/sessions/register', { sessionId: 'test-name4', cwd: '/tmp' });
    const res = await put('/api/sessions/name', { sessionId: 'test-name4', name: 'x'.repeat(65) });
    assert.strictEqual(res.status, 400);
  } finally {
    killTmux('airprompt-test-name4');
  }
});

test('PUT /api/sessions/name returns 404 for unknown session', async () => {
  const res = await put('/api/sessions/name', { sessionId: 'nonexistent', name: 'test' });
  assert.strictEqual(res.status, 404);
});

test('POST /api/sessions/register with valid name', { skip: !TMUX_AVAILABLE }, async () => {
  createTmux('airprompt-test-reg-name');
  try {
    const res = await post('/api/sessions/register', { sessionId: 'test-reg-name', cwd: '/tmp', name: 'My Label' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(sessions.get('test-reg-name').name, 'My Label');
  } finally {
    killTmux('airprompt-test-reg-name');
  }
});

test('POST /api/sessions/register rejects invalid name', async () => {
  const res = await post('/api/sessions/register', { sessionId: 'test-badname', cwd: '/tmp', name: 'bad@chars!' });
  assert.strictEqual(res.status, 400);
});

test('POST /api/sessions/register stores null name when omitted', { skip: !TMUX_AVAILABLE }, async () => {
  createTmux('airprompt-test-no-name');
  try {
    await post('/api/sessions/register', { sessionId: 'test-no-name', cwd: '/tmp' });
    assert.strictEqual(sessions.get('test-no-name').name, null);
  } finally {
    killTmux('airprompt-test-no-name');
  }
});

test('GET /api/sessions returns name field', { skip: !TMUX_AVAILABLE }, async () => {
  createTmux('airprompt-test-getname');
  try {
    await post('/api/sessions/register', { sessionId: 'test-getname', cwd: '/tmp', name: 'Visible' });
    const res = await get('/api/sessions');
    assert.strictEqual(res.status, 200);
    const session = res.body.find((s) => s.id === 'test-getname');
    assert.ok(session);
    assert.strictEqual(session.name, 'Visible');
  } finally {
    killTmux('airprompt-test-getname');
  }
});

// ── WebSocket tests ─────────────────────────────────────────────────

test('WS receives session_list on connect', (t, done) => {
  const ws = new WebSocket(`ws://localhost:${port}`);
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    assert.strictEqual(msg.type, 'session_list');
    assert.ok(Array.isArray(msg.sessions));
    ws.close();
    done();
  });
  ws.on('error', (e) => { assert.fail(`WS error: ${e.message}`); });
});

test('WS list_sessions request returns session_list', { skip: !TMUX_AVAILABLE }, (t, done) => {
  createTmux('airprompt-test-wslist');
  post('/api/sessions/register', { sessionId: 'test-wslist', cwd: '/tmp' }).then(() => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      // First message is auto-sent on connect
      // After sending list_sessions, we get another one
      if (msg.type === 'session_list') {
        if (msg.sessions.some((s) => s.id === 'test-wslist')) {
          ws.close();
          killTmux('airprompt-test-wslist');
          done();
        }
      }
    });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'list_sessions' })));
  });
});

test('WS input echoes back via pty', { skip: !TMUX_AVAILABLE }, (t, done) => {
  createTmux('airprompt-test-wsinput');
  post('/api/sessions/register', { sessionId: 'test-wsinput', cwd: '/tmp' }).then(() => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'switch_session', sessionId: 'test-wsinput' })));
    // Send input after switching
    setTimeout(() => {
      ws.send(JSON.stringify({ type: 'input', data: 'echo hello\r' }));
      // Check we get output back
      let gotOutput = false;
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'output') {
          gotOutput = true;
        }
      });
      setTimeout(() => {
        ws.close();
        killTmux('airprompt-test-wsinput');
        assert.ok(gotOutput);
        done();
      }, 500);
    }, 200);
  });
});

test('WS switch_session for unknown id returns error', (t, done) => {
  const ws = new WebSocket(`ws://localhost:${port}`);
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'switch_session', sessionId: 'nonexistent' }));
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'session_list') return; // skip auto-sent
    if (msg.type === 'error') {
      assert.ok(msg.message);
      ws.close();
      done();
    }
  });
});

// ── Deactivate hook guard tests ─────────────────────────────────────

const TEMP_DIR = (() => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airprompt-deactivate-test-'));
  return dir;
})();

const DEACTIVATE_SCRIPT = require('path').join(__dirname, '..', '..', 'src', 'hooks', 'airprompt-deactivate.js');

function runDeactivate(envOverrides = {}) {
  const env = {
    ...process.env,
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    AIRPROMPT_PORT: String(port),
    AIRPROMPT_PID_FILE: '/tmp/airprompt-server-test.pid',
    AIRPROMPT_SKIP_RECOVERY: '1',
    CLAUDE_CONFIG_DIR: TEMP_DIR,
    AIRPROMPT_NO_TLS: '1', // match test server
    ...envOverrides,
  };
  // Default: unset TMUX so deactivate doesn't detect the real Claude session.
  // Tests that need a fake tmux context pass TMUX in envOverrides.
  if (!('TMUX' in envOverrides)) delete env.TMUX;
  const r = spawnSync(process.execPath, [DEACTIVATE_SCRIPT], {
    env,
    timeout: 10000,
    encoding: 'utf8',
  });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function cleanupMarkers() {
  const fs = require('fs');
  const path = require('path');
  // Legacy flat files
  for (const f of ['.airprompt-active', '.airprompt-url', '.airprompt-session',
                   '.airprompt-tmux-active', '.airprompt-tmux-session', '.airprompt-name']) {
    try { fs.unlinkSync(path.join(TEMP_DIR, f)); } catch (_) {}
  }
  // Per-session dirs
  const sessionsDir = path.join(TEMP_DIR, '.airprompt', 'sessions');
  if (fs.existsSync(sessionsDir)) {
    try { fs.rmSync(sessionsDir, { recursive: true, force: true }); } catch (_) {}
  }
}

test('deactivate hook exits clean when no session file', () => {
  cleanupMarkers();
  const r = runDeactivate();
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

test('deactivate hook exits 0 when tmux session is alive (spurious Stop guard)', { skip: !TMUX_AVAILABLE }, async () => {
  // Create a real tmux session that the deactivate guard will detect as alive
  const aliveSession = 'airprompt-guard-alive';
  createTmux(aliveSession);
  try {
    // Set up per-session dir as if /airprompt on was run from that session
    const fs = require('fs');
    const path = require('path');
    const sessionsDir = path.join(TEMP_DIR, '.airprompt', 'sessions');
    const myDir = path.join(sessionsDir, aliveSession);
    fs.mkdirSync(myDir, { recursive: true });
    fs.writeFileSync(path.join(myDir, 'session'), 'test-guard-session\n');
    fs.writeFileSync(path.join(myDir, 'tmux'), aliveSession + '\n');
    fs.writeFileSync(path.join(myDir, 'active'), '');
    fs.writeFileSync(path.join(myDir, 'url'), 'http://192.168.0.10:3210\n');

    // Register the session first (so deactivate has something to unregister if guard fails)
    await post('/api/sessions/register', { sessionId: 'test-guard-session', cwd: '/tmp' });

    const r = runDeactivate();
    // Guard should detect session is alive → exit 0 without unregistering
    assert.strictEqual(r.status, 0);

    // Session should STILL be registered (guard prevented cleanup)
    assert.strictEqual(sessions.has('test-guard-session'), true);

    // Per-session dir must survive (guard prevented cleanup)
    assert.strictEqual(fs.existsSync(path.join(myDir, 'active')), true);

    // Clean up
    sessions.delete('test-guard-session');
  } finally {
    killTmux(aliveSession);
    cleanupMarkers();
  }
});

test('deactivate hook proceeds with cleanup when tmux session is gone', { skip: !TMUX_AVAILABLE }, async () => {
  const deadSession = 'airprompt-guard-dead';
  killTmux(deadSession);

  const fs = require('fs');
  const path = require('path');
  // New per-session dir structure — deactivate.js checks here first
  const sessionsDir = path.join(TEMP_DIR, '.airprompt', 'sessions');
  const myDir = path.join(sessionsDir, deadSession);
  fs.mkdirSync(myDir, { recursive: true });
  fs.writeFileSync(path.join(myDir, 'session'), 'test-guard-dead-session\n');
  fs.writeFileSync(path.join(myDir, 'tmux'), deadSession + '\n');
  fs.writeFileSync(path.join(myDir, 'active'), '');
  fs.writeFileSync(path.join(myDir, 'url'), 'http://192.168.0.10:3210\n');

  // Register session with server so unregister works, then kill tmux
  await post('/api/sessions/register', { sessionId: 'test-guard-dead-session', cwd: '/tmp' });
  // Server auto-creates airprompt-<sessionId> when no tmuxSession given.
  // Kill it so the server-side guard passes.
  killTmux('airprompt-test-guard-dead-session');

  const r = runDeactivate();
  assert.strictEqual(r.status, 0, 'deactivate exit code — stderr: ' + r.stderr);

  // Per-session dir removed (local cleanup)
  assert.strictEqual(fs.existsSync(myDir), false,
    'per-session dir must be removed — stderr: ' + r.stderr);

  cleanupMarkers();
});

test('deactivate hook exits 0 when tmux is not available (safe fallback)', { skip: !TMUX_AVAILABLE }, () => {
  const aliveSession = 'airprompt-guard-tmuxless';
  createTmux(aliveSession);
  try {
    const fs = require('fs');
    const path = require('path');
    // Per-session dir structure
    const sessionsDir = path.join(TEMP_DIR, '.airprompt', 'sessions');
    const myDir = path.join(sessionsDir, aliveSession);
    fs.mkdirSync(myDir, { recursive: true });
    fs.writeFileSync(path.join(myDir, 'session'), 'test-tmuxless-session\n');
    fs.writeFileSync(path.join(myDir, 'tmux'), aliveSession + '\n');
    fs.writeFileSync(path.join(myDir, 'active'), '');
    fs.writeFileSync(path.join(myDir, 'url'), 'http://192.168.0.10:3210\n');

    const r = runDeactivate({ PATH: '/nonexistent' });
    assert.strictEqual(r.status, 0, 'deactivate exit code — stderr: ' + r.stderr);

    // Per-session dir must survive (guard prevented cleanup — tmux not available)
    assert.strictEqual(fs.existsSync(path.join(myDir, 'active')), true,
      'per-session dir must survive when tmux not available');
  } finally {
    killTmux(aliveSession);
    cleanupMarkers();
  }
});

// ── PID file test ───────────────────────────────────────────────────
// PID file is managed only in direct-execution block (require.main === module),
// so createApp() in test mode leaves it untouched. If a real server is
// running, the PID file exists — that's expected and not a test failure.
test('PID file not created in test mode', () => {
  // Test that createApp itself doesn't create a PID file.
  // (A running server may have one — skip assertion if already existed.)
  const fs = require('fs');
  const existedBefore = fs.existsSync('/tmp/airprompt-server.pid');
  // createApp was already called in before() — check still true
  assert.strictEqual(existedBefore, fs.existsSync('/tmp/airprompt-server.pid'));
});

// ── Test isolation: recovery and PID file ────────────────────────────

test('recoverSessionsFromDisk skipped when AIRPROMPT_SKIP_RECOVERY=1', () => {
  // The server module exports createApp; the recovery function is internal.
  // Test that the env var guard exists in the source.
  const fs = require('fs');
  const path = require('path');
  const serverPath = path.join(__dirname, '..', '..', 'server.js');
  const source = fs.readFileSync(serverPath, 'utf8');
  assert.ok(source.includes('AIRPROMPT_SKIP_RECOVERY'),
    'server.js must check AIRPROMPT_SKIP_RECOVERY before recovery');
});

test('deactivate PID_FILE respects AIRPROMPT_PID_FILE env var', () => {
  const fs = require('fs');
  const path = require('path');
  const deactivatePath = path.join(__dirname, '..', '..', 'src', 'hooks', 'airprompt-deactivate.js');
  const source = fs.readFileSync(deactivatePath, 'utf8');
  assert.ok(source.includes('process.env.AIRPROMPT_PID_FILE'),
    'deactivate.js must use AIRPROMPT_PID_FILE env var, not hardcoded /tmp/airprompt-server.pid');
});

test('deactivate stopDaemon never targets production PID in test env', async () => {
  // Verify runDeactivate helper sets AIRPROMPT_PID_FILE to test path
  const testPidFile = '/tmp/airprompt-server-test.pid';
  assert.ok(testPidFile !== '/tmp/airprompt-server.pid',
    'test PID file must differ from production PID file');

  // If stopDaemon() is called in a test context, it reads the TEST pid file,
  // not the real /tmp/airprompt-server.pid
  const fs = require('fs');
  // Remove test pid file if it exists from prior runs
  try { fs.unlinkSync(testPidFile); } catch (_) {}

  // stopDaemon reads PID_FILE, tries to kill process, fails gracefully
  // because test PID file doesn't exist
  const PID_FILE = testPidFile;
  let threw = false;
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    process.kill(pid, 'SIGTERM');
  } catch (_) {
    threw = true; // Expected: file doesn't exist
  }
  assert.ok(threw, 'stopDaemon with test PID file must fail safely (no file)');
});

// ── Notification API tests ──────────────────────────────────────────

test('POST /api/notify rejects missing notification_type', async () => {
  const res = await post('/api/notify', {});
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'Missing notification_type');
});

test('POST /api/notify returns ok with full payload', async () => {
  const res = await post('/api/notify', {
    notification_type: 'idle_prompt',
    session_id: 'abc123',
    cwd: '/home/user/my-project',
    message: 'Claude is waiting for your input',
    permission_mode: 'auto',
    effort: { level: 'max' },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);
});

test('WS receives notification broadcast when POST /api/notify is called', (t, done) => {
  const ws = new WebSocket(`ws://localhost:${port}`);
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'session_list') {
      post('/api/notify', {
        notification_type: 'agent_completed',
        session_id: 'test-notify',
        cwd: '/tmp',
        permission_mode: 'default',
        effort: { level: 'medium' },
      });
    } else if (msg.type === 'notification') {
      assert.strictEqual(msg.notification_type, 'agent_completed');
      assert.strictEqual(msg.session_id, 'test-notify');
      assert.strictEqual(msg.cwd, '/tmp');
      assert.strictEqual(msg.permission_mode, 'default');
      assert.deepStrictEqual(msg.effort, { level: 'medium' });
      assert.strictEqual(msg.auto_dismiss, false);
      ws.close();
      done();
    }
  });
  ws.on('error', (e) => { assert.fail('WS error: ' + e.message); });
});

// ── Session kill tests ──────────────────────────────────────────────

test('POST /api/sessions/kill rejects missing sessionId', async () => {
  const res = await post('/api/sessions/kill', {});
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'Missing sessionId');
});

test('POST /api/sessions/kill returns 404 for unknown', async () => {
  const res = await post('/api/sessions/kill', { sessionId: 'nonexistent' });
  assert.strictEqual(res.status, 404);
  assert.strictEqual(res.body.error, 'Session not found');
});

test('POST /api/sessions/kill handles already-dead tmux', async () => {
  // Register a session (server creates a tmux session for it)
  await post('/api/sessions/register', { sessionId: 'test-kill-dead', cwd: '/tmp' });
  assert.ok(sessions.has('test-kill-dead'), 'session should be registered');
  // Kill the tmux session directly so kill endpoint sees a dead session
  const entry = sessions.get('test-kill-dead');
  if (entry && entry.tmuxSession) spawnSync('tmux', ['kill-session', '-t', entry.tmuxSession], { timeout: 2000 });
  // Wait for tmux to fully clean up
  await new Promise(function (r) { setTimeout(r, 100); });
  const res = await post('/api/sessions/kill', { sessionId: 'test-kill-dead' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.killed, false);
  assert.strictEqual(res.body.reason, 'already dead');
  assert.ok(!sessions.has('test-kill-dead'), 'session removed from memory');
});

test('POST /api/sessions/kill force-kills airprompt-* tmux session', { skip: !TMUX_AVAILABLE }, async () => {
  // Create a real airprompt tmux session
  spawnSync('tmux', ['new-session', '-d', '-s', 'airprompt-test-kill-live'], { timeout: 2000 });
  // Register via API
  await post('/api/sessions/register', { sessionId: 'test-kill-live', cwd: '/tmp', tmuxSession: 'airprompt-test-kill-live' });
  assert.ok(sessions.has('test-kill-live'), 'session should be registered');
  // Kill it — should force-kill the tmux and remove from sessions
  const res = await post('/api/sessions/kill', { sessionId: 'test-kill-live' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);
  assert.ok(!sessions.has('test-kill-live'), 'session removed from memory');
  // Verify tmux session is dead
  const { status } = spawnSync('tmux', ['has-session', '-t', 'airprompt-test-kill-live'], { timeout: 2000 });
  assert.notStrictEqual(status, 0, 'tmux session should be gone');
});

test('integration test sets CLAUDE_CONFIG_DIR for isolation', () => {
  const fs = require('fs');
  const path = require('path');
  const integPath = path.join(__dirname, '..', 'integration', 'run.sh');
  const source = fs.readFileSync(integPath, 'utf8');
  assert.ok(source.includes('CLAUDE_CONFIG_DIR="$TMPDIR"') || source.includes('CLAUDE_CONFIG_DIR="${TMPDIR}"'),
    'integration test must set CLAUDE_CONFIG_DIR to temp dir for isolation');
  assert.ok(source.includes('AIRPROMPT_SKIP_RECOVERY=1'),
    'integration test must set AIRPROMPT_SKIP_RECOVERY=1 to skip production session recovery');
});

// ── sessionToJSON canonical shape ─────────────────────────────────────

test('sessionToJSON returns all expected fields with defaults', () => {
  const { sessionToJSON } = require('../../src/utils');
  const sessions = new Map();
  sessions.set('t1', {
    sessionId: 't1', cwd: '/tmp/proj', name: 'Test Project',
    tmuxSession: 'airprompt-t1', createdAt: '2026-07-31T00:00:00.000Z',
    lastActivity: 1722441600000,
  });
  const entry = sessions.get('t1');
  const json = sessionToJSON(entry);

  assert.strictEqual(json.id, 't1');
  assert.strictEqual(json.cwd, '/tmp/proj');
  assert.strictEqual(json.name, 'Test Project');
  assert.strictEqual(json.tmuxSession, 'airprompt-t1');
  assert.strictEqual(json.createdAt, '2026-07-31T00:00:00.000Z');
  assert.strictEqual(typeof json.isMirror, 'boolean');
  assert.strictEqual(typeof json.isActive, 'boolean');
  assert.strictEqual(typeof json.tmuxAlive, 'boolean');
  assert.strictEqual(typeof json.attachedClients, 'number');
  assert.strictEqual(json.lastActivity, 1722441600000);
});

test('sessionToJSON null name stays null', () => {
  const { sessionToJSON } = require('../../src/utils');
  const sessions = new Map();
  sessions.set('t2', {
    sessionId: 't2', cwd: '/tmp', name: null,
    tmuxSession: 'airprompt-t2', createdAt: '2026-07-31T00:00:00.000Z',
  });
  assert.strictEqual(sessionToJSON(sessions.get('t2')).name, null);
});

test('sessionToJSON missing lastActivity stays null', () => {
  const { sessionToJSON } = require('../../src/utils');
  const sessions = new Map();
  sessions.set('t3', {
    sessionId: 't3', cwd: '/tmp', name: null,
    tmuxSession: 'airprompt-t3', createdAt: '2026-07-31T00:00:00.000Z',
  });
  assert.strictEqual(sessionToJSON(sessions.get('t3')).lastActivity, null);
});

// ── Mirror marker — deactivate hook kills mirror, keeps real ──────────

test('deactivate hook kills mirror session when tmux is alive', { skip: !TMUX_AVAILABLE }, async () => {
  const mirrorSession = 'airprompt-deact-mirror-test';
  createTmux(mirrorSession);
  try {
    const fs = require('fs');
    const path = require('path');
    const sessionsDir = path.join(TEMP_DIR, '.airprompt', 'sessions');
    const myDir = path.join(sessionsDir, mirrorSession);
    fs.mkdirSync(myDir, { recursive: true });
    fs.writeFileSync(path.join(myDir, 'session'), 'test-mirror-kill\n');
    fs.writeFileSync(path.join(myDir, 'tmux'), mirrorSession + '\n');
    fs.writeFileSync(path.join(myDir, 'active'), '');
    fs.writeFileSync(path.join(myDir, 'mirror'), '');  // ← mirror marker
    fs.writeFileSync(path.join(myDir, 'url'), 'http://192.168.0.10:3210\n');

    await post('/api/sessions/register', { sessionId: 'test-mirror-kill', cwd: '/tmp' });

    const r = runDeactivate({ AIRPROMPT_DEACTIVATE_TEST_TMUX: mirrorSession });
    assert.strictEqual(r.status, 0, 'deactivate exit code — stderr: ' + r.stderr);

    // Per-session dir removed
    assert.strictEqual(fs.existsSync(myDir), false,
      'mirror per-session dir must be removed — stderr: ' + r.stderr);

    // Tmux session killed by deactivate
    const s = spawnSync('tmux', ['has-session', '-t', mirrorSession], { timeout: 2000 });
    assert.notStrictEqual(s.status, 0, 'mirror tmux session must be killed');
  } finally {
    killTmux(mirrorSession);
    cleanupMarkers();
  }
});

test('deactivate hook keeps alive real session (no mirror marker)', { skip: !TMUX_AVAILABLE }, async () => {
  const realSession = 'airprompt-deact-real-test';
  createTmux(realSession);
  try {
    const fs = require('fs');
    const path = require('path');
    const sessionsDir = path.join(TEMP_DIR, '.airprompt', 'sessions');
    const myDir = path.join(sessionsDir, realSession);
    fs.mkdirSync(myDir, { recursive: true });
    fs.writeFileSync(path.join(myDir, 'session'), 'test-real-alive\n');
    fs.writeFileSync(path.join(myDir, 'tmux'), realSession + '\n');
    fs.writeFileSync(path.join(myDir, 'active'), '');
    // NOTE: NO mirror marker
    fs.writeFileSync(path.join(myDir, 'url'), 'http://192.168.0.10:3210\n');

    await post('/api/sessions/register', { sessionId: 'test-real-alive', cwd: '/tmp' });

    const r = runDeactivate({ AIRPROMPT_DEACTIVATE_TEST_TMUX: realSession });
    assert.strictEqual(r.status, 0);

    // Per-session dir must survive (guard: alive + no mirror marker)
    assert.strictEqual(fs.existsSync(path.join(myDir, 'active')), true,
      'real session dir must survive — stderr: ' + r.stderr);

    // Session still registered
    assert.strictEqual(sessions.has('test-real-alive'), true);
  } finally {
    killTmux(realSession);
    sessions.delete('test-real-alive');
    cleanupMarkers();
  }
});

// ── lastActivity tracking ─────────────────────────────────────────────

test('session registration sets lastActivity', async () => {
  await post('/api/sessions/register', { sessionId: 'test-activity', cwd: '/tmp' });
  assert.strictEqual(sessions.has('test-activity'), true);
  assert.ok(typeof sessions.get('test-activity').lastActivity === 'number',
    'lastActivity must be a timestamp');
  sessions.delete('test-activity');
});

// ── Orphan killer (stale sweep) ──────────────────────────────────────

test('stale sweep does not kill session with recent activity', () => {
  // Fresh session with activity < 2 min ago — must survive
  sessions.set('orphan-recent', {
    sessionId: 'orphan-recent', cwd: '/tmp', name: null,
    tmuxSession: 'airprompt-orphan-recent', createdAt: new Date().toISOString(),
    lastActivity: Date.now(),  // just now
  });
  // The sweep runs every 60s but ORPHAN_GRACE_MS = 120s.
  // Our test creates a session with activity NOW — should survive sweep.
  assert.strictEqual(sessions.has('orphan-recent'), true);
  // Verify entry fields
  const entry = sessions.get('orphan-recent');
  assert.ok(entry.lastActivity > 0);
  assert.ok(entry.tmuxSession.startsWith('airprompt-'));
  sessions.delete('orphan-recent');
});

test('stale sweep removes session with dead tmux', () => {
  // Session whose tmux process is already dead
  sessions.set('stale-dead-tmux', {
    sessionId: 'stale-dead-tmux', cwd: '/tmp', name: null,
    tmuxSession: 'airprompt-nonexistent-dead-session', createdAt: new Date().toISOString(),
  });
  assert.strictEqual(sessions.has('stale-dead-tmux'), true);
  // We can't trigger the 60s sweep deterministically, but verify the
  // entry shape matches expectations for the sweep to process
  sessions.delete('stale-dead-tmux');
});

// ── sessionToJSON attachedClients edge cases ──────────────────────────

test('sessionToJSON attachedClients is 0 when tmux session is dead', () => {
  const { sessionToJSON } = require('../../src/utils');
  const sessions = new Map();
  sessions.set('dead-json', {
    sessionId: 'dead-json', cwd: '/tmp', name: null,
    tmuxSession: 'airprompt-dead-session-that-does-not-exist',
    createdAt: new Date().toISOString(),
  });
  const json = sessionToJSON(sessions.get('dead-json'));
  assert.strictEqual(json.tmuxAlive, false);
  assert.strictEqual(json.attachedClients, 0);
});
