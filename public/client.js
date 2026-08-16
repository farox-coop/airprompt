// ── Debug logging (enable with ?debug=1 in URL) ─────────────────────
const urlParams = new URLSearchParams(window.location.search);
const DEBUG = urlParams.get('debug') === '1';
function log(level, msg, extra) {
  if (!DEBUG) return;
  const ts = new Date().toISOString();
  const extraStr = extra ? ' ' + JSON.stringify(extra) : '';
  console.log(`[airprompt:${level}] ${ts} ${msg}${extraStr}`);
  // Forward to server so it appears in server logs too
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'debug', level, msg, extra, ts }));
    }
  } catch (_) { /* ws may be in transient state */ }
}

// ── Terminal ─────────────────────────────────────────────────────────
const term = new window.Terminal({
  cursorBlink: true,
  fontSize: 14,
  scrollback: 10000,
  allowTransparency: false,
  // 1:1 wheel deltas for the normal-screen scroll path (viewport scroll).
  // xterm's default 2 would double every delta.
  scrollSensitivity: 1,
  theme: {
    background: '#0d1117',
    foreground: '#c9d1d9',
    cursor: '#58a6ff',
    black: '#484f58',
    red: '#ff7b72',
    green: '#3fb950',
    yellow: '#d29922',
    blue: '#58a6ff',
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    white: '#b1bac4',
    brightBlack: '#6e7681',
    brightRed: '#ffa198',
    brightGreen: '#56d364',
    brightYellow: '#e3b341',
    brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd',
    brightWhite: '#f0f6fc',
  },
});

// Smart default fontSize: larger on touch devices
const DEFAULT_FONT_SIZE = window.matchMedia('(pointer: coarse)').matches ? 16 : 14;

const fitAddon = new window.FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal-container'));
fitAddon.fit();

// ── Pinch-to-zoom (2-finger only) ─────────────────────────────────────
(function () {
  const ZOOM_MIN = 8;
  const ZOOM_MAX = 24;
  let currentZoom = parseInt(localStorage.getItem('airprompt-font-size'), 10) || DEFAULT_FONT_SIZE;
  term.options.fontSize = currentZoom;

  const container = document.getElementById('terminal-container');
  let startDist = 0, startZoom = 0, pinchActive = false;

  container.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 2) { pinchActive = false; return; }
    pinchActive = true;
    startDist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    startZoom = currentZoom;
  }, { passive: true });

  container.addEventListener('touchmove', function (e) {
    if (!pinchActive || e.touches.length !== 2) return;
    const dist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    if (Math.abs(dist - startDist) < 10) return;
    e.preventDefault();
    const newSize = Math.round(startZoom * dist / startDist);
    const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newSize));
    if (clamped !== currentZoom) {
      currentZoom = clamped;
      term.options.fontSize = clamped;
      fitAddon.fit();
    }
  }, { passive: false });

  container.addEventListener('touchend', function () {
    if (pinchActive) {
      currentZoom = term.options.fontSize;
      localStorage.setItem('airprompt-font-size', currentZoom);
      scheduleResize();
    }
    pinchActive = false;
  });
})();

// ── Resize debounce ────────────────────────────────────────────────────
let resizeTimer = null;
function scheduleResize() {
  fitAddon.fit();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    send({ type: 'resize', cols: term.cols, rows: term.rows });
  }, 200);
}

// Send initial size so server spawns pty matching viewport
setTimeout(scheduleResize, 300);
window.addEventListener('resize', scheduleResize);

const Dictation = window.Dictation;
function tr(key) { return Dictation.tr(key); }

// ── DOM refs ────────────────────────────────────────────────────────
const sessionBar = document.getElementById('session-bar');
const sessionLabel = document.getElementById('session-label');
const sessionModal = document.getElementById('session-modal');
const sessionList = document.getElementById('session-list');
const modalClose = document.getElementById('modal-close');
const loadSpinner = document.getElementById('load-spinner');

