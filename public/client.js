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

const fitAddon = new window.FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal-container'));
fitAddon.fit();

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

// ── State ───────────────────────────────────────────────────────────
const SESSION_STORAGE_KEY = 'airprompt-active-session';
let sessions = [];
let activeSessionId = localStorage.getItem(SESSION_STORAGE_KEY) || null;
let _needPtySpawn = true;  // true when WS (re)connects — PTY not yet spawned

// ── WebSocket with auto-reconnect ────────────────────────────────────
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
let ws = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
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
  };

  ws.onmessage = wsMessageHandler;

  ws.onclose = () => {
    log('warn', 'ws disconnected');
    term.write('\r\n\x1b[31m[AirPrompt: disconnected]\x1b[0m\r\n');
    // Overlay banner — stays until clicked or reconnected
    if (!window._airpromptDiscBanner) {
      const banner = document.createElement('div');
      banner.textContent = '⚠️ DISCONNECTED — Tap to dismiss';
      Object.assign(banner.style, {
        position: 'fixed', top: '0', left: '0', right: '0',
        background: '#dc2626', color: '#fff', textAlign: 'center',
        padding: '14px 8px', fontSize: '16px', fontWeight: '700',
        zIndex: '300', cursor: 'pointer',
      });
      banner.addEventListener('click', () => {
        if (banner.parentNode) banner.remove();
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
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ── Message handler (detached for reconnect) ─────────────────────────
function wsMessageHandler(event) {
  let msg;
  try { msg = JSON.parse(event.data); } catch (e) { return; }

  switch (msg.type) {
    case 'output':
      term.write(msg.data);
      break;
    case 'session_list':
      sessions = msg.sessions || [];
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
    sessionLabel.textContent = 'No session selected';
    sessionLabel.classList.add('no-session');
  }

  // Session list in modal
  if (sessions.length === 0) {
    sessionList.innerHTML = '<div class="session-empty">No active sessions</div>';
  } else {
    sessionList.innerHTML = sessions
      .map((s) => {
        const activeClass = s.id === activeSessionId ? ' active' : '';
        const time = new Date(s.createdAt).toLocaleString();
        const label = escHtml(sessionDisplayLabel(s));
        const cwd = s.name ? escHtml(s.cwd) : '';
        const subHtml = cwd ? `<div class="cwd">${cwd}</div>` : '';
        return `<button class="session-item${activeClass}" data-id="${s.id}">
          <div class="name">${label}</div>
          ${subHtml}
          <div class="time">${escHtml(time)}</div>
        </button>`;
      })
      .join('');
    // Bind click handlers
    sessionList.querySelectorAll('.session-item').forEach((el) => {
      el.addEventListener('click', () => selectSession(el.dataset.id));
    });
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
}

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
sessionModal.addEventListener('click', (e) => {
  if (e.target === sessionModal) closeModal();
});

// ── Terminal input → WebSocket ──────────────────────────────────────
term.onData((data) => {
  send({ type: 'input', data });
});

// ── Voice Dictation ─────────────────────────────────────────────────
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let isListening = false;

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.lang = 'en-US';
  recognition.interimResults = false;
  recognition.continuous = true;

  recognition.onresult = (event) => {
    const transcript = event.results[event.results.length - 1][0].transcript;
    if (transcript.trim()) {
      send({ type: 'input', data: transcript });
    }
  };

  recognition.onerror = (e) => {
    isListening = false;
    dictateBtn.classList.remove('recording');
    if (e.error === 'not-allowed') {
      dictateBtn.disabled = true;
      dictateIcon.textContent = '🔇';
      dictateLabel.textContent = 'Dictate';
      micError.style.display = 'block';
      micError.textContent = 'Voice needs HTTPS or localhost. Chrome blocks mic on HTTP LAN IP. Use keyboard below.';
    } else {
      dictateIcon.textContent = '🎤';
      dictateLabel.textContent = 'Dictate';
    }
  };

  recognition.onend = () => {
    if (isListening) recognition.start();
  };
} else {
  dictateIcon.textContent = '🚫';
  dictateLabel.textContent = 'Dictate';
  dictateBtn.disabled = true;
}

function toggleDictation(e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  if (!recognition) return;

  if (isListening) {
    isListening = false;
    recognition.stop();
    dictateBtn.classList.remove('recording');
    dictateIcon.textContent = '🎤';
    dictateLabel.textContent = 'Dictate';
  } else {
    isListening = true;
    recognition.start();
    dictateBtn.classList.add('recording');
    dictateIcon.textContent = '🔴';
    dictateLabel.textContent = 'Recording';
  }
}

dictateBtn.addEventListener('click', toggleDictation);

// ── Touch scroll through terminal history ───────────────────────────
const termContainer = document.getElementById('terminal-container');
let touchScrollStartY = 0;
let touchScrollStartX = 0;
let touchScrollActive = false;
const SCROLL_DEADZONE = 8;

termContainer.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) { touchScrollActive = false; return; }
  touchScrollStartY = e.touches[0].clientY;
  touchScrollStartX = e.touches[0].clientX;
  touchScrollActive = true;
}, { passive: true });

termContainer.addEventListener('touchmove', (e) => {
  if (!touchScrollActive || e.touches.length !== 1) return;
  const dy = e.touches[0].clientY - touchScrollStartY;
  const dx = Math.abs(e.touches[0].clientX - touchScrollStartX);

  // Swipe is not vertical enough — let xterm handle (text selection etc.)
  if (Math.abs(dy) < dx || Math.abs(dy) < SCROLL_DEADZONE) return;

  // If at top of scrollback AND swiping down, let pull-to-refresh fire
  if (dy > 0 && term.buffer.active.viewportY <= 0) return;

  e.preventDefault();
  e.stopPropagation();
  // Positive dy = finger down → scroll UP through history
  // scrollLines(-) = scroll up, scrollLines(+) = scroll down
  const lines = Math.round(-dy / 20);
  if (lines !== 0) {
    try { term.scrollLines(lines); } catch (_) {}
  }
  touchScrollStartY = e.touches[0].clientY;
  touchScrollStartX = e.touches[0].clientX;
}, { passive: false });

termContainer.addEventListener('touchend', () => {
  touchScrollActive = false;
});

// ── Pull-to-refresh ─────────────────────────────────────────────────
const pullIndicator = document.getElementById('pull-indicator');
const PULL_THRESHOLD = 60;
let pullStartY = 0;
let pullActive = false;
let pullRefreshing = false;

document.addEventListener('touchstart', (e) => {
  if (pullRefreshing || e.touches.length !== 1) return;
  if (window.scrollY === 0) {
    pullStartY = e.touches[0].clientY;
    pullActive = true;
  }
}, { passive: true, capture: true });

document.addEventListener('touchmove', (e) => {
  if (!pullActive || pullRefreshing) return;
  const dy = e.touches[0].clientY - pullStartY;
  if (dy > 10) {
    e.preventDefault();
    e.stopPropagation();
    if (dy > PULL_THRESHOLD) {
      pullIndicator.className = 'refreshing';
    } else {
      pullIndicator.className = 'showing';
    }
  }
}, { passive: false, capture: true });

document.addEventListener('touchend', () => {
  if (!pullActive) return;
  const wasShowing = pullIndicator.classList.contains('refreshing');
  pullActive = false;
  pullIndicator.className = '';
  if (wasShowing && !pullRefreshing) {
    pullRefreshing = true;
    pullIndicator.className = 'refreshing';
    setTimeout(() => location.reload(), 350);
  }
}, { capture: true });
