const express = require('express');
const http = require('http');
const https = require('https');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const qrcode = require('qrcode-terminal');
const { tmuxExists, sessionToJSON, getSessionsDir, safeRmSync } = require('./src/utils');
const { runStaleSweep } = require('./src/sweep');
const auth = require('./src/auth');
const uploads = require('./src/uploads');

const PORT = process.env.AIRPROMPT_PORT || 3210;
const PID_FILE = process.env.AIRPROMPT_PID_FILE || '/tmp/airprompt-server.pid';
const STALE_CHECK_MS = 60_000;
const DEBUG = process.env.AIRPROMPT_DEBUG === '1';

function log(level, msg, extra) {
  if (!DEBUG) return;
  const ts = new Date().toISOString();
  const extraStr = extra ? ' ' + JSON.stringify(extra) : '';
  process.stderr.write(`[airprompt:${level}] ${ts} ${msg}${extraStr}\n`);
}

// State dir: daemon.json, certs, project-names.json live here.
// Separate from install dir (~/.airprompt/) so reinstall won't destroy user data.
const STATE_DIR = process.env.AIRPROMPT_STATE_DIR || path.join(os.homedir(), '.airprompt', 'state');
const CERT_FILE = path.join(STATE_DIR, 'airprompt-cert.pem');
const KEY_FILE = path.join(STATE_DIR, 'airprompt-key.pem');
const DAEMON_JSON = path.join(STATE_DIR, 'daemon.json');

function tlsAvailable() {
  if (process.env.AIRPROMPT_NO_TLS === '1') return false;
  return fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE);
}

const TLS_ENABLED = tlsAvailable();

const sessions = new Map();

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

// ── WebSocket Origin check ──────────────────────────────────────────────────
// Block cross-site WebSocket hijacking (CSWSH). The daemon serves its own page,
// so a legitimate browser connection always has Origin host:port === the
// request's Host header (public/client.js connects to window.location). Any
// other Origin — a remote site, or a local page on a different port — is
// rejected. This also keeps hostname (mDNS) and multi-NIC access working,
// since it checks same-origin rather than a frozen IP list.
// Loopback (host-internal) addresses. Host-side hooks/CLI reach the REST API
// via localhost; anything else is a remote device that must be rejected.
function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function originAllowed(info) {
  const origin = info.origin;
  // Absent Origin: non-browser client (curl, native ws, some webviews).
  // Browsers always send Origin on WS upgrades — no Origin = no CSWSH vector.
  // (These clients stay unauthenticated until the device handshake completes.)
  if (!origin) return true;
  let originHost;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch (_) {
    return false; // malformed Origin — reject
  }
  const hostHeader = String(info.req.headers.host || '').toLowerCase();
  return !!hostHeader && originHost === hostHeader;
}

function createTmuxSession(sessionName, cwd) {
  try {
    const r = spawnSync('tmux', ['new-session', '-d', '-s', sessionName, '-c', cwd], {
      timeout: 2000,
    });
    return r.status === 0;
  } catch (e) {
    return false;
  }
}

// Best-effort desktop notification that a device is awaiting pairing approval.
// The daemon has no TTY, so this is the passive "popup" on the host. The CLI
// (`airprompt auth allow <seq>`) remains the universal approval path.
function notifyPairing(entry) {
  try {
    spawnSync(
      'notify-send',
      [
        'AirPrompt',
        `New device "${entry.name}" (seq ${entry.seq}) wants to pair — airprompt auth allow ${entry.seq}`,
      ],
      { timeout: 2000 }
    );
  } catch (_) {
    /* no desktop notification available — CLI still works */
  }
}

function killTmuxSession(sessionName) {
  try {
    spawnSync('tmux', ['kill-session', '-t', sessionName], { timeout: 2000 });
  } catch (e) {
    /* ok */
  }
}

// Send a message to every authenticated WS client only (no pre-auth leak).
function broadcastAuthed(wss, msg) {
  wss.clients.forEach((client) => {
    if (client.readyState === 1 && client._airpromptAuthed === true) {
      try {
        client.send(msg);
      } catch (e) {
        /* ok */
      }
    }
  });
}

function broadcastSessionList(wss) {
  const list = Array.from(sessions.values()).map((s) => sessionToJSON(s));
  broadcastAuthed(wss, JSON.stringify({ type: 'session_list', sessions: list }));
}

// Kill a session (graceful `/airprompt off` → wait → force). Shared by the
// loopback-only REST route and the authenticated WS `kill_session` message.
async function killSessionById(sessionId, wss) {
  const entry = sessions.get(sessionId);
  if (!entry) return { ok: false, error: 'Session not found' };
  const tmux = entry.tmuxSession;
  if (!tmux) {
    sessions.delete(sessionId);
    broadcastSessionList(wss);
    return { ok: true, killed: false, reason: 'no tmux session' };
  }
  if (!tmuxExists(tmux)) {
    sessions.delete(sessionId);
    broadcastSessionList(wss);
    return { ok: true, killed: false, reason: 'already dead' };
  }

  // Phase 1: Graceful — send `/airprompt off` into the tmux session.
  spawnSync('tmux', ['send-keys', '-t', tmux, '/airprompt off', 'Enter'], { timeout: 2000 });

  // Phase 2: Wait up to 5s for the session to die.
  const deadline = Date.now() + 5000;
  let died = false;
  let wasGraceful = false;
  while (Date.now() < deadline) {
    await new Promise(function (r) {
      setTimeout(r, 300);
    });
    if (!tmuxExists(tmux)) {
      died = true;
      wasGraceful = true;
      break;
    }
  }

  // Phase 3: If still alive, force kill (airprompt-* only). Non-airprompt
  // sessions belong to real IDE instances — never kill them.
  if (!died && tmuxExists(tmux) && tmux.startsWith('airprompt-')) {
    spawnSync('tmux', ['kill-session', '-t', tmux], { timeout: 2000 });
    died = true;
  }

  if (died) sessions.delete(sessionId);
  broadcastSessionList(wss);
  return { ok: true, killed: died, graceful: wasGraceful };
}