function hideLoadSpinner() {
  if (loadSpinner) loadSpinner.classList.add('hidden');
}

// ── State ───────────────────────────────────────────────────────────
const SESSION_STORAGE_KEY = 'airprompt-active-session';
let sessions = [];
let activeSessionId = localStorage.getItem(SESSION_STORAGE_KEY) || null;
let _needPtySpawn = true;  // true when WS (re)connects — PTY not yet spawned

// ── Input buffer: queue messages when WS not OPEN, prevent silent drops ──
// Capped at MAX_PENDING to prevent unbounded memory on long disconnects.
const MAX_PENDING = 200;  // matches server INPUT_QUEUE_MAX
let _pendingMessages = [];
let _inputSeq = 0;  // monotonic counter for input messages

// ── WebSocket with auto-reconnect ────────────────────────────────────
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
let ws = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let pingTimer = null;
const PING_INTERVAL_MS = 25_000;  // Keepalive — mobile browsers drop idle WS
const MAX_RECONNECT_MS = 30_000;

function wsUrl() { return `${protocol}//${window.location.host}`; }

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  ws = new WebSocket(wsUrl());
  log('info', 'ws connecting', { url: wsUrl() });

  ws.onopen = () => {
    log('info', 'ws connected');
    reconnectAttempts = 0;
    _needPtySpawn = true;  // new connection — PTY must be re-spawned
    // Dismiss disconnect banner on reconnect
    if (window._airpromptDiscBanner) {
      if (window._airpromptDiscBanner.parentNode) {
        window._airpromptDiscBanner.remove();
      }
      window._airpromptDiscBanner = null;
    }
    // Re-send resize so server re-spawns pty with correct dimensions
    scheduleResize();
    // Flush any input queued during disconnect/reconnect window
    _flushPending();
    // Keepalive — ws library auto-responds to ping frames
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'ping' })); } catch (_) {}
      }
    }, PING_INTERVAL_MS);
  };

  ws.onmessage = wsMessageHandler;

  ws.onclose = () => {
    log('warn', 'ws disconnected');
    hideLoadSpinner();  // spinner blocks banner at z-index 500 — must hide
    term.write('\r\n\x1b[31m[AirPrompt: disconnected]\x1b[0m\r\n');
    // Stop ping timer
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    // Overlay banner — stays until clicked or reconnected
    if (!window._airpromptDiscBanner) {
      const banner = document.createElement('div');
      banner.textContent = tr('disconnected');
      Object.assign(banner.style, {
        position: 'fixed', top: '0', left: '0', right: '0',
        background: '#dc2626', color: '#fff', textAlign: 'center',
        padding: '14px 8px', fontSize: '16px', fontWeight: '700',
        zIndex: '600', cursor: 'pointer',
      });
      banner.addEventListener('click', () => {
        if (banner.parentNode) banner.remove();
        window._airpromptDiscBanner = null;
      });
      document.body.appendChild(banner);
      window._airpromptDiscBanner = banner;
    }
    scheduleReconnect();
  };

  ws.onerror = () => { /* onclose fires next; reconnect handled there */ };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_MS);
  reconnectAttempts++;
  log('info', 'reconnecting', { attempt: reconnectAttempts, delay });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// Kick off first connection
connect();

function send(msg) {
  // Tag input messages with monotonic seq — debug tracing + future ack.
  if (msg.type === 'input') msg.seq = ++_inputSeq;
  // Always enqueue so messages survive transient WS states and reconnects.
  _pendingMessages.push(msg);
  if (_pendingMessages.length > MAX_PENDING) _pendingMessages.shift();
  _flushPending();
}

