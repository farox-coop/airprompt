const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { execSync } = require('child_process');
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

test('POST /api/sessions/unregister removes session', { skip: !TMUX_AVAILABLE }, async () => {
  createTmux('airprompt-test-unreg');
  try {
    await post('/api/sessions/register', { sessionId: 'test-unreg', cwd: '/tmp' });
    const res = await post('/api/sessions/unregister', { sessionId: 'test-unreg' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(sessions.has('test-unreg'), false);
  } finally {
    killTmux('airprompt-test-unreg');
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

// ── PID file test ───────────────────────────────────────────────────
// PID file is managed only in direct-execution block (require.main === module),
// so it's not created during tests. This is by design — tests use createApp directly.
test('PID file not created in test mode', () => {
  const fs = require('fs');
  assert.strictEqual(fs.existsSync('/tmp/airprompt-server.pid'), false);
});