function writePid() {
  try {
    fs.writeFileSync(PID_FILE, String(process.pid), { flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') {
      console.error('PID file already exists.');
      process.exit(1);
    }
    throw e;
  }
}

function removePid() {
  try {
    fs.unlinkSync(PID_FILE);
  } catch (e) {
    /* ok */
  }
}

function writeDaemonJson(protocol, port, lanIp) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  } catch (_) {}
  const json = JSON.stringify({
    protocol,
    port,
    lanIp,
    url: `${protocol}://${lanIp}:${port}`,
    pid: process.pid,
  });
  try {
    fs.writeFileSync(DAEMON_JSON, json);
  } catch (_) {}
}
function removeDaemonJson() {
  try {
    fs.unlinkSync(DAEMON_JSON);
  } catch (_) {}
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

// ── Startup recovery: scan per-session dirs and re-register alive sessions ──
// Daemon restart loses in-memory state. On-disk markers survive.
// Rebuild session registry from ~/.airprompt/sessions/{providerId}-{tmux}/
function recoverSessionsFromDisk() {
  if (process.env.AIRPROMPT_SKIP_RECOVERY === '1') return;
  const sessionsRoot = getSessionsDir();
  if (!fs.existsSync(sessionsRoot)) return;

  let entries;
  try {
    entries = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch (_) {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(sessionsRoot, entry.name);

    // Read REAL tmux session name from marker file. Dir name is {providerId}-{safeName}
    // so it can't be used as a fallback.
    let realTmux = '';
    try {
      realTmux = fs.readFileSync(path.join(dir, 'tmux'), 'utf8').trim().slice(0, 128);
    } catch (_) {}
    if (!realTmux) {
      if (!safeRmSync(dir)) log('warn', 'recovery skipped unsafe rm target', { dir });
      continue;
    }

    // Only delete on explicit "no session" (exit code 1).
    // Other non-zero codes (tmux error, timeout, missing binary) must NOT
    // trigger data loss — same guard used in on.sh/off.sh sweep loops.
    const hasSession = spawnSync('tmux', ['has-session', '-t', realTmux], { timeout: 2000 });
    if (hasSession.status !== 0) {
      if (hasSession.status === 1 && !safeRmSync(dir)) {
        log('warn', 'recovery skipped unsafe rm target', { dir });
      }
      // status 2+ (tmux error) or signal — skip, don't delete
      continue;
    }

    let sessionId, name;
    try {
      sessionId = fs.readFileSync(path.join(dir, 'session'), 'utf8').trim().slice(0, 128);
    } catch (_) {
      sessionId = '';
    }
    // Validate: sessionId must match register's format. If missing or invalid,
    // fall back to sanitized tmux name (strip dots/spaces, same as on.sh SESSION_ID).
    if (!sessionId || !/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId)) {
      sessionId = realTmux.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || realTmux.slice(0, 64);
    }
    try {
      name = fs.readFileSync(path.join(dir, 'name'), 'utf8').trim().slice(0, 64) || null;
    } catch (_) {
      name = null;
    }

    let cwd = process.env.HOME || '/';
    try {
      const r = spawnSync(
        'tmux',
        ['display-message', '-t', realTmux, '-p', '#{pane_current_path}'],
        { timeout: 2000, encoding: 'utf8' }
      );
      if (r.status === 0 && r.stdout.trim()) cwd = r.stdout.trim();
    } catch (_) {}

    // Provider: read from marker file (written by hook/on.sh at registration)
    let providerId = '';
    try {
      providerId = fs.readFileSync(path.join(dir, 'provider'), 'utf8').trim().slice(0, 32);
    } catch (_) {}

    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, {
        sessionId,
        cwd,
        name,
        tmuxSession: realTmux,
        providerId,
        createdAt: new Date().toISOString(),
        lastActivity: Date.now(),
      });
      log('info', 'session recovered from disk', {
        sessionId,
        tmuxSession: realTmux,
        cwd,
        name,
        providerId,
      });
    }
  }

  if (sessions.size > 0) log('info', 'recovery complete', { recovered: sessions.size });
}