function _flushPending() {
  if (!ws || ws.readyState !== WebSocket.OPEN || _pendingMessages.length === 0) return;
  // Drain queue in order. If a send throws (unlikely for WS), stop —
  // remaining messages stay in queue for next flush attempt.
  let sent = 0;
  for (let i = 0; i < _pendingMessages.length; i++) {
    try { ws.send(JSON.stringify(_pendingMessages[i])); sent++; }
    catch (e) { break; }
  }
  if (sent > 0) _pendingMessages.splice(0, sent);
}

// Expose for keybar.js
window._airpromptSend = send;

// ── Message handler (detached for reconnect) ─────────────────────────
function wsMessageHandler(event) {
  let msg;
  try { msg = JSON.parse(event.data); } catch (e) { return; }

  switch (msg.type) {
    case 'output':
      term.write(msg.data);
      break;
    case 'notification':
      if (typeof showNotification === 'function') showNotification(msg);
      break;
    case 'session_list':
      sessions = msg.sessions || [];
      hideLoadSpinner();  // Always hide spinner — even with zero sessions
      updateUI();

      // Valid active session with PTY already spawned — nothing to do.
      // Unless server-side PTY died (attachedClients=0) — re-spawn it.
      if (activeSessionId && sessions.some((s) => s.id === activeSessionId) && !_needPtySpawn) {
        const cur = sessions.find(function(s) { return s.id === activeSessionId; });
        if (cur && cur.attachedClients === 0) _needPtySpawn = true;
        else break;
      }

      // Try restore persisted session, else fall back to first
      const storedId = localStorage.getItem(SESSION_STORAGE_KEY);
      if (storedId && sessions.some((s) => s.id === storedId)) {
        selectSession(storedId);
      } else if (sessions.length > 0) {
        localStorage.removeItem(SESSION_STORAGE_KEY);
        selectSession(sessions[0].id);
      }
      break;
    case 'error':
      console.error('Server error:', msg.message);
      if (msg.message === 'Session not found') {
        activeSessionId = null;
        localStorage.removeItem(SESSION_STORAGE_KEY);
      }
      updateUI();
      break;
    default:
      break;
  }
}

// ── Session UI ──────────────────────────────────────────────────────
function sessionDisplayLabel(s) {
  return s.name || s.cwd;
}

function updateUI() {
  const s = sessions.find((s) => s.id === activeSessionId);
  if (activeSessionId && s) {
    if (s.name) {
      sessionLabel.innerHTML = `<span class="name">${escHtml(s.name)}</span><span class="cwd">${escHtml(s.cwd)}</span>`;
    } else {
      sessionLabel.textContent = s.cwd;
    }
    sessionLabel.classList.remove('no-session');
  } else {
    sessionLabel.textContent = tr('noSession');
    sessionLabel.classList.add('no-session');
  }

  // Session list in modal
  if (sessions.length === 0) {
    sessionList.innerHTML = '<div class="session-empty">' + tr('noActive') + '</div>';
  } else {
    sessionList.innerHTML = sessions
      .map((s) => {
        const activeClass = s.id === activeSessionId ? ' active' : '';
        const time = new Date(s.createdAt).toLocaleString();
        const label = escHtml(sessionDisplayLabel(s));
        const cwd = s.name ? escHtml(s.cwd) : '';
        const escId = escHtml(s.id);
        const subHtml = cwd ? `<div class="cwd">${cwd}</div>` : '';
        return `<button class="session-item${activeClass}" data-id="${escId}">
          <div class="name">${label}</div>
          ${subHtml}
          <div class="sid">${escHtml(s.id)}</div>
          <div class="time">${escHtml(time)}</div>
          <span class="session-kill" data-id="${escId}" title="Kill session" role="button" tabindex="0">🗑️</span>
        </button>`;
      })
      .join('');
    // Bind click handlers — single handler on session-item.
    // .session-kill is nested inside <button>; mobile browsers route
    // the click to the button regardless of stopPropagation. Instead
    // we check e.target.closest('.session-kill') to decide the action.
    sessionList.querySelectorAll('.session-item').forEach((el) => {
      el.addEventListener('click', function (e) {
        if (e.target.closest('.session-kill')) {
          if (!confirm('Kill session ' + el.dataset.id + '?')) return;
          killSession(el.dataset.id);
          return;
        }
        selectSession(el.dataset.id);
      });
    });
  }
}

