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

// ── One-finger touch → synthetic wheel scroll (rAF-batched) ───────────
// xterm.js has poor mobile touch support (xtermjs/xterm.js#5377).
// iOS Safari: scroll fails completely if touch starts on rendered text
// (xtermjs/xterm.js#3613).
//
// Strategy: intercept one-finger vertical touch in capture phase, batch
// deltas via requestAnimationFrame, dispatch one WheelEvent per frame.
// Without rAF batching, every touchmove (60fps) dispatches a tiny wheel
// event synchronously. xterm's scrollLines() triggers main-thread layout
// + repaint, so 60 small events/sec choke the main thread → scroll feels
// progressively slower. Batching produces fewer, larger wheel events —
// same pattern as a real mouse wheel on desktop.
(function () {
  var container = document.getElementById('terminal-container');
  var viewport = container.querySelector('.xterm-viewport');
  var lastY = 0;
  var accumDY = 0;
  var scrollActive = false;
  var rafId = null;

  container.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) {
      scrollActive = false;
      return;
    }
    scrollActive = true;
    lastY = e.touches[0].clientY;
    accumDY = 0;
  }, { passive: true, capture: true });

  function flushScroll() {
    if (!scrollActive) { rafId = null; return; }
    if (accumDY !== 0 && viewport) {
      viewport.dispatchEvent(new WheelEvent('wheel', {
        deltaY: accumDY * 8,
        deltaMode: 0,
        bubbles: true,
        cancelable: true,
      }));
      accumDY = 0;
    }
    rafId = requestAnimationFrame(flushScroll);
  }

  container.addEventListener('touchmove', function (e) {
    if (!scrollActive || e.touches.length !== 1) return;
    var dy = lastY - e.touches[0].clientY;
    lastY = e.touches[0].clientY;
    accumDY += dy;
    // Dead zone: skip preventDefault for tiny movements so taps still
    // synthesize click events for keyboard focus on mobile.
    if (Math.abs(accumDY) < 4) return;
    e.preventDefault();
    if (!rafId) {
      rafId = requestAnimationFrame(flushScroll);
    }
  }, { passive: false, capture: true });

  container.addEventListener('touchend', function () {
    scrollActive = false;
    lastY = 0;
    accumDY = 0;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }, { passive: true, capture: true });

  container.addEventListener('touchcancel', function () {
    scrollActive = false;
    lastY = 0;
    accumDY = 0;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }, { passive: true, capture: true });
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