function createApp() {
  const app = express();
  app.use(express.json());
  // LAN PoC: always revalidate so dev edits show up without cache-busting.
  const noCache = {
    setHeaders: function (res) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    },
  };
  app.use(express.static(path.join(__dirname, 'public'), noCache));

  // Vendored xterm.js + addon-fit (npm deps) — served locally so the web UI
  // works on a LAN-only phone with no CDN/internet access.
  app.use(
    '/vendor/xterm',
    express.static(path.join(__dirname, 'node_modules', '@xterm', 'xterm'), noCache)
  );
  app.use(
    '/vendor/xterm-addon-fit',
    express.static(path.join(__dirname, 'node_modules', '@xterm', 'addon-fit'), noCache)
  );

  // Host-internal REST endpoints (sessions + notify) are called only by the
  // hooks/CLI running on the host via loopback. Restrict them so a rogue LAN
  // device can't inject/kill sessions or spoof notifications. /api/pair and
  // /api/upload are the LAN-reachable surfaces (pairing requests, and file
  // uploads authenticated by their own one-time token) — both rate-limited.
  app.use('/api', (req, res, next) => {
    if (req.path === '/pair' || req.path.startsWith('/pair/') || req.path === '/upload')
      return next();
    if (isLoopback(req.socket.remoteAddress || '')) return next();
    res.status(403).json({ error: 'Forbidden' });
  });

  app.get('/api/sessions', (_req, res) => {
    res.json(Array.from(sessions.values()).map((s) => sessionToJSON(s)));
  });

  app.post('/api/sessions/register', (req, res) => {
    const { sessionId, cwd, tmuxSession, name, providerId } = req.body || {};
    if (!sessionId || !cwd) return res.status(400).json({ error: 'Missing sessionId or cwd' });
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId))
      return res.status(400).json({ error: 'Invalid sessionId format' });
    if (typeof cwd !== 'string' || cwd.length > 512)
      return res.status(400).json({ error: 'cwd too long' });
    if (
      name !== undefined &&
      (typeof name !== 'string' || name.length > 64 || !/^[a-zA-Z0-9 _-]{1,64}$/.test(name))
    )
      return res
        .status(400)
        .json({ error: 'Invalid name: max 64 chars, alphanumeric + spaces, dashes, underscores' });
    if (sessions.has(sessionId))
      return res.status(409).json({ error: 'Session already registered' });

    if (
      !providerId ||
      typeof providerId !== 'string' ||
      providerId.length > 32 ||
      !/^[a-z][a-z0-9-]*$/.test(providerId)
    )
      return res.status(400).json({ error: 'Missing or invalid providerId' });

    let actualTmuxSession;
    if (tmuxSession && /^[a-zA-Z0-9_. -]{1,64}$/.test(tmuxSession) && tmuxExists(tmuxSession)) {
      actualTmuxSession = tmuxSession;
    } else {
      actualTmuxSession = `airprompt-${sessionId}`;
      if (!tmuxExists(actualTmuxSession)) {
        if (!createTmuxSession(actualTmuxSession, cwd)) {
          return res.status(500).json({ error: 'Failed to create tmux session' });
        }
      }
    }

    // Dedupe by tmux session + provider: two hooks may fire simultaneously with
    // different sessionIds but the same tmux+provider (plugin + settings.json).
    // Different providers on the same tmux are allowed (e.g. claude + codex
    // sharing a tmux session).
    for (const [existingId, existing] of sessions) {
      // Dedup: if both have providerId, match on tmux+provider; if either empty, match on tmux only
      const sameTmux = existing.tmuxSession === actualTmuxSession;
      const sameProvider =
        existing.providerId && providerId ? existing.providerId === providerId : sameTmux; // either empty → dedup by tmux alone
      if (sameTmux && sameProvider) {
        existing.cwd = cwd;
        existing.sessionId = sessionId;
        if (name !== undefined) existing.name = name || null;
        existing.providerId = providerId;
        existing.lastActivity = Date.now();
        sessions.delete(existingId);
        sessions.set(sessionId, existing);
        log('info', 'session re-registered (deduped by tmux+provider)', {
          oldId: existingId,
          newId: sessionId,
          tmuxSession: actualTmuxSession,
          providerId: providerId,
        });
        broadcastSessionList(wss);
        return res.json({ ok: true, sessionId });
      }
    }

    sessions.set(sessionId, {
      sessionId,
      cwd,
      name: name || null,
      tmuxSession: actualTmuxSession,
      providerId: providerId,
      createdAt: new Date().toISOString(),
      lastActivity: Date.now(),
    });
    log('info', 'session registered', {
      sessionId,
      tmuxSession: actualTmuxSession,
      cwd,
      name: name || null,
      providerId: providerId,
    });
    broadcastSessionList(wss);
    res.json({ ok: true, sessionId });
  });

  app.post('/api/sessions/unregister', (req, res) => {
    const { sessionId, force } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
    if (!sessions.has(sessionId)) return res.status(404).json({ error: 'Session not found' });
    const entry = sessions.get(sessionId);
    // Guard: if the registered tmux session is still alive, refuse to unregister.
    // This is a server-side safety net against spurious Stop hook invocations.
    // force: true bypasses this — used by explicit /airprompt off user command.
    if (!force && entry.tmuxSession && tmuxExists(entry.tmuxSession)) {
      log('warn', 'unregister refused — tmux session still alive', {
        sessionId,
        tmuxSession: entry.tmuxSession,
      });
      return res.status(409).json({ error: 'Session still active', ok: false });
    }
    sessions.delete(sessionId);
    log('info', 'session unregistered', { sessionId, tmuxSession: entry.tmuxSession });
    // Clean airprompt- prefixed sessions when orphaned — but ONLY if
    // a mirror marker exists (created by activate.js for IDE outside tmux).
    // Real sessions named airprompt-* (on.sh without CREATED_SESSION) must survive.
    if (entry.tmuxSession && entry.tmuxSession.startsWith('airprompt-')) {
      let shared = false;
      for (const [, other] of sessions) {
        if (other.tmuxSession === entry.tmuxSession) {
          shared = true;
          break;
        }
      }
      if (!shared) {
        // Check mirror marker before killing
        const sessionsDir = getSessionsDir();
        const safeName =
          entry.tmuxSession.replace(/[^a-zA-Z0-9_.-]/g, '') ||
          entry.tmuxSession.replace(/[^a-zA-Z0-9]/g, '') ||
          'unknown';
        const mirrorFile = path.join(
          sessionsDir,
          `${entry.providerId || 'unknown'}-${safeName}`,
          'mirror'
        );
        let isMirror = false;
        try {
          isMirror = fs.existsSync(mirrorFile);
        } catch (_) {}
        if (isMirror) killTmuxSession(entry.tmuxSession);
      }
    }
    // Non-airprompt tmux sessions belong to real IDE instances — never kill them
    broadcastSessionList(wss);
    res.json({ ok: true });
  });

  app.post('/api/notify', (req, res) => {
    const input = req.body || {};
    if (!input.notification_type)
      return res.status(400).json({ error: 'Missing notification_type' });

    log('info', 'notification received', {
      type: input.notification_type,
      session_id: input.session_id,
    });
    // Broadcast to all connected web clients
    // auto_dismiss: false = user must swipe to dismiss
    const msg = JSON.stringify({
      ...input,
      type: 'notification',
      auto_dismiss: input.auto_dismiss === true,
    });
    broadcastAuthed(wss, msg);
    res.json({ ok: true });
  });

  app.post('/api/sessions/kill', async (req, res) => {
    try {
      const { sessionId } = req.body || {};
      if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
      const result = await killSessionById(sessionId, wss);
      if (!result.ok) return res.status(404).json(result);
      res.json(result);
    } catch (err) {
      log('error', 'session kill failed', {
        sessionId: req.body && req.body.sessionId,
        error: err.message,
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.put('/api/sessions/name', (req, res) => {
    const { sessionId, name } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
    if (!sessions.has(sessionId)) return res.status(404).json({ error: 'Session not found' });
    // name field not present → no-op (don't silently clear)
    if (name === undefined) return res.json({ ok: true, name: sessions.get(sessionId).name });
    // Reject non-string non-nullish values (numbers, objects, booleans)
    if (name != null && typeof name !== 'string')
      return res.status(400).json({ error: 'name must be a string' });
    // Empty string or null clears the name; non-empty must pass validation
    if (typeof name === 'string' && name.length > 0 && !/^[a-zA-Z0-9 _-]{1,64}$/.test(name))
      return res
        .status(400)
        .json({ error: 'Invalid name: max 64 chars, alphanumeric + spaces, dashes, underscores' });
    const entry = sessions.get(sessionId);
    const prev = entry.name;
    entry.name = typeof name === 'string' && name.length > 0 ? name : null;
    log('info', 'session named', { sessionId, name: entry.name, prev: prev || null });
    broadcastSessionList(wss);
    res.json({ ok: true, name: entry.name });
  });

  // ── Device pairing ─────────────────────────────────────────────────────
  // The ONLY LAN-reachable REST surface. A request here only ever ADDS to the
  // pending list — approval happens on the trusted host filesystem via
  // `airprompt auth allow <seq>`. Never grants directly (that would let a
  // rogue device approve itself).
  app.post('/api/pair', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!auth.checkPairRate(ip)) {
      return res.status(429).json({ error: 'Too many pairing attempts' });
    }
    const { publicKey, name } = req.body || {};
    if (typeof publicKey !== 'string' || !publicKey || publicKey.length > 2048) {
      return res.status(400).json({ error: 'Invalid publicKey' });
    }
    if (!auth.isValidPublicKey(publicKey)) {
      return res.status(400).json({ error: 'Invalid publicKey' });
    }
    if (auth.deviceByPublicKey(publicKey)) {
      return res.json({ status: 'paired' });
    }
    // Only fire the desktop notification for a genuinely NEW request — a reload
    // that re-POSTs the same key refreshes TTL and must not re-notify.
    const wasPending = !!auth.pendingByPublicKey(publicKey);
    const entry = auth.addPending(publicKey, name, ip); // addPending sanitizes the name
    if (!entry) {
      return res.status(429).json({ error: 'Too many pending pairing requests' });
    }
    if (!wasPending) {
      log('info', 'pairing request', {
        seq: entry.seq,
        name: entry.name,
        fingerprint: entry.fingerprint,
      });
      notifyPairing(entry);
    }
    res.status(202).json({ status: 'pending', seq: entry.seq, requestId: entry.id });
  });

  app.get('/api/pair/:id', (req, res) => {
    res.json({ status: auth.pendingStatus(req.params.id) });
  });

  // ── File upload (LAN, token-gated) ────────────────────────────────────
  //
  // The phone cannot hand the host a phone-side path, so the bytes come here,
  // are written under ~/.airprompt/uploads/<session>/, and the returned absolute
  // path is what the client types into the session. This endpoint is exempt from
  // the loopback gate (the phone is not loopback), so the one-time token minted
  // over the authenticated WS is its authentication: device-bound, single-use,
  // short-lived, and re-checked against the paired-device list here so that
  // `airprompt auth revoke` also kills an in-flight upload.
  app.post(
    '/api/upload',
    (req, res, next) => {
      if (!auth.checkUploadRate(req.socket.remoteAddress || '')) {
        return res.status(429).json({ error: 'Too many uploads' });
      }
      next();
    },
    // Token validation runs BEFORE the body is parsed: without it, any LAN host
    // could make the daemon buffer a full-size body per request and never get
    // past this point.
    (req, res, next) => {
      const rec = uploads.takeToken(req.get('x-airprompt-upload-token') || '', Date.now());
      if (!rec) return res.status(401).json({ error: 'Invalid or expired upload token' });
      if (!auth.deviceByPublicKey(rec.device)) {
        return res.status(403).json({ error: 'Device is not paired' });
      }
      const entry = sessions.get(rec.sessionId);
      if (!entry) return res.status(409).json({ error: 'Session not found' });
      // The write directory comes from the token's session, never from a
      // client-supplied parameter — a token for one session cannot write into
      // another's directory.
      req._upload = { entry: entry, device: rec.device };
      next();
    },
    express.raw({ type: 'application/octet-stream', limit: uploads.maxBytes() }),
    (req, res) => {
      if (!Buffer.isBuffer(req.body)) {
        // express.raw only buffers its configured type; anything else arrives as
        // an empty object, which would otherwise be written as a 0-byte file.
        return res.status(415).json({ error: 'Expected a raw application/octet-stream body' });
      }
      const out = uploads.writeUpload({
        entry: req._upload.entry,
        device: req._upload.device,
        name: req.query.name,
        mime: req.query.mime,
        buffer: req.body,
        now: Date.now(),
      });
      if (!out.ok) return res.status(out.status).json({ error: out.error });
      log('info', 'upload stored', { path: out.path, bytes: out.bytes });
      res.json({ path: out.path, bytes: out.bytes, mime: out.mime });
    }
  );

  // Body-parser failures on the upload route (an over-limit body arrives as
  // `entity.too.large`). Express's default handler renders an HTML page, which
  // the phone's fetch cannot parse — answer JSON instead.
  app.use('/api/upload', (err, req, res, _next) => {
    const status = (err && err.status) || 400;
    res
      .status(status)
      .json({ error: err && err.type === 'entity.too.large' ? 'File too large' : 'Upload failed' });
  });

  const tlsOptions = TLS_ENABLED
    ? { key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CERT_FILE) }
    : null;
  const httpServer = tlsOptions ? https.createServer(tlsOptions, app) : http.createServer(app);
  const wss = new WebSocketServer({
    server: httpServer,
    verifyClient: originAllowed,
    // Legit messages are tiny (input ≤64KiB, hello key ≤2KiB, auth sig ~96B) —
    // cap the frame size so a rogue can't push a 100MiB (default) frame and OOM.
    maxPayload: 1 << 20,
  });
  wss.on('error', (err) => console.error('WebSocketServer error:', err.message));

  // Keepalive: ping all clients every 30s, terminate if no pong by next interval.
  // ws library auto-replies to protocol-level ping frames with pong.
  const keepaliveInterval = setInterval(() => {
    wss.clients.forEach((client) => {
      if (client._airprompt_alive === false) {
        client.terminate();
        return;
      }
      client._airprompt_alive = false;
      client.ping();
    });
  }, 30000);
  wss.on('connection', (client) => {
    client._airprompt_alive = true;
    client.on('pong', () => {
      client._airprompt_alive = true;
    });
  });
  httpServer.on('close', () => clearInterval(keepaliveInterval));
  keepaliveInterval.unref(); // server background timer — must not hold the process open

  const _wsConnByIp = new Map(); // remoteAddress -> open connection count

  wss.on('connection', (ws) => {
    // Cap concurrent sockets — a rogue can open unbounded connections (no auth
    // needed), each holding buffers/fds until the handshake times out.
    if (wss.clients.size > 32) {
      // The rejected socket can still emit 'error' (malformed frame) before it
      // fully closes; without a listener that throws and kills the daemon.
      ws.on('error', () => {});
      ws.terminate(); // not close(): a non-responsive peer would linger in CLOSING and defeat the cap
      return;
    }

    // Per-IP connection cap — one device can't monopolize the global slots by
    // reconnecting in a loop (a single LAN attacker could otherwise hold all 32).
    const wsIp = (ws._socket && ws._socket.remoteAddress) || 'unknown';
    if ((_wsConnByIp.get(wsIp) || 0) >= 8) {
      ws.on('error', () => {});
      ws.terminate(); // not close(): a non-responsive peer would linger in CLOSING and defeat the cap
      return;
    }
    _wsConnByIp.set(wsIp, (_wsConnByIp.get(wsIp) || 0) + 1);

    let ptyProcess = null;
    let activeSessionId = null;
    let authed = false; // set true once the handshake verifies
    let _authPublicKey = null; // device pubkey awaiting `auth` reply
    let _authNonce = null; // server nonce the device must sign
    const clientId = Math.random().toString(36).slice(2, 8);
    let _inputQueue = []; // buffer input arriving before PTY is spawned
    let _inputQueueBytes = 0; // total bytes in _inputQueue
    const INPUT_QUEUE_MAX = 200; // max messages
    const INPUT_QUEUE_BYTES_MAX = 1 << 20; // 1 MiB per connection
    log('info', 'ws client connected', { clientId });

    ws.on('error', (e) => {
      log('warn', 'ws client error', { clientId, error: e.message });
    });

    // Close silent sockets that never complete the handshake. Acceptance:
    // unauthenticated WS → closed. The browser client reconnects + handshakes
    // in well under this window.
    const authTimeout = setTimeout(() => {
      if (!authed) {
        try {
          ws.send(JSON.stringify({ type: 'auth_error', reason: 'timeout' }));
        } catch (_) {}
        // terminate() not close(): a non-responsive peer never completes a
        // graceful close, so close() would leave the slot stuck in CLOSING.
        ws.terminate();
      }
    }, 5000);
    authTimeout.unref(); // per-connection timeout — must not hold the process open

    // No session_list on connect — the handshake must complete first.

    function spawnPty(sessionId) {
      // Capture old pty reference before killing — its onExit/onData
      // callbacks fire asynchronously after kill(). Must compare by
      // identity, not the shared ptyProcess variable, to avoid
      // nullifying a newly-spawned pty.
      const oldPty = ptyProcess;
      if (oldPty) {
        const oldWeb = oldPty._airpromptWebSession;
        try {
          oldPty.kill();
        } catch (e) {
          /* ok */
        }
        ptyProcess = null;
        // Kill old webSession — prevents orphan session accumulation
        if (oldWeb) spawnSync('tmux', ['kill-session', '-t', oldWeb], { timeout: 1000 });
      }
      const entry = sessions.get(sessionId);
      if (!entry) return false;

      activeSessionId = sessionId;
      entry.lastActivity = Date.now();
      const termCols = ws._airpromptCols || 120;
      const termRows = ws._airpromptRows || 40;

      // Per-client grouped tmux session. Prefix with random suffix
      // to prevent Date.now() collisions in same-millisecond spawns.
      const rnd = Math.random().toString(36).slice(2, 6);
      const webSession = `airprompt-web-${sessionId}-${Date.now()}-${rnd}`;

      const r1 = spawnSync(
        'tmux',
        [
          'new-session',
          '-d',
          '-t',
          entry.tmuxSession,
          '-s',
          webSession,
          '-x',
          String(termCols),
          '-y',
          String(termRows),
        ],
        { timeout: 2000 }
      );
      if (r1.status !== 0) {
        log('warn', 'tmux new-session failed', {
          clientId,
          webSession,
          status: r1.status,
          stderr: String(r1.stderr || '').trim(),
        });
        if (ws.readyState === 1)
          ws.send(JSON.stringify({ type: 'error', message: 'Failed to create terminal session' }));
        return false;
      }
      spawnSync('tmux', ['set-option', '-t', webSession, 'status', 'off'], { timeout: 1000 });
      spawnSync('tmux', ['set-option', '-t', webSession, 'pane-border-status', 'off'], {
        timeout: 1000,
      });

      let thisPty;
      try {
        thisPty = pty.spawn('tmux', ['attach-session', '-t', webSession], {
          name: 'xterm-256color',
          cols: termCols,
          rows: termRows,
          cwd: entry.cwd,
          env: process.env,
        });
      } catch (e) {
        log('error', 'pty spawn failed', { clientId, webSession, error: e.message });
        try {
          spawnSync('tmux', ['kill-session', '-t', webSession], { timeout: 1000 });
        } catch (_) {}
        if (ws.readyState === 1)
          ws.send(JSON.stringify({ type: 'error', message: 'Failed to create terminal session' }));
        return false;
      }
      thisPty._airpromptWebSession = webSession;
      ptyProcess = thisPty;
      log('info', 'pty spawned', {
        clientId,
        webSession,
        sessionId,
        cols: termCols,
        rows: termRows,
      });

      thisPty.onData((data) => {
        // Guard: only forward data from the currently-active pty
        if (ptyProcess !== thisPty || ws.readyState !== 1) return;
        ws.send(JSON.stringify({ type: 'output', data }));
      });
      thisPty.onExit(({ exitCode, signal }) => {
        log('info', 'pty exited', { clientId, webSession, exitCode, signal: signal || 0 });
        // Guard: only clean up if THIS pty is still the active one
        if (ptyProcess !== thisPty) return;
        if (ws.readyState === 1) {
          try {
            ws.send(
              JSON.stringify({
                type: 'output',
                data: '\r\n\x1b[33m[AirPrompt: session ended]\x1b[0m\r\n',
              })
            );
          } catch (_) {}
        }
        ptyProcess = null;
        // Kill the per-client grouped tmux session — otherwise detaching or
        // exiting leaves an orphan airprompt-web-* session grouped to the
        // live parent, invisible to the stale sweep.
        try {
          spawnSync('tmux', ['kill-session', '-t', thisPty._airpromptWebSession], {
            timeout: 1000,
          });
        } catch (_) {}
        // Discard queued input — stale keystrokes from dead session must
        // not replay into a freshly spawned PTY.
        _inputQueue = [];
        _inputQueueBytes = 0;
      });

      // Notify client that PTY is ready
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'pty_spawned', sessionId }));
      // Flush any input queued before PTY was spawned
      if (_inputQueue.length > 0) {
        for (const d of _inputQueue) {
          try {
            thisPty.write(d);
          } catch (e) {
            /* ok */
          }
        }
        log('info', 'flushed queued input', { clientId, count: _inputQueue.length });
        _inputQueue = [];
        _inputQueueBytes = 0;
      }
      return true;
    }

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e) {
        log('debug', 'ws malformed message', { clientId, raw: String(raw).slice(0, 100) });
        return;
      }

      // Only the handshake messages are accepted before authentication.
      // Anything else from an unauthenticated socket is rejected + closed.
      if (!authed && msg.type !== 'hello' && msg.type !== 'auth') {
        ws.send(JSON.stringify({ type: 'auth_error', reason: 'unauthorized' }));
        ws.close();
        return;
      }

      switch (msg.type) {
        case 'hello': {
          // Mutual challenge-response, step 1: the device presents its public
          // key; if whitelisted, the server replies with its own key + a
          // signature over BOTH nonces (server identity, bound to this
          // connection — not a free signing oracle over arbitrary input).
          if (
            authed ||
            typeof msg.publicKey !== 'string' ||
            msg.publicKey.length > 2048 ||
            typeof msg.nonce !== 'string' ||
            msg.nonce.length > 256
          ) {
            ws.send(JSON.stringify({ type: 'auth_error', reason: 'bad_hello' }));
            ws.close();
            break;
          }
          if (!auth.deviceByPublicKey(msg.publicKey)) {
            ws.send(JSON.stringify({ type: 'auth_error', reason: 'unauthorized' }));
            ws.close();
            break;
          }
          const serverKey = auth.loadOrCreateServerKey();
          const serverNonce = auth.generateNonce();
          _authPublicKey = msg.publicKey;
          _authNonce = serverNonce;
          ws.send(
            JSON.stringify({
              type: 'challenge',
              serverPublicKey: serverKey.publicKeyDer.toString('base64'),
              nonce: serverNonce,
              signature: auth.signNonce(serverNonce + msg.nonce, serverKey.privateKey),
            })
          );
          break;
        }
        case 'auth': {
          // Step 2: the device signs the server's nonce; verify and grant.
          if (
            authed ||
            typeof msg.signature !== 'string' ||
            msg.signature.length > 512 ||
            !_authNonce ||
            !_authPublicKey
          ) {
            ws.send(JSON.stringify({ type: 'auth_error', reason: 'bad_auth' }));
            ws.close();
            break;
          }
          // Re-check the whitelist — the device may have been revoked in the
          // brief window between `hello` and `auth`. Capture the canonical key
          // so revoke detection compares canonical-to-canonical.
          const dev = auth.deviceByPublicKey(_authPublicKey);
          if (!dev) {
            ws.send(JSON.stringify({ type: 'auth_error', reason: 'unauthorized' }));
            ws.close();
            break;
          }
          if (auth.verifyNonce(_authNonce, msg.signature, _authPublicKey)) {
            authed = true;
            ws._airpromptAuthed = true; // unlock broadcasts (session_list/notify)
            ws._airpromptPublicKey = dev.publicKey; // canonical — so revoke can close this socket
            clearTimeout(authTimeout);
            auth.markDeviceSeen(_authPublicKey);
            ws.send(JSON.stringify({ type: 'auth_ok' }));
            ws.send(
              JSON.stringify({
                type: 'session_list',
                sessions: Array.from(sessions.values()).map((s) => sessionToJSON(s)),
              })
            );
            log('info', 'ws client authenticated', { clientId });
          } else {
            ws.send(JSON.stringify({ type: 'auth_error', reason: 'bad_auth' }));
            ws.close();
          }
          break;
        }
        case 'ping':
          // Keepalive reply — the client's dead-connection watchdog needs a
          // pong back to confirm the receive path is alive (send-only pings
          // prove nothing when the downlink dies first).
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'pong' }));
          break;
        case 'debug':
          log('debug', '[client] ' + (msg.msg || ''), { level: msg.level, extra: msg.extra });
          break;
        case 'input':
          if (!msg.data) break;
          if (typeof msg.data !== 'string') break; // reject non-string payloads
          // Reject oversized input — prevents OOM from a single large payload.
          // 64 KiB per message protects against paste-bombs on LAN.
          if (msg.data.length > 65536) break;
          if (ptyProcess) {
            try {
              const inputData = msg.data;
              if (inputData.indexOf('\n') !== -1) {
                // Multi-line input: paste via tmux buffer with bracketed paste
                // so newlines are literal, not "Enter" (which submits mid-text).
                // Named buffer avoids clobbering the user's default copy buffer.
                spawnSync('tmux', ['load-buffer', '-b', 'airprompt-input', '-'], {
                  input: inputData,
                  encoding: 'utf8',
                  timeout: 2000,
                });
                spawnSync(
                  'tmux',
                  [
                    'paste-buffer',
                    '-p',
                    '-b',
                    'airprompt-input',
                    '-t',
                    ptyProcess._airpromptWebSession,
                  ],
                  { timeout: 2000 }
                );
              } else {
                ptyProcess.write(inputData);
              }
            } catch (e) {
              /* ok */
            }
            const activeEntry = activeSessionId ? sessions.get(activeSessionId) : null;
            if (activeEntry) activeEntry.lastActivity = Date.now();
            // A submitted prompt releases this device's pending uploads: the
            // files stay readable for a grace window (a still-running turn may
            // read them late), then the sweep reaps them. Only '\r' submits — a
            // payload containing '\n' was handled above as a literal newline
            // (bracketed paste), never an Enter.
            if (msg.data.indexOf('\r') !== -1 && msg.data.indexOf('\n') === -1) {
              uploads.releaseForDevice(activeEntry, ws._airpromptPublicKey, { now: Date.now() });
            }
          } else {
            // PTY not spawned yet — buffer input so it's not lost.
            // Flushed after spawnPty() succeeds.
            // Capped by count AND bytes to prevent OOM from a single
            // connection sending large payloads.
            if (
              _inputQueue.length < INPUT_QUEUE_MAX &&
              _inputQueueBytes + msg.data.length <= INPUT_QUEUE_BYTES_MAX
            ) {
              _inputQueue.push(msg.data);
              _inputQueueBytes += msg.data.length;
            }
          }
          break;
        case 'upload_token': {
          // Mint the one-time token that authenticates the LAN upload POST. Only
          // an authenticated device reaches here, and the token is bound to that
          // device's key plus the session it targets.
          if (typeof msg.sessionId !== 'string' || !sessions.has(msg.sessionId)) {
            ws.send(JSON.stringify({ type: 'upload_token_error', reason: 'session_not_found' }));
            break;
          }
          const token = uploads.mintToken(ws._airpromptPublicKey, msg.sessionId, Date.now());
          ws.send(
            JSON.stringify(
              token
                ? { type: 'upload_token', token: token }
                : { type: 'upload_token_error', reason: 'too_many_tokens' }
            )
          );
          break;
        }
        case 'switch_session':
          if (msg.sessionId && sessions.has(msg.sessionId)) spawnPty(msg.sessionId);
          else ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
          break;
        case 'kill_session':
          // The browser kills over the authenticated WS (REST is loopback-only).
          if (typeof msg.sessionId === 'string') {
            killSessionById(msg.sessionId, wss)
              .then((result) => {
                if (ws.readyState === 1)
                  ws.send(
                    JSON.stringify({ type: 'kill_result', sessionId: msg.sessionId, ...result })
                  );
              })
              .catch((err) => {
                if (ws.readyState === 1)
                  ws.send(
                    JSON.stringify({
                      type: 'kill_result',
                      sessionId: msg.sessionId,
                      ok: false,
                      error: err.message,
                    })
                  );
              });
          }
          break;
        case 'resize':
          if (
            ptyProcess &&
            typeof msg.cols === 'number' &&
            typeof msg.rows === 'number' &&
            msg.cols > 0 &&
            msg.cols <= 500 &&
            msg.rows > 0 &&
            msg.rows <= 200
          ) {
            ws._airpromptCols = msg.cols;
            ws._airpromptRows = msg.rows;
            try {
              ptyProcess.resize(msg.cols, msg.rows);
            } catch (e) {
              /* ok */
            }
          }
          break;
        case 'list_sessions':
          broadcastSessionList(wss);
          break;
        case 'copy_buffer':
          // Cap the string (mirrors the client's 128KiB cap) — a rogue paired
          // client shouldn't drive a 1MiB tmux load-buffer either.
          if (
            typeof msg.data === 'string' &&
            msg.data.length > 0 &&
            msg.data.length <= 128 * 1024
          ) {
            try {
              spawnSync('tmux', ['load-buffer', '-'], {
                input: msg.data,
                encoding: 'utf8',
                timeout: 2000,
              });
            } catch (e) {
              /* ok */
            }
          }
          break;
        case 'paste_buffer':
          if (ptyProcess) {
            try {
              const result = spawnSync('tmux', ['save-buffer', '-'], {
                encoding: 'utf8',
                timeout: 2000,
              });
              if (result.status === 0 && result.stdout) {
                ptyProcess.write(result.stdout);
              }
            } catch (e) {
              /* ok */
            }
          }
          break;
      }
    });

    ws.on('close', () => {
      const n = (_wsConnByIp.get(wsIp) || 0) - 1;
      if (n <= 0) _wsConnByIp.delete(wsIp);
      else _wsConnByIp.set(wsIp, n);
      clearTimeout(authTimeout);
      log('info', 'ws client disconnected', { clientId, activeSessionId });
      _inputQueue = [];
      _inputQueueBytes = 0; // discard queued input
      if (ptyProcess) {
        const wsess = ptyProcess._airpromptWebSession;
        try {
          ptyProcess.kill();
        } catch (e) {
          /* ok */
        }
        ptyProcess = null;
        if (wsess) spawnSync('tmux', ['kill-session', '-t', wsess], { timeout: 2000 });
      }
    });
  });

  const ORPHAN_GRACE_MS = 120_000; // 2 minutes grace before killing orphan mirrors

  const staleInterval = setInterval(() => {
    if (runStaleSweep(sessions, { log }) > 0) broadcastSessionList(wss);
    // Uploads ride the same pass: one cleanup authority, driven by ground truth
    // (is the session's tmux still alive), so every death path — kill, unregister,
    // `airprompt off`, a crashed turn, the hook sweeps — converges here.
    const reaped = uploads.sweepUploads({ log });
    if (reaped.removedFiles || reaped.removedDirs) log('debug', 'uploads swept', reaped);
  }, STALE_CHECK_MS);

  httpServer.on('close', () => clearInterval(staleInterval));
  staleInterval.unref();

  // Push pairing-request lifecycle to authenticated web clients so their
  // "wants to pair" notices appear (pair_request) and auto-clean on
  // allow/deny/expire (pair_resolved). The CLI resolves on the filesystem
  // (disk is the source of truth), so we poll for both appearance and removal.
  const PAIR_POLL_MS = parseInt(process.env.AIRPROMPT_PAIR_POLL_MS || '2000', 10);
  let _knownPendingIds = new Set(auth.listPending().map((p) => p.id));
  const pairInterval = setInterval(() => {
    const pending = auth.listPending(); // evicts expired
    const current = new Map(pending.map((p) => [p.id, p]));
    const currentIds = new Set(current.keys());
    const devices = auth.listDevices();
    for (const [id, p] of current) {
      if (!_knownPendingIds.has(id)) {
        broadcastAuthed(
          wss,
          JSON.stringify({
            type: 'pair_request',
            id,
            seq: p.seq,
            name: p.name,
            fingerprint: p.fingerprint,
          })
        );
      }
    }
    for (const id of _knownPendingIds) {
      if (!currentIds.has(id)) {
        const status = devices.some((d) => d.id === id) ? 'allowed' : 'closed';
        broadcastAuthed(wss, JSON.stringify({ type: 'pair_resolved', id, status }));
      }
    }
    _knownPendingIds = currentIds;

    // Revoked devices: drop their live sockets so `auth revoke` takes effect
    // immediately. Direct per-socket check (not a delta over prior snapshots),
    // so a device added+revoked within one poll window is still caught.
    const deviceKeys = new Set(devices.map((d) => d.publicKey));
    for (const client of wss.clients) {
      if (
        client._airpromptAuthed &&
        client._airpromptPublicKey &&
        !deviceKeys.has(client._airpromptPublicKey)
      ) {
        // Revocation must also kill in-flight uploads: drop the device's
        // outstanding upload tokens, not just its socket.
        uploads.dropTokensForDevice(client._airpromptPublicKey);
        try {
          client.close(4001, 'device revoked');
        } catch (_) {}
      }
    }
  }, PAIR_POLL_MS);
  httpServer.on('close', () => clearInterval(pairInterval));
  pairInterval.unref();

  return { app, httpServer, wss, tlsOptions };
}