async function killSession(sessionId) {
  let btn;
  try { btn = document.querySelector('.session-kill[data-id="' + CSS.escape(sessionId) + '"]'); }
  catch (e) { return; }  // invalid sessionId chars → bail
  if (!btn) return;
  btn.classList.add('killing');
  btn.textContent = '⏳';
  try {
    const resp = await fetch('/api/sessions/kill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId }),
    });
    const data = await resp.json();
    if (data.ok) {
      // session_list broadcast will refresh UI automatically.
      // If it was the active session, deselect.
      if (activeSessionId === sessionId) {
        activeSessionId = null;
        localStorage.removeItem(SESSION_STORAGE_KEY);
      }
      // session_list broadcast will rebuild the list, removing this button
    } else {
      log('warn', 'kill session rejected', { sessionId: sessionId, status: resp.status, error: data.error });
      btn.classList.remove('killing');
      btn.textContent = '🗑️';
    }
  } catch (err) {
    log('error', 'kill session failed', { sessionId: sessionId, error: err.message });
    btn.classList.remove('killing');
    btn.textContent = '🗑️';
  }
}

function selectSession(id) {
  log('info', 'switching session', { from: activeSessionId, to: id });
  activeSessionId = id;
  localStorage.setItem(SESSION_STORAGE_KEY, id);
  _needPtySpawn = false;  // switch_session will trigger server-side PTY spawn
  send({ type: 'switch_session', sessionId: id });
  closeModal();
  updateUI();
  hideLoadSpinner();
}

// ── Modal ───────────────────────────────────────────────────────────
function openModal() {
  sessionModal.classList.add('open');
}

function closeModal() {
  sessionModal.classList.remove('open');
}

sessionBar.addEventListener('click', openModal);
modalClose.addEventListener('click', closeModal);
document.getElementById('keybar-toggle').addEventListener('click', function (e) {
  e.stopPropagation();
  window._airpromptKeybar && window._airpromptKeybar.toggle();
  // Keybar has 0.2s CSS transition. Fit + scroll after it finishes.
  const keybarEl = document.getElementById('keybar-container');
  function refit() {
    try { fitAddon.fit(); } catch (_) {}
    // Force xterm canvas repaint — prevents "black screen" after resize
    try { term.refresh(0, term.rows - 1); } catch (_) {}
    const vp = document.querySelector('#terminal-container .xterm-viewport');
    if (vp) { vp.scrollTop = vp.scrollHeight; }
    // Restore focus so native keyboard stays open on mobile.
    // fitAddon.fit() can blur xterm's hidden textarea, dismissing the
    // virtual keyboard. On mobile, focus the invisible input instead
    // of xterm's readonly textarea.
    const mi = document.getElementById('mobile-input');
    if (mi && mi.classList.contains('visible')) { try { mi.focus(); } catch (_) {} }
    else { try { term.focus(); } catch (_) {} }
  }
  if (keybarEl) {
    keybarEl.addEventListener('transitionend', function () {
      refit();
    }, { once: true });
  }
  // Fallback: also fit after next paint cycle in case transitionend
  // doesn't fire (e.g. prefers-reduced-motion disables transitions)
  requestAnimationFrame(function () {
    requestAnimationFrame(refit);
  });
});
sessionModal.addEventListener('click', (e) => {
  if (e.target === sessionModal) closeModal();
});

