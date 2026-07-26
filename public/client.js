// ── Terminal ─────────────────────────────────────────────────────────
const term = new window.Terminal({
  cursorBlink: true,
  fontSize: 14,
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
window.addEventListener('resize', () => fitAddon.fit());

// ── DOM refs ────────────────────────────────────────────────────────
const sessionLabel = document.getElementById('session-label');
const switchBtn = document.getElementById('switch-btn');
const sessionModal = document.getElementById('session-modal');
const sessionList = document.getElementById('session-list');
const modalClose = document.getElementById('modal-close');
const micBtn = document.getElementById('mic-btn');

// ── State ───────────────────────────────────────────────────────────
let sessions = [];
let activeSessionId = null;

// ── WebSocket ───────────────────────────────────────────────────────
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${protocol}//${window.location.host}`);

function send(msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

ws.onmessage = (event) => {
  let msg;
  try { msg = JSON.parse(event.data); } catch (e) { return; }

  switch (msg.type) {
    case 'output':
      term.write(msg.data);
      break;
    case 'session_list':
      sessions = msg.sessions || [];
      updateUI();
      // Auto-select first session if none active
      if (!activeSessionId && sessions.length > 0) {
        selectSession(sessions[0].id);
      }
      break;
    case 'error':
      console.error('Server error:', msg.message);
      break;
    default:
      break;
  }
};

ws.onclose = () => {
  term.write('\r\n\x1b[31m[AirPrompt: disconnected]\x1b[0m\r\n');
};

// ── Session UI ──────────────────────────────────────────────────────
function updateUI() {
  const s = sessions.find((s) => s.id === activeSessionId);
  if (activeSessionId && s) {
    sessionLabel.textContent = s.cwd;
  } else {
    sessionLabel.textContent = 'No session selected';
  }

  // Session list in modal
  if (sessions.length === 0) {
    sessionList.innerHTML = '<div class="session-empty">No active sessions</div>';
  } else {
    sessionList.innerHTML = sessions
      .map((s) => {
        const activeClass = s.id === activeSessionId ? ' active' : '';
        const time = new Date(s.createdAt).toLocaleString();
        return `<button class="session-item${activeClass}" data-id="${s.id}">
          <div class="cwd">${escHtml(s.cwd)}</div>
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
  activeSessionId = id;
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

switchBtn.addEventListener('click', openModal);
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
      send({ type: 'input', data: transcript + '\r' });
    }
  };

  recognition.onerror = (e) => {
    console.error('Speech error:', e.error);
    stopDictation();
  };

  recognition.onend = () => {
    if (isListening) recognition.start();
  };
} else {
  micBtn.innerText = 'Dictation Not Supported';
  micBtn.disabled = true;
  micBtn.style.background = '#444';
}

function startDictation(e) {
  if (e) e.preventDefault();
  if (!recognition || isListening) return;
  isListening = true;
  recognition.start();
  micBtn.classList.add('recording');
  micBtn.innerText = '🛑 Listening... Release to Send';
}

function stopDictation(e) {
  if (e) e.preventDefault();
  if (!recognition || !isListening) return;
  isListening = false;
  recognition.stop();
  micBtn.classList.remove('recording');
  micBtn.innerText = '🎤 Hold to Dictate';
}

micBtn.addEventListener('pointerdown', startDictation);
micBtn.addEventListener('pointerup', stopDictation);
micBtn.addEventListener('pointercancel', stopDictation);

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
}, { passive: true });

document.addEventListener('touchmove', (e) => {
  if (!pullActive || pullRefreshing) return;
  const dy = e.touches[0].clientY - pullStartY;
  if (dy > 10) {
    e.preventDefault();
    if (dy > PULL_THRESHOLD) {
      pullIndicator.className = 'refreshing';
    } else {
      pullIndicator.className = 'showing';
    }
  }
}, { passive: false });

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
});