// ── DOM refs ────────────────────────────────────────────────────────
const sessionBar = document.getElementById('session-bar');
const sessionLabel = document.getElementById('session-label');
const dictateBtn = document.getElementById('dictate-btn');
const dictateIcon = document.getElementById('dictate-icon');
const dictateLabel = document.getElementById('dictate-label');
const sessionModal = document.getElementById('session-modal');
const sessionList = document.getElementById('session-list');
const modalClose = document.getElementById('modal-close');
const micError = document.getElementById('mic-error');
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
  var sent = 0;
  for (var i = 0; i < _pendingMessages.length; i++) {
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

      // Valid active session with PTY already spawned — nothing to do
      if (activeSessionId && sessions.some((s) => s.id === activeSessionId) && !_needPtySpawn) {
        break;
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
  var keybarEl = document.getElementById('keybar-container');
  function refit() {
    try { fitAddon.fit(); } catch (_) {}
    // Force xterm canvas repaint — prevents "black screen" after resize
    try { term.refresh(0, term.rows - 1); } catch (_) {}
    var vp = document.querySelector('#terminal-container .xterm-viewport');
    if (vp) { vp.scrollTop = vp.scrollHeight; }
    // Restore focus so native keyboard stays open on mobile.
    // fitAddon.fit() can blur xterm's hidden textarea, dismissing the
    // virtual keyboard. On mobile, focus the invisible input instead
    // of xterm's readonly textarea.
    var mi = document.getElementById('mobile-input');
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

  var kb = window._airpromptKeybar;
  if (!kb || !kb.hasAnyModifier || !kb.hasAnyModifier()) {
    send({ type: 'input', data });
    return;
  }

  // ── Ctrl+Shift+C → copy selection to remote tmux buffer ──────────
  // ── Ctrl+Shift+V → paste from remote tmux buffer ─────────────────
  if (kb.isCopyPasteCombo && kb.isCopyPasteCombo(data)) {
    if (data === 'c') {
      // Copy: grab xterm.js selection, send to server → tmux load-buffer
      var sel = term.getSelection();
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
      var vh = window.visualViewport.height;
      var termContainer = document.getElementById('terminal-container');
      var viewport = termContainer && termContainer.querySelector('.xterm-viewport');
      var lh = window.innerHeight;
      var kbHeight = lh - vh;
      var sessionBar = document.getElementById('session-bar');
      var barH = sessionBar ? sessionBar.offsetHeight : 44;
      var overlayH = dictateOverlay.classList.contains('dictate-hidden') ? 0 : dictateOverlay.offsetHeight;
      var keybarEl = document.getElementById('keybar-container');
      var keybarH = (keybarEl && !keybarEl.classList.contains('keybar-hidden')) ? keybarEl.offsetHeight : 0;

      // Only react to significant height drops (keyboard open)
      if (kbHeight > 80) {
        var termH = vh - window.visualViewport.offsetTop - barH - overlayH - keybarH;
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

// ── Voice Dictation ─────────────────────────────────────────────────
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let isListening = false;
let isPaused = false;          // Long-tap while recording → pause
let _stopPending = false;     // Guard: ignore taps while stop is in-flight
let _pauseGen = 0;            // Prevents stale onend restart after pause→resume
let _onendGen = 0;            // Prevents stale onend from pauseDictation() restarting
let dictationAccumulator = '';   // Persists across recognition restarts (Chrome Android)

// ── Dictation overlay DOM ────────────────────────────────────────────
const dictateOverlay  = document.getElementById('dictate-overlay');
const dictateText     = document.getElementById('dictate-text');
const dictateAccept   = document.getElementById('dictate-accept');
const dictateAcceptSend = document.getElementById('dictate-accept-send');
const dictateCancel   = document.getElementById('dictate-cancel');

// ── i18n: labels change with selected language ────────────────────────
const T = {
  'en-US': {
    dictate: 'Dictate', recording: 'Recording', paused: 'Paused',
    cancel: 'Cancel', accept: 'Accept', send: 'Send',
    listening: 'Listening…', speaking: '● Speaking…',
    noSession: 'No session selected', noActive: 'No active sessions',
    activeSessions: 'Active Sessions', close: 'Close', refresh: 'Refresh',
    micHttps: 'Voice needs HTTPS or localhost. Chrome blocks mic on HTTP LAN IP. Use keyboard below.',
    langFallback: 'Language not supported. Falling back to English.',
    disconnected: '⚠️ DISCONNECTED — Tap to dismiss',
  },
  'es-AR': {
    dictate: 'Dictar', recording: 'Grabando', paused: 'Pausado',
    cancel: 'Cancelar', accept: 'Aceptar', send: 'Enviar',
    listening: 'Escuchando…', speaking: '● Hablando…',
    noSession: 'Sin sesión', noActive: 'Sin sesiones activas',
    activeSessions: 'Sesiones Activas', close: 'Cerrar', refresh: 'Recargar',
    micHttps: 'El micrófono requiere HTTPS o localhost. Chrome bloquea el mic en IPs LAN HTTP.',
    langFallback: 'Idioma no soportado. Cambiando a inglés.',
    disconnected: '⚠️ DESCONECTADO — Tocar para cerrar',
  },
};

function tr(key) {
  return (T[currentLang] && T[currentLang][key]) || T['en-US'][key] || key;
}

function updateAllLabels() {
  // Dictate button (stopped state)
  if (!isListening && !isPaused) {
    dictateLabel.textContent = tr('dictate');
  } else if (isPaused) {
    dictateLabel.textContent = tr('paused');
  } else {
    dictateLabel.textContent = tr('recording');
  }
  // Overlay buttons
  dictateCancel.textContent = tr('cancel');
  dictateAccept.textContent = tr('accept');
  dictateAcceptSend.textContent = tr('send');
  langCancel.textContent = tr('cancel');
  // CSS pseudo-elements via custom properties
  dictateText.style.setProperty('--listen-text', '"' + tr('listening') + '"');
  dictateText.style.setProperty('--speak-text', '"' + tr('speaking') + '"');
  // Modal
  document.querySelector('#session-modal-content h3').textContent = tr('activeSessions');
  document.getElementById('modal-close').textContent = tr('close');
  // Refresh button title
  document.getElementById('refresh-btn').title = tr('refresh');
  // Session label (if no session)
  if (sessionLabel.classList.contains('no-session')) {
    sessionLabel.textContent = tr('noSession');
  }
  // Dictation disabled label
  if (!SpeechRecognition) {
    dictateLabel.textContent = tr('dictate');
  }
}

// Update CSS placeholder texts via custom properties
const _i18nStyle = document.createElement('style');
_i18nStyle.textContent = '\n' +
  '#dictate-text:empty::after { content: var(--listen-text, "Listening\\2026"); }\n' +
  '#dictate-overlay.speaking #dictate-text:empty::after { content: var(--speak-text, "\\25cf Speaking\\2026"); }\n';
document.head.appendChild(_i18nStyle);

// ── Language management ──────────────────────────────────────────────
const BASE_LANGS = [
  { code: 'en-US', name: 'English (US)' },
  { code: 'es-AR', name: 'Español (AR)' },
];

const dictateFlag   = document.getElementById('dictate-flag');
const langDropdown  = document.getElementById('lang-dropdown');
const langList      = document.getElementById('lang-list');
const langCancel    = document.getElementById('lang-cancel');

function langToFlag(code) {
  const parts = code.split('-');
  const region = parts[parts.length - 1].toUpperCase();
  if (!region || region.length !== 2) return code.toUpperCase();
  try {
    return String.fromCodePoint(
      0x1F1E6 + region.charCodeAt(0) - 65,
      0x1F1E6 + region.charCodeAt(1) - 65
    );
  } catch {
    return code.toUpperCase();
  }
}

function normalizeLang(code) {
  if (!code || !code.includes('-')) {
    const map = { en: 'en-US', es: 'es-AR', fr: 'fr-FR', de: 'de-DE',
                  pt: 'pt-BR', it: 'it-IT', ja: 'ja-JP', zh: 'zh-CN', ko: 'ko-KR' };
    code = map[code] || (code || 'en-US');
  }
  return code;
}

let currentLang = normalizeLang(
  localStorage.getItem('airprompt-lang') || navigator.language || 'en-US'
);

function resolveLanguageList() {
  const langs = [...BASE_LANGS];
  const addIfMissing = (code) => {
    if (!langs.some(l => l.code === code)) {
      langs.unshift({ code, name: code + ' (browser)' });
    }
  };
  const browserLang = navigator.language;
  if (browserLang) addIfMissing(normalizeLang(browserLang));
  // Also include currentLang if it came from localStorage and differs
  if (currentLang && !langs.some(l => l.code === currentLang)) {
    langs.unshift({ code: currentLang, name: currentLang + ' (saved)' });
  }
  return langs;
}

function buildLangList() {
  const langs = resolveLanguageList();
  langList.innerHTML = '';
  langs.forEach(lang => {
    const el = document.createElement('div');
    el.className = 'lang-option' + (lang.code === currentLang ? ' active' : '');
    el.innerHTML = '<span class="lang-flag">' + langToFlag(lang.code) +
                   '</span> ' + lang.name;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      setLang(lang.code);
      hideLangDropdown();
    });
    langList.appendChild(el);
  });
}

function updateFlag() {
  dictateFlag.textContent = langToFlag(currentLang);
}

let _langSwitchGen = 0;

function setLang(code) {
  currentLang = code;
  localStorage.setItem('airprompt-lang', code);
  const wasListening = isListening;
  const gen = ++_langSwitchGen;
  if (wasListening) {
    isListening = false;
    recognition.stop();
  }
  recognition.lang = code;
  updateFlag();
  buildLangList();
  updateAllLabels();
  if (wasListening) {
    setTimeout(() => {
      // Only restart if no newer lang switch happened
      if (gen !== _langSwitchGen) return;
      isListening = true;
      _safeRecognitionStart();
      dictateBtn.classList.add('recording');
      dictateIcon.textContent = '🔴';
      dictateLabel.textContent = tr('recording');
    }, 200);
  }
}

function showLangDropdown() {
  buildLangList();
  langDropdown.classList.remove('dropdown-hidden');
}

function hideLangDropdown() {
  langDropdown.classList.add('dropdown-hidden');
}

// ── Recognition setup ───────────────────────────────────────────────
if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.lang = currentLang;
  recognition.interimResults = true;
  // Chrome Android ignores continuous:true (MDN bug #23458).
  // It auto-stops after each utterance — our onend restarts it.
  // onresult only fires after pauses, never during continuous speech.
  recognition.continuous = true;

  recognition.onresult = (event) => {
    // Reconstruct from ALL results within this event.
    let running = '';
    let latestInterim = '';

    for (let i = 0; i < event.results.length; i++) {
      const result = event.results[i];
      const transcript = result[0].transcript;

      if (result.isFinal) {
        if (result[0].confidence === 0) continue;
        // Case-insensitive check — Chrome may change casing between results
        if (running && transcript.length >= running.length && transcript.slice(0, running.length).localeCompare(running, undefined, { sensitivity: 'base' }) === 0) {
          running = transcript;
        } else {
          running += transcript;
        }
      } else {
        latestInterim = transcript;
      }
    }

    // Chrome Android ignores continuous:true — recognition restarts
    // after each utterance via onend, losing prior text. Accumulate
    // across sessions so user sees incremental progress.
    if (running) {
      if (dictationAccumulator && running.length >= dictationAccumulator.length && running.slice(0, dictationAccumulator.length).localeCompare(dictationAccumulator, undefined, { sensitivity: 'base' }) === 0) {
        // Desktop Chrome: cumulative, already includes prior (case-insensitive)
        dictationAccumulator = running;
      } else if (dictationAccumulator) {
        // Chrome Android: new segment after pause/restart — add comma
        // and lowercase first char so sentence flows naturally
        const lower = running.charAt(0).toLowerCase() + running.slice(1);
        dictationAccumulator = (dictationAccumulator + ', ' + lower).trim();
      } else {
        // First utterance
        dictationAccumulator = running;
      }
    }

    // Skip if overlay was dismissed — prevents stale onresult from
    // writing into hidden overlay after acceptDictation cleared it.
    if (dictateOverlay.classList.contains('dictate-hidden')) return;

    const displayText = latestInterim || dictationAccumulator;
    if (displayText) {
      dictateText.textContent = displayText;
      dictateText.style.height = 'auto';
      const h = dictateText.scrollHeight;
      dictateText.style.height = Math.min(h, window.innerHeight * 0.3) + 'px';
      // Always scroll to bottom so latest text is visible
      dictateText.scrollTop = dictateText.scrollHeight;
    }
  };

  // Chrome Android: these fire during active speech even though
  // onresult only fires after pauses. Give real-time visual feedback.
  recognition.onspeechstart = () => {
    dictateOverlay.classList.add('speaking');
  };
  recognition.onspeechend = () => {
    dictateOverlay.classList.remove('speaking');
  };

  recognition.onstart = () => {
    // Recognition actually started — sync UI state defensively.
    // Only correct if we're supposed to be listening but UI is wrong.
    if (isListening && !dictateBtn.classList.contains('recording')) {
      isPaused = false;
      dictateBtn.classList.remove('paused');
      dictateBtn.classList.add('recording');
      dictateIcon.textContent = '🔴';
      dictateLabel.textContent = tr('recording');
    }
  };

  recognition.onerror = (e) => {
    if (e.error === 'not-allowed') {
      // Fatal — dismiss everything
      isListening = false;
      _stopPending = false;
      dismissOverlay();
      dictateBtn.classList.remove('recording');
      dictateBtn.disabled = true;
      dictateIcon.textContent = '🔇';
      dictateLabel.textContent = tr('dictate');
      micError.style.display = 'block';
      micError.textContent = tr('micHttps');
    } else if (e.error === 'language-not-supported') {
      setLang('en-US');
      micError.style.display = 'block';
      micError.textContent = tr('langFallback');
      setTimeout(() => { micError.style.display = 'none'; }, 3000);
      // Don't dismiss overlay — keep accumulating text
    } else {
      // Transient (no-speech, audio-capture, network) — onend will restart
      // Keep overlay visible, don't change isListening
    }
  };

  recognition.onend = () => {
    dictateOverlay.classList.remove('speaking');
    // Only restart if the recognition session created this onend is still
    // the active one. Prevents stale onend from pauseDictation() restarting
    // after resumeDictation() already started a fresh session.
    const myGen = _onendGen;
    if (isListening && myGen === _onendGen && !_stopPending) _safeRecognitionStart();
  };

  updateFlag();
  buildLangList();
  updateAllLabels();
} else {
  dictateIcon.textContent = '🚫';
  dictateLabel.textContent = tr('dictate');
  dictateBtn.disabled = true;
}

// ── Safe recognition start — guards against InvalidStateError ─────────
// Chrome throws InvalidStateError if start() is called while the
// recognizer is still in the 'stopping' state — a real race on
// fast pause→resume or lang-switch→restart cycles.
function _safeRecognitionStart() {
  try { recognition.start(); return true; }
  catch (e) {
    // Resync UI state: recognition is dead, not listening
    isListening = false;
    isPaused = false;
    dictateBtn.classList.remove('recording', 'paused');
    dictateIcon.textContent = '🎤';
    dictateLabel.textContent = tr('dictate');
    log('warn', 'recognition.start() failed', { error: e.message });
    return false;
  }
}

function toggleDictation(e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  if (!recognition) return;
  hideLangDropdown();

  if (isListening) {
    // STOP: let final onresult fire before accepting
    isListening = false;
    _stopPending = true;
    recognition.stop();
    dictateBtn.classList.remove('recording');
    dictateIcon.textContent = '🎤';
    dictateLabel.textContent = tr('dictate');
    // Defer accept — recognition.stop() queues final onresult async.
    // We need that to update dictateText before reading it.
    setTimeout(() => { _stopPending = false; acceptDictation(); }, 150);
  } else if (_stopPending) {
    // Ignore taps during stop → accept transition
    return;
  } else {
    // START: show empty overlay. Close native keyboard so dictation
    // overlay is visible and mic button is reachable.
    if (window._airpromptBlurMobileInput) window._airpromptBlurMobileInput();
    isListening = true;
    dictationAccumulator = '';
    dictateOverlay.classList.remove('dictate-hidden');
    dictateText.textContent = '';
    dictateText.style.height = '';
    _safeRecognitionStart();
    dictateBtn.classList.add('recording');
    dictateIcon.textContent = '🔴';
    dictateLabel.textContent = tr('recording');
  }
}

function acceptDictation() {
  _stopPending = false;
  const text = dictateText.textContent.trim();
  if (isListening) {
    isListening = false;
    recognition.abort();
    dictateBtn.classList.remove('recording');
    dictateIcon.textContent = '🎤';
    dictateLabel.textContent = tr('dictate');
  }
  if (text) {
    send({ type: 'input', data: text });
  }
  dictationAccumulator = '';
  dismissOverlay();
}

function cancelDictation() {
  _stopPending = false;
  if (isListening) {
    isListening = false;
    recognition.abort();
    dictateBtn.classList.remove('recording');
    dictateIcon.textContent = '🎤';
    dictateLabel.textContent = tr('dictate');
  }
  dictationAccumulator = '';
  dismissOverlay();
}

function dismissOverlay() {
  isPaused = false;
  dictateBtn.classList.remove('paused');
  dictateOverlay.classList.add('dictate-hidden');
  dictateText.textContent = '';
  dictateText.style.height = '';
}

function acceptAndSend() {
  _stopPending = false;
  const text = dictateText.textContent.trim();
  if (isListening) {
    isListening = false;
    recognition.abort();
    dictateBtn.classList.remove('recording');
    dictateIcon.textContent = '🎤';
    dictateLabel.textContent = tr('dictate');
  }
  if (text) {
    send({ type: 'input', data: text });
    // Small delay so PTY delivers text to shell before \r arrives.
    // Without this, the two writes can merge in the PTY buffer — the
    // shell echoes the text but readline doesn't process \r as submit.
    setTimeout(function () {
      send({ type: 'input', data: '\r' });
    }, 50);
  }
  dictationAccumulator = '';
  dismissOverlay();
}

dictateAccept.addEventListener('click', function(e) {
  e.stopPropagation();
  acceptDictation();
});

dictateAcceptSend.addEventListener('click', function(e) {
  e.stopPropagation();
  acceptAndSend();
});

dictateCancel.addEventListener('click', function(e) {
  e.stopPropagation();
  cancelDictation();
});

// Pointer events:
//   short tap stopped  → start recording
//   short tap recording → stop + accept
//   short tap paused    → resume recording
//   long-tap stopped  → language dropdown
//   long-tap recording → pause
//   long-tap paused    → resume

let longTapTimer = null;
let longTapFired = false;

// Block click from bubbling to session-bar (would open modal)
dictateBtn.addEventListener('click', (e) => { e.stopPropagation(); });

// ── Long-tap action (shared by touch + pointer branches) ──────────
function onLongTap() {
  longTapFired = true;
  if (_stopPending) {
    // Ignore — stop is in-flight
  } else if (isListening) {
    pauseDictation();
  } else if (isPaused) {
    resumeDictation();
  } else {
    showLangDropdown();
  }
  if (navigator.vibrate) navigator.vibrate(12);
}

function onShortTap(e) {
  if (isPaused) {
    resumeDictation();
  } else {
    toggleDictation(e);
  }
}

var _useTouch = false;
try { _useTouch = window.matchMedia('(pointer: coarse)').matches; } catch (_) {}

if (_useTouch) {
  // Mobile: touch events. touchcancel fires INSTEAD of touchend on
  // Android long tap — clean separation. Pointer events are unreliable:
  // Chrome fires pointerup BEFORE pointercancel on many devices, making
  // it impossible to distinguish short tap from long tap.

  // Android long-press fires touchcancel instead of touchend.
  // For a genuine long-press, the timer already fired (longTapFired=true).
  // For aborted gestures (scroll starting on the button), clear the timer
  // so it doesn't trigger long-tap actions after the gesture ends.
  var _touchStartT = 0;
  dictateBtn.addEventListener('touchstart', function (e) {
    e.stopPropagation();
    longTapFired = false;
    _touchStartT = Date.now();
    clearTimeout(longTapTimer);
    longTapTimer = setTimeout(onLongTap, 500);
  });

  dictateBtn.addEventListener('touchend', function (e) {
    e.stopPropagation();
    if (longTapFired) return;
    clearTimeout(longTapTimer);
    onShortTap(e);
  });

  dictateBtn.addEventListener('touchcancel', function () {
    // If long-press already fired → nothing to do (longTapFired gate handles it).
    // If aborted before 500ms → clear timer (it was a scroll/swipe, not a long-tap).
    if (!longTapFired && Date.now() - _touchStartT < 500) {
      clearTimeout(longTapTimer);
    }
  });

  dictateBtn.addEventListener('contextmenu', function (e) {
    e.preventDefault();
  });
} else {
  // Desktop: pointer events work correctly
  dictateBtn.addEventListener('pointerdown', function (e) {
    e.stopPropagation();
    longTapFired = false;
    clearTimeout(longTapTimer);
    longTapTimer = setTimeout(onLongTap, 500);
  });

  dictateBtn.addEventListener('pointerup', function (e) {
    e.stopPropagation();
    if (longTapFired) return;
    clearTimeout(longTapTimer);
    onShortTap(e);
  });

  dictateBtn.addEventListener('pointerleave', function () {
    clearTimeout(longTapTimer);
  });
  dictateBtn.addEventListener('pointercancel', function () {
    clearTimeout(longTapTimer);
  });
}

// ── Pause / Resume ────────────────────────────────────────────────────

function pauseDictation() {
  if (!isListening) return;
  isListening = false;
  isPaused = true;
  _onendGen++;  // Mark this onend as stale
  recognition.stop();
  dictateBtn.classList.remove('recording');
  dictateBtn.classList.add('paused');
  dictateIcon.textContent = '⏸';
  dictateLabel.textContent = tr('paused');
}

function resumeDictation() {
  if (!isPaused) return;
  isPaused = false;
  isListening = true;
  _onendGen++;  // Prevent stale onend from pauseDictation from restarting
  _safeRecognitionStart();
  dictateBtn.classList.remove('paused');
  dictateBtn.classList.add('recording');
  dictateIcon.textContent = '🔴';
  dictateLabel.textContent = tr('recording');
}

// Close dropdown on outside click
document.addEventListener('click', (e) => {
  if (!langDropdown.classList.contains('dropdown-hidden') &&
      !dictateBtn.contains(e.target) &&
      !langDropdown.contains(e.target)) {
    hideLangDropdown();
  }
});

langCancel.addEventListener('click', (e) => {
  e.stopPropagation();
  hideLangDropdown();
});


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
  var inputEl = document.getElementById('mobile-input');
  var isMobile = false;
  try { isMobile = window.matchMedia('(pointer: coarse)').matches; } catch (_) {}

  if (!isMobile || !inputEl) return;

  inputEl.classList.add('visible');
  // Expose for dictation: blur to dismiss native keyboard before voice input.
  window._airpromptBlurMobileInput = function () { inputEl.blur(); };
  var _prev = '';                // tracks input value as code-point array
  var _enterTimer = null;        // debounce timer — resolves single vs double tap
  var DOUBLE_ENTER_MS = 400;     // max gap between Enter taps to submit

  // Prevent xterm.js textarea from stealing focus — we manage input
  // ourselves. Hide it visually (still in DOM for xterm internals).
  var _xtermTA = document.querySelector('.xterm-helper-textarea');
  if (_xtermTA) {
    _xtermTA.setAttribute('readonly', '');
    _xtermTA.style.opacity = '0';
    _xtermTA.style.pointerEvents = 'none';
  }

  // Document-level focus guard: any time focus lands on xterm's hidden
  // textarea, redirect to our mobile input. This catches ALL cases —
  // xterm.js internal focus(), rapid taps, race conditions, etc.
  // No timing-based workaround needed.
  document.addEventListener('focusin', function (e) {
    var tag = e.target.tagName;
    if (tag === 'TEXTAREA' && e.target.closest('.xterm')) {
      e.preventDefault();
      e.stopPropagation();
      inputEl.focus();
    }
  });

  // Focus input bar when tapping terminal area
  document.getElementById('terminal-container').addEventListener('click', function () {
    var kb = window._airpromptKeybar;
    if (kb && kb.suppressDisarm) kb.suppressDisarm(500);
    inputEl.focus();
  });

  // ── Helpers: code-point-aware string ops (emoji-safe) ─────────────

  // Route mobile input through keybar modifier pipeline so one-shot
  // Ctrl/Alt/Shift apply to native-keyboard keystrokes.
  // Also checks copy/paste combo BEFORE modifier application so
  // Ctrl+Shift+C/V from mobile input works like term.onData.
  function _sendWithModifiers(data) {
    var kb = window._airpromptKeybar;
    if (kb && kb.isCopyPasteCombo && kb.isCopyPasteCombo(data)) {
      if (data === 'c') {
        var sel = term.getSelection();
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

    var cur = inputEl.value;
    if (cur === _prev) return;

    var prevArr = _prevArr();
    var curArr  = _toArray(cur);
    var prevLen = prevArr.length;
    var curLen  = curArr.length;

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
        var delCount = prevLen - curLen;
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
  var SPECIAL_KEYS = {
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

    var seq = SPECIAL_KEYS[e.key];
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

    // Any non-Enter key cancels the pending \n debounce — the user
    // changed their mind and is now editing.
    if (_enterTimer && e.key !== 'Enter') {
      clearTimeout(_enterTimer);
      _enterTimer = null;
      // Undo the \n we added to _prev/value when the first Enter was tapped.
      if (_prev.endsWith('\n')) {
        _prev = _prev.slice(0, -1);
        inputEl.value = _prev;
      }
    }

    // Handle Ctrl+letter combos from hardware keyboards on mobile.
    // Ctrl alone (not AltGr / Cmd) — mask with 0x1f before sending.
    if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
      e.preventDefault();
      var code = e.key.charCodeAt(0);
      if (code >= 0x20 && code < 0x7f) {
        send({ type: 'input', data: String.fromCharCode(code & 0x1f) });
      }
      return;
    }
  });

  // Initial focus so keyboard opens on page load.
  // xterm.js refocuses its textarea after open/fit — race it with retries.
  var _focusRetries = 5;
  function _initialFocus() {
    inputEl.focus();
    if (document.activeElement !== inputEl && --_focusRetries > 0) {
      setTimeout(_initialFocus, 100);
    }
  }
  setTimeout(_initialFocus, 300);
})();