// Show :active feedback on session bar only for direct touches,
// not when tapping Dictate/Refresh buttons inside it.
// CSS :active propagates to ancestors — impossible to stop with JS.
// We drive it manually instead.
sessionBar.addEventListener('pointerdown', function(e) {
  if (e.target === sessionBar || sessionBar.contains(e.target)) {
    // Only show if the touch landed on the bar label/spacer, not a button
    if (e.target.closest('button')) return;
    sessionBar.classList.add('bar-active');
  }
});
document.addEventListener('pointerup', function() {
  sessionBar.classList.remove('bar-active');
});
sessionBar.addEventListener('pointerleave', function() {
  sessionBar.classList.remove('bar-active');
});

// ── Terminal input → WebSocket ──────────────────────────────────────
// Route through keybar modifiers: if Ctrl/Alt/Shift are active on the
// on-screen keyboard, apply them to native-keyboard input before sending.
// Ctrl+Shift+C / Ctrl+Shift+V operate on the REMOTE tmux buffer, never
// the local browser clipboard.

term.onData((data) => {
  // Skip empty/ghost events — focus/blur on mobile fires spurious
  // onData with empty string, which would disarm one-shot modifiers.
  if (!data) return;

  const kb = window._airpromptKeybar;
  if (!kb || !kb.hasAnyModifier || !kb.hasAnyModifier()) {
    send({ type: 'input', data });
    return;
  }

  // ── Ctrl+Shift+C → copy selection to remote tmux buffer ──────────
  // ── Ctrl+Shift+V → paste from remote tmux buffer ─────────────────
  if (kb.isCopyPasteCombo && kb.isCopyPasteCombo(data)) {
    if (data === 'c') {
      // Copy: grab xterm.js selection, send to server → tmux load-buffer
      const sel = term.getSelection();
      if (sel) send({ type: 'copy_buffer', data: sel });
    } else if (data === 'v') {
      // Paste: server reads tmux save-buffer → writes to PTY
      send({ type: 'paste_buffer' });
    }
    if (kb.disarmCopyPaste) kb.disarmCopyPaste();
    return;
  }

  // Normal modifier application (Ctrl/Alt masking)
  kb.applyModifiers(data).then(function (modified) {
    if (modified) send({ type: 'input', data: modified });
  });
});

// ── Mobile keyboard viewport fix ─────────────────────────────────────
// On mobile, the virtual keyboard overlays or shrinks the viewport.
// xterm.js's hidden textarea doesn't trigger native scroll-into-view
// on focus, so the prompt hides behind the keyboard until first keypress.
//
// Fix: listen to visualViewport.resize. When the keyboard opens (viewport
// shrinks significantly), constrain the terminal container height to the
// visible area, re-fit rows, and scroll the viewport to show the prompt.
// When the keyboard closes, restore the natural flex layout.
let _vvhPrev = 0;
let _vvhRaf = 0;
if (window.visualViewport) {
  _vvhPrev = window.visualViewport.height;
  window.visualViewport.addEventListener('resize', function () {
    if (_vvhRaf) return;
    _vvhRaf = requestAnimationFrame(function () {
      _vvhRaf = 0;
      const vh = window.visualViewport.height;
      const termContainer = document.getElementById('terminal-container');
      const viewport = termContainer && termContainer.querySelector('.xterm-viewport');
      const lh = window.innerHeight;
      const kbHeight = lh - vh;
      const sessionBar = document.getElementById('session-bar');
      const barH = sessionBar ? sessionBar.offsetHeight : 44;
      const overlayH = Dictation.getOverlayHeight();
      const keybarEl = document.getElementById('keybar-container');
      const keybarH = (keybarEl && !keybarEl.classList.contains('keybar-hidden')) ? keybarEl.offsetHeight : 0;

      // Only react to significant height drops (keyboard open)
      if (kbHeight > 80) {
        const termH = vh - window.visualViewport.offsetTop - barH - overlayH - keybarH;
        termContainer.style.height = termH + 'px';
        termContainer.style.flex = 'none';
        try { fitAddon.fit(); } catch (_) {}
        if (viewport && viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 100) {
          viewport.scrollTop = viewport.scrollHeight;
        }
      } else if (kbHeight < 20 && _vvhPrev > 0 && window.visualViewport.height - _vvhPrev > 40) {
        // Keyboard dismissed: restore natural layout
        termContainer.style.height = '';
        termContainer.style.flex = '';
        try { fitAddon.fit(); } catch (_) {}
      }
      _vvhPrev = window.visualViewport.height;
    });
  });
}

