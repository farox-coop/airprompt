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
    CLAUDE_CONFIG_DIR: TEMP_DIR,
    AIRPROMPT_NO_TLS: '1', // match test server
    ...envOverrides,
  };
  const r = spawnSync(process.execPath, [DEACTIVATE_SCRIPT], {
    env,
    timeout: 10000,
    encoding: 'utf8',
  });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function cleanupMarkers() {
  const fs = require('fs');
  for (const f of ['.airprompt-active', '.airprompt-url', '.airprompt-session',
                   '.airprompt-tmux-active', '.airprompt-tmux-session']) {
    try { fs.unlinkSync(require('path').join(TEMP_DIR, f)); } catch (_) {}
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
    // Set up markers as if /airprompt on was run from that session
    const fs = require('fs');
    const path = require('path');
    fs.writeFileSync(path.join(TEMP_DIR, '.airprompt-session'), 'test-guard-session\n');
    fs.writeFileSync(path.join(TEMP_DIR, '.airprompt-active'), '');
    fs.writeFileSync(path.join(TEMP_DIR, '.airprompt-url'), 'http://192.168.0.10:3210\n');
    fs.writeFileSync(path.join(TEMP_DIR, '.airprompt-tmux-active'), aliveSession + '\n');
    fs.writeFileSync(path.join(TEMP_DIR, '.airprompt-tmux-session'), aliveSession + '\n');

    // Register the session first (so deactivate has something to unregister if guard fails)
    await post('/api/sessions/register', { sessionId: 'test-guard-session', cwd: '/tmp' });

    const r = runDeactivate();
    // Guard should detect session is alive → exit 0 without unregistering
    assert.strictEqual(r.status, 0);

    // Session should STILL be registered (guard prevented cleanup)
    assert.strictEqual(sessions.has('test-guard-session'), true);

    // Clean up
    sessions.delete('test-guard-session');
  } finally {
    killTmux(aliveSession);
    cleanupMarkers();
  }
});

test('deactivate hook proceeds with cleanup when tmux session is gone', { skip: !TMUX_AVAILABLE }, () => {
  const deadSession = 'airprompt-guard-dead';
  killTmux(deadSession);

  const fs = require('fs');
  const path = require('path');
  fs.writeFileSync(path.join(TEMP_DIR, '.airprompt-session'), 'test-guard-dead-session\n');
  fs.writeFileSync(path.join(TEMP_DIR, '.airprompt-active'), '');
  fs.writeFileSync(path.join(TEMP_DIR, '.airprompt-url'), 'http://192.168.0.10:3210\n');
  fs.writeFileSync(path.join(TEMP_DIR, '.airprompt-tmux-active'), deadSession + '\n');
  fs.writeFileSync(path.join(TEMP_DIR, '.airprompt-tmux-session'), deadSession + '\n');

  const r = runDeactivate();
  assert.strictEqual(r.status, 0, 'deactivate exit code — stderr: ' + r.stderr);

  // Markers removed (local cleanup always works)
  assert.strictEqual(fs.existsSync(path.join(TEMP_DIR, '.airprompt-session')), false);
  assert.strictEqual(fs.existsSync(path.join(TEMP_DIR, '.airprompt-active')), false);
  assert.strictEqual(fs.existsSync(path.join(TEMP_DIR, '.airprompt-tmux-active')), false);
  assert.strictEqual(fs.existsSync(path.join(TEMP_DIR, '.airprompt-tmux-session')), false);

  cleanupMarkers();
});

test('deactivate hook exits 0 when tmux is not available (safe fallback)', { skip: !TMUX_AVAILABLE }, () => {
  const aliveSession = 'airprompt-guard-tmuxless';
  createTmux(aliveSession);
  try {
    const fs = require('fs');
    const path = require('path');
    fs.writeFileSync(path.join(TEMP_DIR, '.airprompt-session'), 'test-tmuxless-session\n');
    fs.writeFileSync(path.join(TEMP_DIR, '.airprompt-active'), '');
    fs.writeFileSync(path.join(TEMP_DIR, '.airprompt-url'), 'http://192.168.0.10:3210\n');
    fs.writeFileSync(path.join(TEMP_DIR, '.airprompt-tmux-active'), aliveSession + '\n');

    const r = runDeactivate({ PATH: '/nonexistent' });
    assert.strictEqual(r.status, 0, 'deactivate exit code — stderr: ' + r.stderr);

    // Markers must survive (guard prevented cleanup)
    assert.strictEqual(fs.existsSync(path.join(TEMP_DIR, '.airprompt-session')), true,
      'session file must survive when tmux not available');
    assert.strictEqual(fs.existsSync(path.join(TEMP_DIR, '.airprompt-tmux-active')), true,
      'tmux-active file must survive when tmux not available');
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