module.exports = { createApp, sessions, isLoopback };

if (require.main === module) {
  try {
    const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (pidAlive(existingPid)) {
      console.error(`AirPrompt already running (PID ${existingPid}).`);
      process.exit(1);
    }
    removePid();
  } catch (e) {
    /* ok */
  }

  writePid();
  writeDaemonJson(TLS_ENABLED ? 'https' : 'http', PORT, getLocalIp());
  log('info', 'daemon starting', { port: PORT, pid: process.pid, tls: TLS_ENABLED, debug: DEBUG });
  // Rebuild session registry from on-disk markers BEFORE listen
  // so first WS client sees recovered sessions immediately.
  recoverSessionsFromDisk();
  const { httpServer, tlsOptions: tls } = createApp();

  httpServer.listen(PORT, '0.0.0.0', () => {
    const lanIp = getLocalIp();
    const serverKey = auth.loadOrCreateServerKey();
    const url = `${tls ? 'https' : 'http'}://${lanIp}:${PORT}/#fp=${serverKey.fingerprint}`;
    console.log('\n' + '='.repeat(50));
    console.log(`AirPrompt Server running at: ${url}`);
    console.log(`Server fingerprint: ${serverKey.fingerprint}`);
    if (tls) console.log('TLS: self-signed (accept warning on first connect)');
    console.log('='.repeat(50) + '\n');
    qrcode.generate(url, { small: true });
  });

  httpServer.on('error', (err) => {
    console.error(`Server error: ${err.message}`);
    removePid();
    removeDaemonJson();
    process.exit(1);
  });
  function gracefulShutdown(signal) {
    log('info', 'daemon shutting down', { signal, sessions: sessions.size });
    removePid();
    removeDaemonJson();
    process.exit(0);
  }
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));
  process.on('exit', () => {
    removePid();
    removeDaemonJson();
  });
}