// ── Dictation — delegated to dictation.js ─────────────────────────────
Dictation.init({ send: function(m) { send(m); }, log: log, blurInput: function() {
  if (window._airpromptBlurMobileInput) window._airpromptBlurMobileInput();
}, sessionLabel: sessionLabel });
function tr(key) { return Dictation.tr(key); }
// ── Refresh button ────────────────────────────────────────────────────
document.getElementById('refresh-btn').addEventListener('click', function (e) {
  e.preventDefault(); e.stopPropagation();
  location.reload();
});

// ── Mobile input bar ──────────────────────────────────────────────────
// On touch devices, a real <input> captures keyboard input instead of
// xterm.js's hidden textarea. Android IME (Gboard) works correctly with
// real <input> elements — autocorrect, autocomplete, and per-character
// events all function. xterm.js's textarea has a known Android IME bug
// (xtermjs/xterm.js#3600) that drops characters during composition.
//
// The input bar shows what the user typed. Each character change is
// forwarded to the PTY immediately, and the echo appears in xterm.js
// (read-only display). On Enter, the text is committed + \r sent.
// The invisible textarea captures all keyboard input on touch devices —
(function () {
  const inputEl = document.getElementById('mobile-input');
  let isMobile = false;
  try { isMobile = window.matchMedia('(pointer: coarse)').matches; } catch (_) {}

  if (!isMobile || !inputEl) return;

  inputEl.classList.add('visible');
  // Expose for dictation: blur to dismiss native keyboard before voice input.
  window._airpromptBlurMobileInput = function () { inputEl.blur(); };
  let _prev = '';                // tracks input value as code-point array
  let _enterTimer = null;        // debounce timer — resolves single vs double tap
  const DOUBLE_ENTER_MS = 400;   // max gap between Enter taps to submit

  // Prevent xterm.js textarea from stealing focus — we manage input
  // ourselves. Hide it visually (still in DOM for xterm internals).
  // PERMANENT monkey-patch: xterm's textarea.focus() is a noop.
  // Our #mobile-input handles ALL keyboard events — xterm's textarea
  // is readonly + invisible + pointer-events:none. xterm only calls
  // .focus() to steal focus on mousedown, which kills the keyboard.
  // With the noop, xterm still processes clicks (cursor positioning
  // via internal mousedown handler) but can never steal focus.
  const _xtermTA = document.querySelector('.xterm-helper-textarea');
  if (_xtermTA) {
    _xtermTA.setAttribute('readonly', '');
    _xtermTA.style.opacity = '0';
    _xtermTA.style.pointerEvents = 'none';
    _xtermTA.focus = function () {};
  }

  // ── Tap-to-focus: only open keyboard when tapping the prompt area ──
  //
  // Uses xterm.js APIs for prompt-zone detection:
  //
  //   1. _core._mouseService.getMouseReportCoords(ev, el) — private but
  //      stable (used by VS Code; xterm collaborator jerch, disc #4380).
  //
  //   2. term.buffer.active.getLine(y).translateToString() — public API
  //      (since v3.14). Scan upward from cursorY for the ❯ marker.
  //
  // 'click' event fires after the full mousedown→mouseup→click sequence,
  // when event dispatch is complete. xterm has already updated its
  // internal cursor position by then. focus() from 'click' works cleanly
  // because no event dispatch is in progress — unlike pointerdown where
  // the browser is still processing the touch.
  //
  // ❯ not found in buffer → use cursorY ± 4 rows as zone.
  document.getElementById('terminal-container').addEventListener('click', function (ev) {
    // ── Step 1: get the viewport row of the tap ──────────────────
    const coords = term._core._mouseService.getMouseReportCoords(ev, term.element);
    if (!coords || typeof coords.row !== 'number') return;
    const tapRow = coords.row;

    // ── Step 2: find the prompt start line (❯ marker) ───────────
    const buf = term.buffer.active;
    const cursorBufY = buf.cursorY;
    const viewportY = buf.viewportY;
    let promptStartBufY = cursorBufY;
    let found = false;

    for (let y = cursorBufY; y >= Math.max(0, cursorBufY - 30); y--) {
      const line = buf.getLine(y);
      if (line) {
        const text = line.translateToString(true);
        if (text.indexOf('❯') !== -1) {
          promptStartBufY = y;
          found = true;
          break;
        }
      }
    }

    if (!found) {
      promptStartBufY = Math.max(0, cursorBufY - 4);
    }

    // ── Step 3: focus if tap is within the prompt zone ──────────
    const promptStartRow = promptStartBufY - viewportY;
    const cursorRow = cursorBufY - viewportY;

    if (tapRow >= promptStartRow && tapRow <= cursorRow) {
      inputEl.focus();
    } else {
      // Outside prompt zone — blur our input so keyboard closes.
      // _xtermTA.focus is a noop, so xterm can't steal focus; we must
      // explicitly release it. Without this, inputEl stays focused
      // after the first prompt tap and keyboard never closes on output taps.
      inputEl.blur();
    }
  });


  // ── Helpers: code-point-aware string ops (emoji-safe) ─────────────

  // Route mobile input through keybar modifier pipeline so one-shot
  // Ctrl/Alt/Shift apply to native-keyboard keystrokes.
  // Also checks copy/paste combo BEFORE modifier application so
  // Ctrl+Shift+C/V from mobile input works like term.onData.
  function _sendWithModifiers(data) {
    const kb = window._airpromptKeybar;
    if (kb && kb.isCopyPasteCombo && kb.isCopyPasteCombo(data)) {
      if (data === 'c') {
        const sel = term.getSelection();
        if (sel) send({ type: 'copy_buffer', data: sel });
      } else if (data === 'v') {
        send({ type: 'paste_buffer' });
      }
      if (kb.disarmCopyPaste) kb.disarmCopyPaste();
      return;
    }
    if (kb && kb.applyModifiers) {
      kb.applyModifiers(data).then(function (modified) {
        if (modified) send({ type: 'input', data: modified });
      });
    } else {
      send({ type: 'input', data: data });
    }
  }

  function _toArray(s) { return Array.from(s); }
  function _join(a)   { return a.join(''); }
  function _prevArr() { return _toArray(_prev); }

  inputEl.addEventListener('input', function () {
    // Any real input cancels the pending Enter \n timer — user is editing.
    if (_enterTimer) {
      clearTimeout(_enterTimer);
      _enterTimer = null;
    }

    const cur = inputEl.value;
    if (cur === _prev) return;

    const prevArr = _prevArr();
    const curArr  = _toArray(cur);
    const prevLen = prevArr.length;
    const curLen  = curArr.length;

    if (curLen > prevLen) {
      // Characters added — route through keybar modifier pipeline
      // so one-shot Ctrl/Alt/Shift apply to native-keyboard input.
      if (cur.lastIndexOf(_prev, 0) === 0) {
        _sendWithModifiers(cur.slice(_prev.length));
      } else {
        // Insertion not at end (autocorrect, IME replacement mid-text).
        if (prevLen) send({ type: 'input', data: '\x7f'.repeat(prevLen) });
        _sendWithModifiers(cur);
      }
    } else if (curLen < prevLen) {
      // Characters deleted — modifiers don't apply to backspace.
      if (_prev.lastIndexOf(cur, 0) === 0) {
        const delCount = prevLen - curLen;
        send({ type: 'input', data: '\x7f'.repeat(delCount) });
      } else {
        // Deletion not from end (selected text then typed over, etc.).
        if (prevLen) send({ type: 'input', data: '\x7f'.repeat(prevLen) });
        if (cur) _sendWithModifiers(cur);
      }
    } else {
      // Same length, different content (IME replacement / autocorrect).
      if (prevLen) send({ type: 'input', data: '\x7f'.repeat(prevLen) });
      _sendWithModifiers(cur);
    }

    _prev = cur;
  });

  // Special keys that don't produce visible characters or may not
  // trigger the input event. Mapped to terminal escape sequences.
  const SPECIAL_KEYS = {
    Backspace: '\x7f',
    Delete: '\x1b[3~',
    Tab: '\t',
    ArrowUp: '\x1b[A',
    ArrowDown: '\x1b[B',
    ArrowRight: '\x1b[C',
    ArrowLeft: '\x1b[D',
    Home: '\x1b[H',
    End: '\x1b[F',
    Escape: '\x1b',
  };

  inputEl.addEventListener('keydown', function (e) {
    // Ignore keydown during IME composition — Gboard and other IMEs fire
    // spurious keydown events (Backspace, Delete, arrow keys) mid-composition.
    // Processing them corrupts _prev state and sends stray control chars.
    if (e.isComposing) return;

    // Cancel pending Enter debounce for non-Enter special keys
    // (Backspace, arrows, etc.) — user changed their mind mid-edit.
    if (_enterTimer && e.key !== 'Enter') {
      clearTimeout(_enterTimer);
      _enterTimer = null;
      if (_prev.endsWith('\n')) {
        _prev = _prev.slice(0, -1);
        inputEl.value = _prev;
      }
    }

    const seq = SPECIAL_KEYS[e.key];
    if (seq) {
      e.preventDefault();
      send({ type: 'input', data: seq });
      // Sync textarea for keys that change visible content.
      // preventDefault suppresses the input event, so we update state directly.
      if (e.key === 'Backspace' && _prev.length > 0) {
        _prev = _join(_prevArr().slice(0, -1));
        inputEl.value = _prev;
      }
      if (e.key === 'Tab') {
        _prev += '\t';
        inputEl.value = _prev;
      }
      return;
    }

    if (e.key === 'Enter') {
      // Ignore Enter during IME composition — Gboard fires keydown with
      // isComposing=true when the user taps a suggestion or commits text.
      // Without this guard, composition commits are misread as double-tap
      // and the line submits before the user intended.
      if (e.isComposing) return;

      // Double-tap debounce: first Enter queues \n after 400ms,
      // second Enter cancels timer and sends \r (submit).
      // Any input or non-Enter keydown cancels the pending \n timer
      // so the shell never gets a stray newline after an accidental Enter.
      if (_enterTimer) {
        e.preventDefault();
        clearTimeout(_enterTimer);
        _enterTimer = null;
        _prev = '';
        inputEl.value = '';
        send({ type: 'input', data: '\r' });
      } else {
        e.preventDefault();
        _prev += '\n';
        inputEl.value = _prev;
        _enterTimer = setTimeout(function () {
          _enterTimer = null;
          send({ type: 'input', data: '\n' });
        }, DOUBLE_ENTER_MS);
      }
      return;
    }

    // Pending Enter debounce already cancelled above — this block only
    // runs for non-Enter, non-SPECIAL_KEYS input, so no additional action.

    // Handle Ctrl+letter combos from hardware keyboards on mobile.
    // Ctrl alone (not AltGr / Cmd) — mask with 0x1f before sending.
    if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
      e.preventDefault();
      const code = e.key.charCodeAt(0);
      if (code >= 0x20 && code < 0x7f) {
        send({ type: 'input', data: String.fromCharCode(code & 0x1f) });
      }
      return;
    }
  });

  // No auto-focus — user must tap input directly to open keyboard.
})();
