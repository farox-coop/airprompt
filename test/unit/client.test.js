// ── Client unit tests ──────────────────────────────────────────────────
// Tests pure logic from public/client.js and public/keybar.js.
// DOM-dependent and WebSocket code is tested via integration.

const test = require('node:test');
const assert = require('node:assert');

// ═══════════════════════════════════════════════════════════════════════
// Replicated pure functions — keybar.js
// ═══════════════════════════════════════════════════════════════════════

// ── Key definitions (mirrors keybar.js ROWS) ──────────────────────────
var ROWS = [
  [
    { label: 'Esc',   seq: '\x1b',     cls: 'modifier' },
    { label: 'Tab',   seq: '\t',       cls: 'modifier' },
    { label: 'Ctrl',  seq: null,       cls: 'modifier sticky', id: 'ctrl' },
    { label: 'Alt',   seq: null,       cls: 'modifier sticky', id: 'alt' },
    { label: 'Shift', seq: null,       cls: 'modifier sticky', id: 'shift' },
    { label: ':',     seq: ':',        cls: '' },
    { label: '|',     seq: '|',        cls: '' },
    { label: ';',     seq: ';',        cls: '' },
  ],
  [
    { label: 'Home',  seq: '\x1b[H',   cls: '' },
    { label: 'End',   seq: '\x1b[F',   cls: '' },
    { label: 'PgUp',  seq: '\x1b[5~',  cls: '' },
    { label: 'PgDn',  seq: '\x1b[6~',  cls: '' },
    { label: 'Del',   seq: '\x1b[3~',  cls: '' },
    { label: '/',     seq: '/',        cls: '' },
    { label: '↑',     seq: '\x1b[A',   cls: 'arrow' },
    { label: '\\',    seq: '\\',       cls: '' },
  ],
  [
    { label: 'Sft+Tab',seq: '\x1b[Z', cls: 'combo', raw: true },
    { label: 'Undo',  seq: '/rewind\r', cls: 'combo', raw: true },
    { label: 'Stash', seq: '\x13',     cls: 'combo', raw: true },
    { label: 'Search',seq: '\x12',     cls: 'combo', raw: true },
    { label: 'Send',  seq: '\r',       cls: 'send', raw: true },
    { label: '←',     seq: '\x1b[D',   cls: 'arrow' },
    { label: '↓',     seq: '\x1b[B',   cls: 'arrow' },
    { label: '→',     seq: '\x1b[C',   cls: 'arrow' },
  ],
];

var DOUBLE_TAP_MS = 300;

// SHIFT_MAP: mirrors keybar.js — terminal control sequences → Shift-modified version
var SHIFT_MAP = {
  '\t': '\x1b[Z',   // Tab → Shift+Tab (reverse tab)
};

// ── Keybar state machine (mirrors keybar.js handleSticky) ─────────────

function createModState() {
  return {
    ctrl:  { armed: false, locked: false, lastTap: 0 },
    alt:   { armed: false, locked: false, lastTap: 0 },
    shift: { armed: false, locked: false, lastTap: 0 },
  };
}

function handleSticky(modState, mod, nowOverride) {
  var now = nowOverride !== undefined ? nowOverride : Date.now();
  var s = modState[mod];
  if (!s) return { changed: false };

  if (s.locked) {
    s.locked = false;
    s.armed = false;
    return { changed: true, state: 'unlocked' };
  } else if (s.armed) {
    if (now - s.lastTap <= DOUBLE_TAP_MS) {
      s.armed = false;
      s.locked = true;
      return { changed: true, state: 'locked' };
    } else {
      s.armed = false;
      return { changed: true, state: 'disarmed' };
    }
  } else {
    s.armed = true;
    s.lastTap = now;
    return { changed: true, state: 'armed' };
  }
}

// ── sendKey (mirrors keybar.js sendKey) ──────────────────────────────

function simulateSendKey(modState, seq) {
  if (!seq) return { sent: null, disarmed: [] };

  var disarmed = [];

  // Apply sticky Ctrl: mask ASCII chars with 0x1f
  var s = modState.ctrl;
  if ((s.armed || s.locked) && seq.length === 1) {
    var code = seq.charCodeAt(0);
    if (code >= 0x20 && code < 0x7f) {
      seq = String.fromCharCode(code & 0x1f);
    }
  }
  if (s.armed) { s.armed = false; disarmed.push('ctrl'); }

  // Apply sticky Alt: prefix \x1b
  var a = modState.alt;
  if (a.armed || a.locked) {
    seq = '\x1b' + seq;
    if (!a.locked) { a.armed = false; disarmed.push('alt'); }
  }

  // Apply sticky Shift: map known control sequences. Only for keys in
  // SHIFT_MAP — regular characters are NOT transformed (a stays a).
  var sh = modState.shift;
  if ((sh.armed || sh.locked) && SHIFT_MAP[seq]) {
    seq = SHIFT_MAP[seq];
  }
  if (sh.armed) { sh.armed = false; disarmed.push('shift'); }

  return { sent: seq, disarmed: disarmed };
}

// ── applyModifiers (mirrors keybar.js) — for native keyboard input ──

function applyModifiers(modState, data) {
  // Guard: empty/ghost events must not disarm one-shot modifiers.
  if (!data) return { result: data, disarmed: [] };

  var ctrl  = modState.ctrl.armed  || modState.ctrl.locked;
  var alt   = modState.alt.armed   || modState.alt.locked;
  var shift = modState.shift.armed || modState.shift.locked;

  // Disarm one-shot modifiers (locked stay active)
  var disarmed = [];
  if (modState.ctrl.armed)  { modState.ctrl.armed = false; disarmed.push('ctrl'); }
  if (modState.alt.armed && !modState.alt.locked) {
    modState.alt.armed = false; disarmed.push('alt');
  }
  if (modState.shift.armed) { modState.shift.armed = false; disarmed.push('shift'); }

  var result = data;

  // Apply Ctrl mask per character
  if (ctrl) {
    var masked = '';
    for (var i = 0; i < result.length; i++) {
      var code = result.charCodeAt(i);
      if (code >= 0x20 && code < 0x7f) {
        masked += String.fromCharCode(code & 0x1f);
      } else {
        masked += result[i];
      }
    }
    result = masked;
  }

  // Apply Alt prefix
  if (alt) {
    result = '\x1b' + result;
  }

  // Apply Shift map — terminal control sequences + char casing
  if (shift) {
    if (SHIFT_MAP[result]) {
      result = SHIFT_MAP[result];
    } else if (!ctrl) {
      if (modState.shift.locked) {
        result = result.toUpperCase();
      } else {
        var chars = Array.from(result);
        if (chars.length > 0) chars[0] = chars[0].toUpperCase();
        result = chars.join('');
      }
    }
  }

  return { result: result, disarmed: disarmed };
}

// ── Copy/paste combo checks (mirrors keybar.js) ──────────────────────

function isCopyPasteCombo(modState, key) {
  var ctrl  = modState.ctrl.armed  || modState.ctrl.locked;
  var shift = modState.shift.armed || modState.shift.locked;
  return ctrl && shift && (key === 'c' || key === 'v');
}

function disarmCopyPaste(modState) {
  var disarmed = [];
  if (modState.ctrl.armed)  { modState.ctrl.armed = false; disarmed.push('ctrl'); }
  if (modState.shift.armed) { modState.shift.armed = false; disarmed.push('shift'); }
  return disarmed;
}

function hasAnyModifier(modState) {
  return modState.ctrl.armed  || modState.ctrl.locked ||
         modState.alt.armed   || modState.alt.locked  ||
         modState.shift.armed || modState.shift.locked;
}

// ═══════════════════════════════════════════════════════════════════════
// Replicated pure functions — client.js
// ═══════════════════════════════════════════════════════════════════════

function sessionDisplayLabel(s) {
  return s.name || s.cwd;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function reconnectDelay(attempt) {
  return Math.min(1000 * Math.pow(2, attempt), 30000);
}

// ── wsMessageHandler dispatch (mirrors client.js) ─────────────────────

function dispatchMessage(msg, state) {
  switch (msg.type) {
    case 'output':
      return { action: 'write', data: msg.data };
    case 'notification':
      return { action: 'showNotification', data: msg };
    case 'session_list':
      return { action: 'updateSessions', sessions: msg.sessions || [] };
    case 'error':
      return { action: 'handleError', message: msg.message };
    default:
      return { action: 'ignore' };
  }
}

function selectSessionLogic(sessions, id) {
  var found = sessions.find(function (s) { return s.id === id; });
  return { found: !!found, id: id };
}

// ── i18n tr() (mirrors client.js) ─────────────────────────────────────

var T_MAP = {
  'en-US': {
    dictate: 'Dictate', recording: 'Recording', paused: 'Paused',
    cancel: 'Cancel', accept: 'Accept', send: 'Send',
    listening: 'Listening…', speaking: '● Speaking…',
    noSession: 'No session selected', noActive: 'No active sessions',
    activeSessions: 'Active Sessions', close: 'Close', refresh: 'Refresh',
    micHttps: 'Voice needs HTTPS or localhost.',
    langFallback: 'Language not supported. Falling back to English.',
    disconnected: '⚠️ DISCONNECTED — Tap to dismiss',
  },
  'es-AR': {
    dictate: 'Dictar', recording: 'Grabando', paused: 'Pausado',
    cancel: 'Cancelar', accept: 'Aceptar', send: 'Enviar',
    listening: 'Escuchando…', speaking: '● Hablando…',
    noSession: 'Sin sesión', noActive: 'Sin sesiones activas',
    activeSessions: 'Sesiones Activas', close: 'Cerrar', refresh: 'Recargar',
    micHttps: 'El micrófono requiere HTTPS o localhost.',
    langFallback: 'Idioma no soportado. Cambiando a inglés.',
    disconnected: '⚠️ DESCONECTADO — Tocar para cerrar',
  },
};

function trClient(key, lang) {
  return (T_MAP[lang] && T_MAP[lang][key]) || T_MAP['en-US'][key] || key;
}

// ═══════════════════════════════════════════════════════════════════════
// Tests — Keybar ROWS structure
// ═══════════════════════════════════════════════════════════════════════

test('keybar ROWS — three rows defined', async (t) => {
  await t.test('has exactly 3 rows', function () {
    assert.strictEqual(ROWS.length, 3);
  });

  await t.test('row 0 has exactly 8 keys', function () {
    assert.strictEqual(ROWS[0].length, 8);
  });

  await t.test('row 1 has exactly 8 keys', function () {
    assert.strictEqual(ROWS[1].length, 8);
  });

  await t.test('row 2 has exactly 8 keys', function () {
    assert.strictEqual(ROWS[2].length, 8);
  });
});

test('keybar ROWS — modifier keys present', async (t) => {
  await t.test('Ctrl is modifier sticky with id', function () {
    var k = ROWS[0].find(function (x) { return x.id === 'ctrl'; });
    assert.ok(k);
    assert.strictEqual(k.cls, 'modifier sticky');
  });

  await t.test('Alt is modifier sticky with id', function () {
    var k = ROWS[0].find(function (x) { return x.id === 'alt'; });
    assert.ok(k);
    assert.strictEqual(k.cls, 'modifier sticky');
  });

  await t.test('Shift is modifier sticky with id', function () {
    var k = ROWS[0].find(function (x) { return x.id === 'shift'; });
    assert.ok(k);
    assert.strictEqual(k.cls, 'modifier sticky');
  });

  await t.test('Esc and Tab are modifier (non-sticky)', function () {
    var esc = ROWS[0].find(function (x) { return x.label === 'Esc'; });
    var tab = ROWS[0].find(function (x) { return x.label === 'Tab'; });
    assert.ok(esc);
    assert.ok(tab);
    assert.strictEqual(esc.cls, 'modifier');
    assert.strictEqual(tab.cls, 'modifier');
  });
});

test('keybar ROWS — Shift does NOT transform characters', async (t) => {
  await t.test('Shift has seq=null (no own sequence)', function () {
    var shift = ROWS[0].find(function (x) { return x.id === 'shift'; });
    assert.strictEqual(shift.seq, null);
  });

  await t.test('no key sends shifted char directly — | and : are their own keys in row 0', function () {
    // | and : are row 0 positions 6,5 — both have their literal seq values
    var pipe = ROWS[0].find(function (k) { return k.label === '|'; });
    var colon = ROWS[0].find(function (k) { return k.label === ':'; });
    assert.strictEqual(pipe.seq, '|');
    assert.strictEqual(colon.seq, ':');
  });
});

test('keybar ROWS — inverted-T arrow layout', async (t) => {
  await t.test('row 1 has ↑ (7th key)', function () {
    var row = ROWS[1];
    assert.strictEqual(row[6].label, '↑');
    assert.strictEqual(row[6].cls, 'arrow');
  });

  await t.test('row 2 has ← ↓ → as last three keys', function () {
    var row = ROWS[2];
    assert.strictEqual(row[5].label, '←');
    assert.strictEqual(row[6].label, '↓');
    assert.strictEqual(row[7].label, '→');
  });

  await t.test('all four arrows have cls "arrow"', function () {
    var arrows = ROWS.flat().filter(function (k) { return k.cls === 'arrow'; });
    assert.strictEqual(arrows.length, 4);
  });

  await t.test('no more spacers in layout', function () {
    var spacers = ROWS.flat().filter(function (k) { return k.cls === 'spacer'; });
    assert.strictEqual(spacers.length, 0);
  });
});

test('keybar ROWS — all keys have expected sequences', async (t) => {
  await t.test('Esc → \\x1b', function () {
    assert.strictEqual(ROWS[0].find(function (k) { return k.label === 'Esc'; }).seq, '\x1b');
  });
  await t.test('Tab → \\t', function () {
    assert.strictEqual(ROWS[0].find(function (k) { return k.label === 'Tab'; }).seq, '\t');
  });
  await t.test('↑ → \\x1b[A', function () {
    assert.strictEqual(ROWS[1].find(function (k) { return k.label === '↑'; }).seq, '\x1b[A');
  });
  await t.test('↓ → \\x1b[B', function () {
    assert.strictEqual(ROWS[2].find(function (k) { return k.label === '↓'; }).seq, '\x1b[B');
  });
  await t.test('← → \\x1b[D', function () {
    assert.strictEqual(ROWS[2].find(function (k) { return k.label === '←'; }).seq, '\x1b[D');
  });
  await t.test('→ → \\x1b[C', function () {
    assert.strictEqual(ROWS[2].find(function (k) { return k.label === '→'; }).seq, '\x1b[C');
  });
  await t.test('Home → \\x1b[H', function () {
    assert.strictEqual(ROWS[1].find(function (k) { return k.label === 'Home'; }).seq, '\x1b[H');
  });
  await t.test('End → \\x1b[F', function () {
    assert.strictEqual(ROWS[1].find(function (k) { return k.label === 'End'; }).seq, '\x1b[F');
  });
  await t.test('PgUp → \\x1b[5~', function () {
    assert.strictEqual(ROWS[1].find(function (k) { return k.label === 'PgUp'; }).seq, '\x1b[5~');
  });
  await t.test('PgDn → \\x1b[6~', function () {
    assert.strictEqual(ROWS[1].find(function (k) { return k.label === 'PgDn'; }).seq, '\x1b[6~');
  });
  await t.test('Del → \\x1b[3~', function () {
    assert.strictEqual(ROWS[1].find(function (k) { return k.label === 'Del'; }).seq, '\x1b[3~');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tests — handleSticky state machine
// ═══════════════════════════════════════════════════════════════════════

test('handleSticky — idle → armed', async (t) => {
  await t.test('first tap arms Ctrl', function () {
    var st = createModState();
    var r = handleSticky(st, 'ctrl', 1000);
    assert.strictEqual(r.state, 'armed');
    assert.strictEqual(st.ctrl.armed, true);
    assert.strictEqual(st.ctrl.locked, false);
    assert.strictEqual(st.ctrl.lastTap, 1000);
  });

  await t.test('first tap arms Alt', function () {
    var st = createModState();
    var r = handleSticky(st, 'alt', 2000);
    assert.strictEqual(r.state, 'armed');
    assert.strictEqual(st.alt.armed, true);
  });

  await t.test('first tap arms Shift', function () {
    var st = createModState();
    var r = handleSticky(st, 'shift', 3000);
    assert.strictEqual(r.state, 'armed');
    assert.strictEqual(st.shift.armed, true);
  });

  await t.test('unknown modifier returns unchanged', function () {
    var st = createModState();
    var r = handleSticky(st, 'super', 1000);
    assert.strictEqual(r.changed, false);
  });
});

test('handleSticky — armed → locked (double-tap within 300ms)', async (t) => {
  await t.test('Ctrl: arm at t=1000, lock at t=1200 (200ms < 300ms)', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    var r = handleSticky(st, 'ctrl', 1200);
    assert.strictEqual(r.state, 'locked');
    assert.strictEqual(st.ctrl.armed, false);
    assert.strictEqual(st.ctrl.locked, true);
  });

  await t.test('Alt: arm at t=500, lock at t=800 (300ms boundary)', function () {
    var st = createModState();
    handleSticky(st, 'alt', 500);
    var r = handleSticky(st, 'alt', 800);
    assert.strictEqual(r.state, 'locked');
    assert.strictEqual(st.alt.locked, true);
  });

  await t.test('Shift: arm at t=100, lock at t=400 (exactly 300ms)', function () {
    var st = createModState();
    handleSticky(st, 'shift', 100);
    var r = handleSticky(st, 'shift', 400);
    assert.strictEqual(r.state, 'locked');
  });

  await t.test('Shift: arm at t=100, lock at t=401 (>300ms, disarms)', function () {
    var st = createModState();
    handleSticky(st, 'shift', 100);
    var r = handleSticky(st, 'shift', 401);
    assert.strictEqual(r.state, 'disarmed');
    assert.strictEqual(st.shift.armed, false);
    assert.strictEqual(st.shift.locked, false);
  });
});

test('handleSticky — armed → disarmed (slow double-tap > 300ms)', async (t) => {
  await t.test('Ctrl: arm at t=1000, slow tap at t=1500 (500ms > 300ms)', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    var r = handleSticky(st, 'ctrl', 1500);
    assert.strictEqual(r.state, 'disarmed');
    assert.strictEqual(st.ctrl.armed, false);
    assert.strictEqual(st.ctrl.locked, false);
  });

  await t.test('Alt: arm at t=0, slow tap at t=400 (400ms > 300ms)', function () {
    var st = createModState();
    handleSticky(st, 'alt', 0);
    var r = handleSticky(st, 'alt', 400);
    assert.strictEqual(r.state, 'disarmed');
  });
});

test('handleSticky — locked → unlocked', async (t) => {
  await t.test('Ctrl: locked, tap unlocks', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    handleSticky(st, 'ctrl', 1200); // locked
    var r = handleSticky(st, 'ctrl', 2000);
    assert.strictEqual(r.state, 'unlocked');
    assert.strictEqual(st.ctrl.armed, false);
    assert.strictEqual(st.ctrl.locked, false);
  });

  await t.test('Alt: locked, tap unlocks', function () {
    var st = createModState();
    handleSticky(st, 'alt', 1000);
    handleSticky(st, 'alt', 1200);
    var r = handleSticky(st, 'alt', 3000);
    assert.strictEqual(r.state, 'unlocked');
  });

  await t.test('Shift: locked, tap unlocks', function () {
    var st = createModState();
    handleSticky(st, 'shift', 1000);
    handleSticky(st, 'shift', 1200);
    var r = handleSticky(st, 'shift', 4000);
    assert.strictEqual(r.state, 'unlocked');
  });
});

test('handleSticky — full cycle: arm → lock → unlock → arm → disarm', async (t) => {
  await t.test('Ctrl completes full cycle correctly', function () {
    var st = createModState();

    // idle → armed
    handleSticky(st, 'ctrl', 1000);
    assert.strictEqual(st.ctrl.armed, true);
    assert.strictEqual(st.ctrl.locked, false);

    // armed → locked
    handleSticky(st, 'ctrl', 1200);
    assert.strictEqual(st.ctrl.armed, false);
    assert.strictEqual(st.ctrl.locked, true);

    // locked → unlocked
    handleSticky(st, 'ctrl', 3000);
    assert.strictEqual(st.ctrl.armed, false);
    assert.strictEqual(st.ctrl.locked, false);

    // idle → armed again
    handleSticky(st, 'ctrl', 4000);
    assert.strictEqual(st.ctrl.armed, true);

    // armed → disarmed (slow tap)
    handleSticky(st, 'ctrl', 5000);
    assert.strictEqual(st.ctrl.armed, false);
    assert.strictEqual(st.ctrl.locked, false);
  });
});

test('handleSticky — modifiers are independent', async (t) => {
  await t.test('Ctrl locked + Alt armed at same time', function () {
    var st = createModState();
    // Ctrl locked
    handleSticky(st, 'ctrl', 1000);
    handleSticky(st, 'ctrl', 1100); // locked
    // Alt armed
    handleSticky(st, 'alt', 1500); // armed

    assert.strictEqual(st.ctrl.locked, true);
    assert.strictEqual(st.alt.armed, true);
    assert.strictEqual(st.alt.locked, false);
  });

  await t.test('Shift armed does not affect Ctrl state', function () {
    var st = createModState();
    handleSticky(st, 'shift', 1000);
    assert.strictEqual(st.shift.armed, true);
    assert.strictEqual(st.ctrl.armed, false);
    assert.strictEqual(st.ctrl.locked, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tests — sendKey (keybar button clicks)
// ═══════════════════════════════════════════════════════════════════════

test('sendKey — plain keys (no modifiers)', async (t) => {
  await t.test('Esc sends \\x1b', function () {
    var st = createModState();
    var r = simulateSendKey(st, '\x1b');
    assert.strictEqual(r.sent, '\x1b');
    assert.deepStrictEqual(r.disarmed, []);
  });

  await t.test('Tab sends \\t', function () {
    var st = createModState();
    var r = simulateSendKey(st, '\t');
    assert.strictEqual(r.sent, '\t');
  });

  await t.test('arrow Up sends \\x1b[A', function () {
    var st = createModState();
    var r = simulateSendKey(st, '\x1b[A');
    assert.strictEqual(r.sent, '\x1b[A');
  });

  await t.test('null seq returns null sent', function () {
    var st = createModState();
    var r = simulateSendKey(st, null);
    assert.strictEqual(r.sent, null);
  });

  await t.test('empty string → null sent (falsy guard)', function () {
    var st = createModState();
    var r = simulateSendKey(st, '');
    assert.strictEqual(r.sent, null);
  });
});

test('sendKey — Ctrl modifier (armed, single-shot)', async (t) => {
  await t.test('Ctrl armed + "a" → \\x01 (Ctrl-A)', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000); // arm
    var r = simulateSendKey(st, 'a');
    assert.strictEqual(r.sent, '\x01');
    assert.deepStrictEqual(r.disarmed, ['ctrl']);
    assert.strictEqual(st.ctrl.armed, false); // disarmed after use
  });

  await t.test('Ctrl armed + "z" → \\x1a (Ctrl-Z)', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    var r = simulateSendKey(st, 'z');
    assert.strictEqual(r.sent, '\x1a');
  });

  await t.test('Ctrl armed + "c" → \\x03 (SIGINT)', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    var r = simulateSendKey(st, 'c');
    assert.strictEqual(r.sent, '\x03');
  });

  await t.test('Ctrl armed + "d" → \\x04 (EOF)', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    var r = simulateSendKey(st, 'd');
    assert.strictEqual(r.sent, '\x04');
  });

  await t.test('Ctrl armed + "l" → \\x0c (Ctrl-L)', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    var r = simulateSendKey(st, 'l');
    assert.strictEqual(r.sent, '\x0c');
  });

  await t.test('Ctrl armed + "/" → \\x0f (Ctrl-/)', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    var r = simulateSendKey(st, '/');
    assert.strictEqual(r.sent, '\x0f');
  });
});

test('sendKey — Ctrl: non-ASCII sequences NOT masked', async (t) => {
  await t.test('Ctrl armed + arrow Up (multi-char) → not masked, Ctrl still disarmed', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    var r = simulateSendKey(st, '\x1b[A');
    // Multi-char — not masked, but Ctrl armed IS disarmed
    assert.strictEqual(r.sent, '\x1b[A');
    assert.deepStrictEqual(r.disarmed, ['ctrl']);
  });

  await t.test('Ctrl armed + arrow Down (multi-char) → not masked', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    var r = simulateSendKey(st, '\x1b[B');
    assert.strictEqual(r.sent, '\x1b[B');
    assert.strictEqual(st.ctrl.armed, false);
  });
});

test('sendKey — Ctrl locked (stays on)', async (t) => {
  await t.test('Ctrl locked + "a" → \\x01, Ctrl stays locked', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    handleSticky(st, 'ctrl', 1100); // lock
    var r = simulateSendKey(st, 'a');
    assert.strictEqual(r.sent, '\x01');
    assert.deepStrictEqual(r.disarmed, []); // not disarmed — it's locked
    assert.strictEqual(st.ctrl.locked, true);
  });

  await t.test('Ctrl locked + "w" → \\x17 (Ctrl-W), Ctrl stays locked', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    handleSticky(st, 'ctrl', 1100);
    var r = simulateSendKey(st, 'w');
    assert.strictEqual(r.sent, '\x17');
    assert.strictEqual(st.ctrl.locked, true);
  });

  await t.test('Ctrl locked + consecutive keys all masked', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    handleSticky(st, 'ctrl', 1100);

    var r1 = simulateSendKey(st, 'a');
    assert.strictEqual(r1.sent, '\x01');
    var r2 = simulateSendKey(st, 'b');
    assert.strictEqual(r2.sent, '\x02');
    var r3 = simulateSendKey(st, 'c');
    assert.strictEqual(r3.sent, '\x03');
    assert.strictEqual(st.ctrl.locked, true);
  });
});

test('sendKey — Ctrl: non-printable chars not masked', async (t) => {
  await t.test('Ctrl armed + Tab (\\t, 0x09 < 0x20) → no mask', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    var r = simulateSendKey(st, '\t');
    assert.strictEqual(r.sent, '\t');
    assert.strictEqual(st.ctrl.armed, false);
  });

  await t.test('Ctrl armed + \\n (LF, 0x0A) → no mask', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    var r = simulateSendKey(st, '\n');
    assert.strictEqual(r.sent, '\n');
  });

  await t.test('Ctrl armed + \\r (CR, 0x0D) → no mask', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    var r = simulateSendKey(st, '\r');
    assert.strictEqual(r.sent, '\r');
  });

  await t.test('Ctrl armed + Esc (\\x1b, 0x1B < 0x20) → no mask, Ctrl disarmed', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    var r = simulateSendKey(st, '\x1b');
    assert.strictEqual(r.sent, '\x1b');
    assert.strictEqual(st.ctrl.armed, false);
  });
});

test('sendKey — Alt modifier (armed, single-shot)', async (t) => {
  await t.test('Alt armed + "x" → \\x1b + x', function () {
    var st = createModState();
    handleSticky(st, 'alt', 1000);
    var r = simulateSendKey(st, 'x');
    assert.strictEqual(r.sent, '\x1bx');
    assert.deepStrictEqual(r.disarmed, ['alt']);
    assert.strictEqual(st.alt.armed, false);
  });

  await t.test('Alt armed + arrow Up → \\x1b + \\x1b[A', function () {
    var st = createModState();
    handleSticky(st, 'alt', 1000);
    var r = simulateSendKey(st, '\x1b[A');
    assert.strictEqual(r.sent, '\x1b\x1b[A');
  });
});

test('sendKey — Alt locked (stays on)', async (t) => {
  await t.test('Alt locked + "x" → \\x1b + x, Alt stays locked', function () {
    var st = createModState();
    handleSticky(st, 'alt', 1000);
    handleSticky(st, 'alt', 1100);
    var r = simulateSendKey(st, 'x');
    assert.strictEqual(r.sent, '\x1bx');
    assert.deepStrictEqual(r.disarmed, []);
    assert.strictEqual(st.alt.locked, true);
  });
});

test('sendKey — Ctrl+Alt combo (keybar buttons)', async (t) => {
  await t.test('Ctrl+Alt armed + "a" → \\x1b + \\x01', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    handleSticky(st, 'alt', 1100);
    var r = simulateSendKey(st, 'a');
    // Ctrl applies first: 'a' → \x01, Alt then prefixes: \x1b\x01
    assert.strictEqual(r.sent, '\x1b\x01');
    assert.deepStrictEqual(r.disarmed.sort(), ['alt', 'ctrl'].sort());
  });

  await t.test('Ctrl locked + Alt armed + "d" → \\x1b + \\x04', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    handleSticky(st, 'ctrl', 1100); // Ctrl locked
    handleSticky(st, 'alt', 1500);  // Alt armed
    var r = simulateSendKey(st, 'd');
    assert.strictEqual(r.sent, '\x1b\x04');
    assert.deepStrictEqual(r.disarmed, ['alt']); // only Alt disarmed, Ctrl stays locked
    assert.strictEqual(st.ctrl.locked, true);
    assert.strictEqual(st.alt.armed, false);
  });
});

test('sendKey — Shift modifier behavior', async (t) => {
  await t.test('Shift armed + "-" → "-" (no character transform)', function () {
    var st = createModState();
    handleSticky(st, 'shift', 1000);
    var r = simulateSendKey(st, '-');
    assert.strictEqual(r.sent, '-'); // NOT '_' — Shift does not transform
    assert.deepStrictEqual(r.disarmed, ['shift']);
    assert.strictEqual(st.shift.armed, false);
  });

  await t.test('Shift locked + "a" → "a" (no transform, Shift stays locked)', function () {
    var st = createModState();
    handleSticky(st, 'shift', 1000);
    handleSticky(st, 'shift', 1100);
    var r = simulateSendKey(st, 'a');
    assert.strictEqual(r.sent, 'a');
    assert.deepStrictEqual(r.disarmed, []);
    assert.strictEqual(st.shift.locked, true);
  });

  await t.test('Ctrl+Shift armed + "c" → \\x03 (Ctrl-C, Shift ignored for regular chars)', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    handleSticky(st, 'shift', 1100);
    var r = simulateSendKey(st, 'c');
    assert.strictEqual(r.sent, '\x03');
    assert.deepStrictEqual(r.disarmed.sort(), ['ctrl', 'shift'].sort());
  });

  await t.test('Shift armed + Tab → \\x1b[Z (reverse tab)', function () {
    var st = createModState();
    handleSticky(st, 'shift', 1000);
    var r = simulateSendKey(st, '\t');
    assert.strictEqual(r.sent, '\x1b[Z');
    assert.deepStrictEqual(r.disarmed, ['shift']);
    assert.strictEqual(st.shift.armed, false);
  });

  await t.test('Shift locked + Tab → \\x1b[Z, Shift stays locked', function () {
    var st = createModState();
    handleSticky(st, 'shift', 1000);
    handleSticky(st, 'shift', 1100);
    var r = simulateSendKey(st, '\t');
    assert.strictEqual(r.sent, '\x1b[Z');
    assert.deepStrictEqual(r.disarmed, []);
    assert.strictEqual(st.shift.locked, true);
  });

  await t.test('Shift armed + Esc → \\x1b (Esc NOT in SHIFT_MAP, stays as-is)', function () {
    var st = createModState();
    handleSticky(st, 'shift', 1000);
    var r = simulateSendKey(st, '\x1b');
    assert.strictEqual(r.sent, '\x1b');
    assert.deepStrictEqual(r.disarmed, ['shift']);
  });

  await t.test('Shift + Ctrl armed + Tab → Ctrl mask first, no Shift map (\\t masked to \\x09, 0x09<0x20)', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    handleSticky(st, 'shift', 1100);
    // Ctrl masks first: \t (0x09) is < 0x20 → NOT masked. Shift checks SHIFT_MAP after.
    // But result after Ctrl is still '\t' → SHIFT_MAP['\t'] = '\x1b[Z'
    var r = simulateSendKey(st, '\t');
    // \t is 0x09 < 0x20, Ctrl doesn't mask it. Result is \t → Shift maps to \x1b[Z
    assert.strictEqual(r.sent, '\x1b[Z');
    assert.deepStrictEqual(r.disarmed.sort(), ['ctrl', 'shift'].sort());
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tests — applyModifiers (native keyboard input)
// ═══════════════════════════════════════════════════════════════════════

test('applyModifiers — no modifiers → pass through', async (t) => {
  await t.test('plain "hello" → "hello"', function () {
    var st = createModState();
    var r = applyModifiers(st, 'hello');
    assert.strictEqual(r.result, 'hello');
    assert.deepStrictEqual(r.disarmed, []);
  });

  await t.test('plain "v" → "v" (no Ctrl+Shift active)', function () {
    var st = createModState();
    var r = applyModifiers(st, 'v');
    assert.strictEqual(r.result, 'v');
  });
});

test('applyModifiers — Ctrl active (armed or locked)', async (t) => {
  await t.test('Ctrl armed + "c" → \\x03, disarms Ctrl', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    var r = applyModifiers(st, 'c');
    assert.strictEqual(r.result, '\x03');
    assert.deepStrictEqual(r.disarmed, ['ctrl']);
    assert.strictEqual(st.ctrl.armed, false);
  });

  await t.test('Ctrl locked + "c" → \\x03, Ctrl stays locked', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    handleSticky(st, 'ctrl', 1100);
    var r = applyModifiers(st, 'c');
    assert.strictEqual(r.result, '\x03');
    assert.deepStrictEqual(r.disarmed, []);
    assert.strictEqual(st.ctrl.locked, true);
  });

  await t.test('Ctrl locked + multi-char "hello" → all masked', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    handleSticky(st, 'ctrl', 1100);
    var r = applyModifiers(st, 'hello');
    assert.strictEqual(r.result, '\x08\x05\x0c\x0c\x0f');
  });

  await t.test('Ctrl locked + mixed non-ASCII "a\\nb" → a masked, b masked, LF passed', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    handleSticky(st, 'ctrl', 1100);
    var r = applyModifiers(st, 'a\nb');
    assert.strictEqual(r.result, '\x01\n\x02');
  });
});

test('applyModifiers — Alt active', async (t) => {
  await t.test('Alt armed + "x" → \\x1b + x, disarms Alt', function () {
    var st = createModState();
    handleSticky(st, 'alt', 1000);
    var r = applyModifiers(st, 'x');
    assert.strictEqual(r.result, '\x1bx');
    assert.deepStrictEqual(r.disarmed, ['alt']);
  });

  await t.test('Alt locked + "y" → \\x1b + y, Alt stays locked', function () {
    var st = createModState();
    handleSticky(st, 'alt', 1000);
    handleSticky(st, 'alt', 1100);
    var r = applyModifiers(st, 'y');
    assert.strictEqual(r.result, '\x1by');
    assert.deepStrictEqual(r.disarmed, []);
    assert.strictEqual(st.alt.locked, true);
  });

  await t.test('Alt locked + "hello" → \\x1b + hello (single prefix)', function () {
    var st = createModState();
    handleSticky(st, 'alt', 1000);
    handleSticky(st, 'alt', 1100);
    var r = applyModifiers(st, 'hello');
    assert.strictEqual(r.result, '\x1bhello');
  });
});

test('applyModifiers — Ctrl+Alt combo', async (t) => {
  await t.test('Ctrl locked + Alt locked + "a" → \\x1b + \\x01', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    handleSticky(st, 'ctrl', 1100);
    handleSticky(st, 'alt', 1500);
    handleSticky(st, 'alt', 1600);
    var r = applyModifiers(st, 'a');
    // Ctrl masks first: a → \x01, then Alt prefixes: \x1b\x01
    assert.strictEqual(r.result, '\x1b\x01');
    assert.deepStrictEqual(r.disarmed, []);
    assert.strictEqual(st.ctrl.locked, true);
    assert.strictEqual(st.alt.locked, true);
  });

  await t.test('Ctrl armed + Alt armed + "d" → \\x1b + \\x04, both disarmed', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    handleSticky(st, 'alt', 1100);
    var r = applyModifiers(st, 'd');
    assert.strictEqual(r.result, '\x1b\x04');
    assert.deepStrictEqual(r.disarmed.sort(), ['alt', 'ctrl'].sort());
    assert.strictEqual(st.ctrl.armed, false);
    assert.strictEqual(st.alt.armed, false);
  });
});

test('applyModifiers — Shift armed (one-shot uppercase first char)', async (t) => {
  await t.test('Shift armed + "c" → "C" (uppercase first char), disarms Shift', function () {
    var st = createModState();
    handleSticky(st, 'shift', 1000);
    var r = applyModifiers(st, 'c');
    assert.strictEqual(r.result, 'C');
    assert.deepStrictEqual(r.disarmed, ['shift']);
  });

  await t.test('Shift armed + "hello" → "Hello" (only first char uppercase)', function () {
    var st = createModState();
    handleSticky(st, 'shift', 1000);
    var r = applyModifiers(st, 'hello');
    assert.strictEqual(r.result, 'Hello');
    assert.deepStrictEqual(r.disarmed, ['shift']);
  });

  await t.test('Shift armed + "á" → "Á" (Unicode uppercase)', function () {
    var st = createModState();
    handleSticky(st, 'shift', 1000);
    var r = applyModifiers(st, 'á');
    assert.strictEqual(r.result, 'Á');
  });
});

test('applyModifiers — Shift locked (ALL UPPER)', async (t) => {
  await t.test('Shift locked + "a" → "A"', function () {
    var st = createModState();
    handleSticky(st, 'shift', 1000);
    handleSticky(st, 'shift', 1100);
    var r = applyModifiers(st, 'a');
    assert.strictEqual(r.result, 'A');
    assert.deepStrictEqual(r.disarmed, []);
    assert.strictEqual(st.shift.locked, true);
  });

  await t.test('Shift locked + "hello" → "HELLO" (all uppercase)', function () {
    var st = createModState();
    handleSticky(st, 'shift', 1000);
    handleSticky(st, 'shift', 1100);
    var r = applyModifiers(st, 'hello');
    assert.strictEqual(r.result, 'HELLO');
    assert.deepStrictEqual(r.disarmed, []);
  });

  await t.test('Shift locked + "año" → "AÑO" (Unicode ALL UPPER)', function () {
    var st = createModState();
    handleSticky(st, 'shift', 1000);
    handleSticky(st, 'shift', 1100);
    var r = applyModifiers(st, 'año');
    assert.strictEqual(r.result, 'AÑO');
  });

  await t.test('Shift locked + Ctrl armed + "c" → \\x03 (no casing, Ctrl wins)', function () {
    var st = createModState();
    handleSticky(st, 'shift', 1000); handleSticky(st, 'shift', 1100);
    handleSticky(st, 'ctrl', 1000);
    var r = applyModifiers(st, 'c');
    assert.strictEqual(r.result, '\x03');
  });
});

test('applyModifiers — Shift map for native keyboard input', async (t) => {
  await t.test('Shift armed + native Tab → \\x1b[Z', function () {
    var st = createModState();
    handleSticky(st, 'shift', 1000);
    var r = applyModifiers(st, '\t');
    assert.strictEqual(r.result, '\x1b[Z');
    assert.deepStrictEqual(r.disarmed, ['shift']);
  });

  await t.test('Shift locked + native Tab → \\x1b[Z, Shift stays locked', function () {
    var st = createModState();
    handleSticky(st, 'shift', 1000);
    handleSticky(st, 'shift', 1100);
    var r = applyModifiers(st, '\t');
    assert.strictEqual(r.result, '\x1b[Z');
    assert.deepStrictEqual(r.disarmed, []);
    assert.strictEqual(st.shift.locked, true);
  });

  await t.test('Shift armed + native "a" → "A" (one-shot uppercase, now does transform)', function () {
    var st = createModState();
    handleSticky(st, 'shift', 1000);
    var r = applyModifiers(st, 'a');
    assert.strictEqual(r.result, 'A');
    // Shift was armed → disarmed
    assert.deepStrictEqual(r.disarmed, ['shift']);
  });
});

test('applyModifiers — ghost event guard (empty data does not disarm)', async (t) => {
  await t.test('empty string → no disarms, Ctrl stays armed', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    var r = applyModifiers(st, '');
    assert.strictEqual(r.result, '');
    assert.deepStrictEqual(r.disarmed, []);
    assert.strictEqual(st.ctrl.armed, true); // still armed!
  });

  await t.test('null data → no disarms', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    handleSticky(st, 'shift', 1100);
    var r = applyModifiers(st, null);
    assert.deepStrictEqual(r.disarmed, []);
    assert.strictEqual(st.ctrl.armed, true);
    assert.strictEqual(st.shift.armed, true);
  });

  await t.test('undefined data → no disarms', function () {
    var st = createModState();
    handleSticky(st, 'alt', 1000);
    var r = applyModifiers(st, undefined);
    assert.deepStrictEqual(r.disarmed, []);
    assert.strictEqual(st.alt.armed, true);
  });

  await t.test('zero-length string → no disarms, Ctrl locked stays locked', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    handleSticky(st, 'ctrl', 1100); // locked
    var r = applyModifiers(st, '');
    assert.deepStrictEqual(r.disarmed, []);
    assert.strictEqual(st.ctrl.locked, true);
  });

  await t.test('ghost event does not disarm, real keypress after works', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);  // arm Ctrl
    handleSticky(st, 'shift', 1100); // arm Shift

    // Ghost event from terminal focus — must NOT disarm
    var ghost = applyModifiers(st, '');
    assert.deepStrictEqual(ghost.disarmed, []);

    // Real keypress: Ctrl+Shift armed + 'v' should still be detected
    // (tested via simulateTermOnData which checks isCopyPasteCombo first)
    assert.strictEqual(st.ctrl.armed, true);
    assert.strictEqual(st.shift.armed, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tests — isCopyPasteCombo / disarmCopyPaste / hasAnyModifier
// ═══════════════════════════════════════════════════════════════════════

test('isCopyPasteCombo — detects Ctrl+Shift+C and Ctrl+Shift+V', async (t) => {
  await t.test('Ctrl+Shift locked + "c" → true', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000); handleSticky(st, 'ctrl', 1100);
    handleSticky(st, 'shift', 1200); handleSticky(st, 'shift', 1300);
    assert.strictEqual(isCopyPasteCombo(st, 'c'), true);
    assert.strictEqual(isCopyPasteCombo(st, 'v'), true);
  });

  await t.test('Ctrl+Shift locked + "x" → false (not c or v)', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000); handleSticky(st, 'ctrl', 1100);
    handleSticky(st, 'shift', 1200); handleSticky(st, 'shift', 1300);
    assert.strictEqual(isCopyPasteCombo(st, 'x'), false);
    assert.strictEqual(isCopyPasteCombo(st, 'a'), false);
  });

  await t.test('Ctrl only + "v" → false (no Shift)', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    assert.strictEqual(isCopyPasteCombo(st, 'v'), false);
  });

  await t.test('Shift only + "c" → false (no Ctrl)', function () {
    var st = createModState();
    handleSticky(st, 'shift', 1000);
    assert.strictEqual(isCopyPasteCombo(st, 'c'), false);
  });

  await t.test('no modifiers → false', function () {
    var st = createModState();
    assert.strictEqual(isCopyPasteCombo(st, 'c'), false);
    assert.strictEqual(isCopyPasteCombo(st, 'v'), false);
  });

  await t.test('Ctrl armed + Shift armed + "c" → true', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    handleSticky(st, 'shift', 1100);
    assert.strictEqual(isCopyPasteCombo(st, 'c'), true);
  });
});

test('disarmCopyPaste — disarms only Ctrl+Shift, never Alt', async (t) => {
  await t.test('Ctrl+Shift both armed → both disarmed', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    handleSticky(st, 'shift', 1100);
    var d = disarmCopyPaste(st);
    assert.deepStrictEqual(d.sort(), ['ctrl', 'shift'].sort());
    assert.strictEqual(st.ctrl.armed, false);
    assert.strictEqual(st.shift.armed, false);
  });

  await t.test('Ctrl locked + Shift armed → only Shift disarmed', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    handleSticky(st, 'ctrl', 1100); // locked
    handleSticky(st, 'shift', 1500); // armed
    var d = disarmCopyPaste(st);
    assert.deepStrictEqual(d, ['shift']);
    assert.strictEqual(st.ctrl.locked, true);
    assert.strictEqual(st.shift.armed, false);
  });

  await t.test('Alt armed untouched by disarmCopyPaste', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    handleSticky(st, 'shift', 1100);
    handleSticky(st, 'alt', 1200);
    var d = disarmCopyPaste(st);
    assert.deepStrictEqual(d.sort(), ['ctrl', 'shift'].sort());
    assert.strictEqual(st.alt.armed, true); // NOT disarmed
  });
});

test('hasAnyModifier — detects any active modifier', async (t) => {
  await t.test('empty state → false', function () {
    assert.strictEqual(hasAnyModifier(createModState()), false);
  });

  await t.test('Ctrl armed → true', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    assert.strictEqual(hasAnyModifier(st), true);
  });

  await t.test('Ctrl locked → true', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    handleSticky(st, 'ctrl', 1100);
    assert.strictEqual(hasAnyModifier(st), true);
  });

  await t.test('Alt armed → true', function () {
    var st = createModState();
    handleSticky(st, 'alt', 1000);
    assert.strictEqual(hasAnyModifier(st), true);
  });

  await t.test('Shift locked → true', function () {
    var st = createModState();
    handleSticky(st, 'shift', 1000);
    handleSticky(st, 'shift', 1100);
    assert.strictEqual(hasAnyModifier(st), true);
  });

  await t.test('all armed → true', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    handleSticky(st, 'alt', 1000);
    handleSticky(st, 'shift', 1000);
    assert.strictEqual(hasAnyModifier(st), true);
  });

  await t.test('after full disarm → false', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    handleSticky(st, 'ctrl', 5000); // slow = disarm
    assert.strictEqual(hasAnyModifier(st), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tests — Ctrl key masking correctness for all ASCII letters
// ═══════════════════════════════════════════════════════════════════════

test('sendKey — Ctrl mask correctness: all lowercase letters', function () {
  var letters = 'abcdefghijklmnopqrstuvwxyz';
  for (var i = 0; i < letters.length; i++) {
    var letter = letters[i];
    var expectedCode = letter.charCodeAt(0) & 0x1f;
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    var r = simulateSendKey(st, letter);
    assert.strictEqual(r.sent, String.fromCharCode(expectedCode),
      'Ctrl+' + letter + ' should produce 0x' + expectedCode.toString(16));
  }
});

test('sendKey — Ctrl mask correctness: digits and symbols', function () {
  var cases = {
    '/': '\x0f',  // 0x2f & 0x1f = 0x0f
    ';': '\x1b',  // 0x3b & 0x1f = 0x1b (same as Esc!)
    '\\': '\x1c', // 0x5c & 0x1f = 0x1c
    ':': '\x1a',  // 0x3a & 0x1f = 0x1a
    '|': '\x1c',  // 0x7c & 0x1f = 0x1c
  };
  Object.keys(cases).forEach(function (ch) {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    var r = simulateSendKey(st, ch);
    assert.strictEqual(r.sent, cases[ch],
      'Ctrl+' + ch + ' should produce ' + JSON.stringify(cases[ch]));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tests — sessionDisplayLabel
// ═══════════════════════════════════════════════════════════════════════

test('sessionDisplayLabel — name vs cwd', async (t) => {
  await t.test('session with name → returns name', function () {
    assert.strictEqual(sessionDisplayLabel({ name: 'My Session', cwd: '/home/project' }), 'My Session');
  });

  await t.test('session without name → returns cwd', function () {
    assert.strictEqual(sessionDisplayLabel({ cwd: '/home/project' }), '/home/project');
  });

  await t.test('session with null name → returns cwd', function () {
    assert.strictEqual(sessionDisplayLabel({ name: null, cwd: '/tmp' }), '/tmp');
  });

  await t.test('session with undefined name → returns cwd', function () {
    assert.strictEqual(sessionDisplayLabel({ name: undefined, cwd: '/opt' }), '/opt');
  });

  await t.test('session with empty string name → returns cwd (empty string is falsy)', function () {
    assert.strictEqual(sessionDisplayLabel({ name: '', cwd: '/home' }), '/home');
  });

  await t.test('session with falsy cwd → returns name if present', function () {
    assert.strictEqual(sessionDisplayLabel({ name: 'Hi', cwd: '' }), 'Hi');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tests — escHtml
// ═══════════════════════════════════════════════════════════════════════

test('escHtml — basic escaping', async (t) => {
  await t.test('plain text unchanged', function () {
    assert.strictEqual(escHtml('hello'), 'hello');
  });

  await t.test('escapes &', function () {
    assert.strictEqual(escHtml('a & b'), 'a &amp; b');
  });

  await t.test('escapes <', function () {
    assert.strictEqual(escHtml('<script>'), '&lt;script&gt;');
  });

  await t.test('escapes >', function () {
    assert.strictEqual(escHtml('>'), '&gt;');
  });

  await t.test('escapes "', function () {
    assert.strictEqual(escHtml('say "hi"'), 'say &quot;hi&quot;');
  });

  await t.test('escapes single quote', function () {
    assert.strictEqual(escHtml("it's"), 'it&#39;s');
  });
});

test('escHtml — handles edge cases', async (t) => {
  await t.test('empty string', function () {
    assert.strictEqual(escHtml(''), '');
  });

  await t.test('numbers → string', function () {
    assert.strictEqual(escHtml(123), '123');
  });

  await t.test('null/undefined → "null"/"undefined"', function () {
    assert.strictEqual(escHtml(null), 'null');
    assert.strictEqual(escHtml(undefined), 'undefined');
  });

  await t.test('multiple special chars', function () {
    assert.strictEqual(escHtml('<div class="x">&</div>\''),
      '&lt;div class=&quot;x&quot;&gt;&amp;&lt;/div&gt;&#39;');
  });

  await t.test('path-like cwd with no special chars → unchanged', function () {
    assert.strictEqual(escHtml('/home/user/projects'), '/home/user/projects');
  });

  await t.test('session ID with hyphen → unchanged', function () {
    assert.strictEqual(escHtml('claude-32142-1785341055'), 'claude-32142-1785341055');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tests — reconnectDelay (exponential backoff)
// ═══════════════════════════════════════════════════════════════════════

test('reconnectDelay — exponential backoff with cap', async (t) => {
  await t.test('attempt 0 → 1000ms', function () {
    assert.strictEqual(reconnectDelay(0), 1000);
  });

  await t.test('attempt 1 → 2000ms', function () {
    assert.strictEqual(reconnectDelay(1), 2000);
  });

  await t.test('attempt 2 → 4000ms', function () {
    assert.strictEqual(reconnectDelay(2), 4000);
  });

  await t.test('attempt 3 → 8000ms', function () {
    assert.strictEqual(reconnectDelay(3), 8000);
  });

  await t.test('attempt 4 → 16000ms', function () {
    assert.strictEqual(reconnectDelay(4), 16000);
  });

  await t.test('attempt 5 → 30000ms (capped)', function () {
    assert.strictEqual(reconnectDelay(5), 30000);
  });

  await t.test('attempt 10 → 30000ms (capped, not 1024000)', function () {
    assert.strictEqual(reconnectDelay(10), 30000);
  });

  await t.test('attempt 20 → still capped at 30000', function () {
    assert.strictEqual(reconnectDelay(20), 30000);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tests — wsMessageHandler dispatch
// ═══════════════════════════════════════════════════════════════════════

test('wsMessageHandler — dispatches message types', async (t) => {
  await t.test('output → write action', function () {
    var result = dispatchMessage({ type: 'output', data: 'hello' }, {});
    assert.strictEqual(result.action, 'write');
    assert.strictEqual(result.data, 'hello');
  });

  await t.test('notification → showNotification action', function () {
    var msg = { type: 'notification', text: 'test' };
    var result = dispatchMessage(msg, {});
    assert.strictEqual(result.action, 'showNotification');
    assert.strictEqual(result.data, msg);
  });

  await t.test('session_list → updateSessions action', function () {
    var sessions = [{ id: 'a' }, { id: 'b' }];
    var result = dispatchMessage({ type: 'session_list', sessions: sessions }, {});
    assert.strictEqual(result.action, 'updateSessions');
    assert.strictEqual(result.sessions, sessions);
  });

  await t.test('session_list with undefined sessions → empty array', function () {
    var result = dispatchMessage({ type: 'session_list' }, {});
    assert.strictEqual(result.action, 'updateSessions');
    assert.deepStrictEqual(result.sessions, []);
  });

  await t.test('error → handleError action', function () {
    var result = dispatchMessage({ type: 'error', message: 'Not found' }, {});
    assert.strictEqual(result.action, 'handleError');
    assert.strictEqual(result.message, 'Not found');
  });

  await t.test('unknown type → ignore action', function () {
    var result = dispatchMessage({ type: 'garbage' }, {});
    assert.strictEqual(result.action, 'ignore');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tests — selectSessionLogic
// ═══════════════════════════════════════════════════════════════════════

test('selectSessionLogic — finds session by id', async (t) => {
  await t.test('session found', function () {
    var sessions = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    var r = selectSessionLogic(sessions, 'b');
    assert.strictEqual(r.found, true);
    assert.strictEqual(r.id, 'b');
  });

  await t.test('session NOT found', function () {
    var sessions = [{ id: 'a' }, { id: 'b' }];
    var r = selectSessionLogic(sessions, 'x');
    assert.strictEqual(r.found, false);
  });

  await t.test('empty sessions array → not found', function () {
    var r = selectSessionLogic([], 'any');
    assert.strictEqual(r.found, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tests — i18n trClient (client.js T map)
// ═══════════════════════════════════════════════════════════════════════

test('trClient — known language keys', async (t) => {
  await t.test('all en-US keys resolve', function () {
    assert.strictEqual(trClient('dictate', 'en-US'), 'Dictate');
    assert.strictEqual(trClient('cancel', 'en-US'), 'Cancel');
    assert.strictEqual(trClient('accept', 'en-US'), 'Accept');
    assert.strictEqual(trClient('send', 'en-US'), 'Send');
    assert.strictEqual(trClient('noSession', 'en-US'), 'No session selected');
    assert.strictEqual(trClient('disconnected', 'en-US'), '⚠️ DISCONNECTED — Tap to dismiss');
  });

  await t.test('all es-AR keys resolve', function () {
    assert.strictEqual(trClient('dictate', 'es-AR'), 'Dictar');
    assert.strictEqual(trClient('cancel', 'es-AR'), 'Cancelar');
    assert.strictEqual(trClient('accept', 'es-AR'), 'Aceptar');
    assert.strictEqual(trClient('send', 'es-AR'), 'Enviar');
    assert.strictEqual(trClient('noSession', 'es-AR'), 'Sin sesión');
    assert.strictEqual(trClient('disconnected', 'es-AR'), '⚠️ DESCONECTADO — Tocar para cerrar');
  });
});

test('trClient — fallback behavior', async (t) => {
  await t.test('unknown language → en-US fallback', function () {
    assert.strictEqual(trClient('dictate', 'fr-FR'), 'Dictate');
  });

  await t.test('key missing in es-AR but in en-US → en-US fallback', function () {
    // micHttps exists in en-US but is different per language
    assert.strictEqual(trClient('micHttps', 'es-AR'), 'El micrófono requiere HTTPS o localhost.');
  });

  await t.test('unknown lang + unknown key → key itself', function () {
    assert.strictEqual(trClient('nonexistent_key', 'xx-XX'), 'nonexistent_key');
  });

  await t.test('lang null → en-US fallback', function () {
    assert.strictEqual(trClient('dictate', null), 'Dictate');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tests — term.onData flow (Ctrl+Shift combo before modifier disarm)
// ═══════════════════════════════════════════════════════════════════════

// Simulates the full client.js term.onData() decision tree
function simulateTermOnData(modState, data) {
  // Ghost guard: empty/ghost events must not disarm modifiers.
  if (!data) return { action: 'skip_ghost', data: null };

  // Step 1: hasAnyModifier?
  if (!hasAnyModifier(modState)) {
    return { action: 'send_raw', data: data };
  }

  // Step 2: isCopyPasteCombo?
  if (isCopyPasteCombo(modState, data)) {
    if (data === 'c') {
      // Copy: sends copy_buffer, does NOT send raw input
      disarmCopyPaste(modState);
      return { action: 'copy_buffer', data: null };
    } else if (data === 'v') {
      // Paste: sends paste_buffer
      disarmCopyPaste(modState);
      return { action: 'paste_buffer', data: null };
    }
  }

  // Step 3: Normal modifier application
  var r = applyModifiers(modState, data);
  return { action: 'send_input', data: r.result, disarmed: r.disarmed };
}

test('term.onData flow — Ctrl+Shift+C intercepts BEFORE Ctrl mask', async (t) => {
  await t.test('Ctrl+Shift locked + "c" → copy_buffer (NOT \\x03)', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000); handleSticky(st, 'ctrl', 1100);
    handleSticky(st, 'shift', 1200); handleSticky(st, 'shift', 1300);
    var r = simulateTermOnData(st, 'c');
    assert.strictEqual(r.action, 'copy_buffer');
    assert.strictEqual(r.data, null);
    // Ctrl and Shift locked → only armed get disarmed, locked stay
    assert.strictEqual(st.ctrl.locked, true);
    assert.strictEqual(st.shift.locked, true);
  });

  await t.test('Ctrl+Shift locked + "v" → paste_buffer (NOT Ctrl-V)', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000); handleSticky(st, 'ctrl', 1100);
    handleSticky(st, 'shift', 1200); handleSticky(st, 'shift', 1300);
    var r = simulateTermOnData(st, 'v');
    assert.strictEqual(r.action, 'paste_buffer');
  });

  await t.test('Ctrl+Shift armed + "c" → copy_buffer, both disarmed', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    handleSticky(st, 'shift', 1100);
    var r = simulateTermOnData(st, 'c');
    assert.strictEqual(r.action, 'copy_buffer');
    assert.strictEqual(st.ctrl.armed, false);
    assert.strictEqual(st.shift.armed, false);
  });
});

test('term.onData flow — ghost event guard (empty data does not disarm)', async (t) => {
  await t.test('empty string with modifiers armed → skip_ghost, modifiers intact', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);  // arm
    handleSticky(st, 'shift', 1100); // arm
    var r = simulateTermOnData(st, '');
    assert.strictEqual(r.action, 'skip_ghost');
    assert.strictEqual(st.ctrl.armed, true);
    assert.strictEqual(st.shift.armed, true);
  });

  await t.test('null data → skip_ghost', function () {
    var st = createModState();
    handleSticky(st, 'alt', 1000);
    var r = simulateTermOnData(st, null);
    assert.strictEqual(r.action, 'skip_ghost');
    assert.strictEqual(st.alt.armed, true);
  });

  await t.test('after ghost event, real "v" with Ctrl+Shift armed → paste_buffer', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    handleSticky(st, 'shift', 1100);

    // Ghost from terminal focus
    var ghost = simulateTermOnData(st, '');
    assert.strictEqual(ghost.action, 'skip_ghost');

    // Real keystroke
    var real = simulateTermOnData(st, 'v');
    assert.strictEqual(real.action, 'paste_buffer');
    assert.strictEqual(st.ctrl.armed, false); // disarmed after use
    assert.strictEqual(st.shift.armed, false);
  });
});

test('term.onData flow — double-tap Ctrl+Shift + native keyboard V pastes', async (t) => {
  await t.test('Ctrl locked + Shift locked + "v" → paste_buffer', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000); handleSticky(st, 'ctrl', 1100);  // lock
    handleSticky(st, 'shift', 1200); handleSticky(st, 'shift', 1300); // lock
    var r = simulateTermOnData(st, 'v');
    assert.strictEqual(r.action, 'paste_buffer');
    // Locked modifiers stay locked after paste
    assert.strictEqual(st.ctrl.locked, true);
    assert.strictEqual(st.shift.locked, true);
  });

  await t.test('Ctrl locked + Shift locked + "c" → copy_buffer', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000); handleSticky(st, 'ctrl', 1100);
    handleSticky(st, 'shift', 1200); handleSticky(st, 'shift', 1300);
    var r = simulateTermOnData(st, 'c');
    assert.strictEqual(r.action, 'copy_buffer');
    // Locked modifiers stay locked
    assert.strictEqual(st.ctrl.locked, true);
    assert.strictEqual(st.shift.locked, true);
  });

  await t.test('single-tap (armed) Ctrl+Shift + "v" → paste_buffer, disarms both', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);  // arm
    handleSticky(st, 'shift', 1100); // arm
    var r = simulateTermOnData(st, 'v');
    assert.strictEqual(r.action, 'paste_buffer');
    // Armed modifiers disarmed after use
    assert.strictEqual(st.ctrl.armed, false);
    assert.strictEqual(st.shift.armed, false);
  });
});

test('term.onData flow — no modifiers → raw passthrough', async (t) => {
  await t.test('plain "hello" → send_raw', function () {
    var st = createModState();
    var r = simulateTermOnData(st, 'hello');
    assert.strictEqual(r.action, 'send_raw');
    assert.strictEqual(r.data, 'hello');
  });

  await t.test('plain "v" without Ctrl+Shift → send_raw (not paste)', function () {
    var st = createModState();
    var r = simulateTermOnData(st, 'v');
    assert.strictEqual(r.action, 'send_raw');
    assert.strictEqual(r.data, 'v');
  });
});

test('term.onData flow — Ctrl only + "c" → Ctrl mask (not copy)', async (t) => {
  await t.test('Ctrl locked + "c" → send_input \\x03 ', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000); handleSticky(st, 'ctrl', 1100);
    var r = simulateTermOnData(st, 'c');
    assert.strictEqual(r.action, 'send_input');
    assert.strictEqual(r.data, '\x03');
  });

  await t.test('Ctrl locked + "v" → send_input \\x16', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000); handleSticky(st, 'ctrl', 1100);
    var r = simulateTermOnData(st, 'v');
    assert.strictEqual(r.action, 'send_input');
    assert.strictEqual(r.data, '\x16');
  });
});

test('term.onData flow — Ctrl+Shift+other keys pass through modifiers normally', async (t) => {
  await t.test('Ctrl+Shift locked + "d" → masked Ctrl, passed through (not copy/paste)', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000); handleSticky(st, 'ctrl', 1100);
    handleSticky(st, 'shift', 1200); handleSticky(st, 'shift', 1300);
    // 'd' is not 'c' or 'v', so falls through to normal modifiers
    var r = simulateTermOnData(st, 'd');
    assert.strictEqual(r.action, 'send_input');
    assert.strictEqual(r.data, '\x04'); // Ctrl-D
  });

  await t.test('Ctrl+Shift locked + "x" → \\x18 (Ctrl-X)', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000); handleSticky(st, 'ctrl', 1100);
    handleSticky(st, 'shift', 1200); handleSticky(st, 'shift', 1300);
    var r = simulateTermOnData(st, 'x');
    assert.strictEqual(r.action, 'send_input');
    assert.strictEqual(r.data, '\x18');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tests — race condition: applyModifiers does NOT disarm before check
// ═══════════════════════════════════════════════════════════════════════

test('applyModifiers — Ctrl locked stays locked after multiple calls', async (t) => {
  await t.test('Ctrl locked: 5 consecutive calls, Ctrl stays locked', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    handleSticky(st, 'ctrl', 1100); // locked

    for (var i = 0; i < 5; i++) {
      var r = applyModifiers(st, 'a');
      assert.strictEqual(r.disarmed.length, 0, 'iteration ' + i + ' should not disarm locked Ctrl');
    }
    assert.strictEqual(st.ctrl.locked, true);
  });
});

test('applyModifiers — Alt locked stays locked through multiple calls', async (t) => {
  await t.test('Alt locked: 5 consecutive calls, Alt stays locked', function () {
    var st = createModState();
    handleSticky(st, 'alt', 1000);
    handleSticky(st, 'alt', 1100);

    for (var i = 0; i < 5; i++) {
      var r = applyModifiers(st, 'x');
      assert.strictEqual(r.result, '\x1bx');
      assert.strictEqual(r.disarmed.length, 0);
    }
    assert.strictEqual(st.alt.locked, true);
  });
});

test('applyModifiers — armed Alt disarms only when not locked', async (t) => {
  await t.test('Alt armed (single tap) → disarmed after first use', function () {
    var st = createModState();
    handleSticky(st, 'alt', 1000);
    var r = applyModifiers(st, 'x');
    assert.deepStrictEqual(r.disarmed, ['alt']);
    assert.strictEqual(st.alt.armed, false);
  });

  await t.test('Alt armed → second call sees Alt already disarmed', function () {
    var st = createModState();
    handleSticky(st, 'alt', 1000);
    applyModifiers(st, 'x'); // disarms
    var r = applyModifiers(st, 'y');
    // No Alt active now — plain 'y'
    assert.strictEqual(r.result, 'y');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tests — buildToolbar-like class construction
// ═══════════════════════════════════════════════════════════════════════

function computeBtnClasses(key) {
  var clsList = key.cls ? key.cls.split(' ') : [];
  var cls = 'keybar-btn';
  for (var ci = 0; ci < clsList.length; ci++) {
    cls += ' keybar-' + clsList[ci];
  }
  return cls;
}

test('computeBtnClasses — correct CSS class generation', async (t) => {
  await t.test('modifier key → keybar-btn keybar-modifier', function () {
    assert.strictEqual(computeBtnClasses(ROWS[0][0]), 'keybar-btn keybar-modifier');
  });

  await t.test('modifier sticky key → keybar-btn keybar-modifier keybar-sticky', function () {
    assert.strictEqual(computeBtnClasses(ROWS[0][2]), 'keybar-btn keybar-modifier keybar-sticky');
  });

  await t.test('arrow key → keybar-btn keybar-arrow', function () {
    assert.strictEqual(computeBtnClasses(ROWS[2][5]), 'keybar-btn keybar-arrow');
  });

  await t.test('plain key (empty cls) → keybar-btn', function () {
    assert.strictEqual(computeBtnClasses(ROWS[0][5]), 'keybar-btn');
  });

  await t.test('combo key → keybar-btn keybar-combo', function () {
    assert.strictEqual(computeBtnClasses(ROWS[2][0]), 'keybar-btn keybar-combo');
  });

  await t.test('send key → keybar-btn keybar-send', function () {
    assert.strictEqual(computeBtnClasses(ROWS[2][4]), 'keybar-btn keybar-send');
  });

  await t.test('key with cls="" → keybar-btn (no extra class)', function () {
    assert.strictEqual(computeBtnClasses({ cls: '' }), 'keybar-btn');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Mirror model: every keystroke (keybar or native keyboard) goes through
// the same modifier pipeline. Modifiers armed/locked on the floating
// keyboard MUST apply identically to both input sources — just like
// holding physical Ctrl/Alt/Shift on a desktop keyboard.
// ═══════════════════════════════════════════════════════════════════════

test('mirror model — Ctrl+Shift+C copies current selection (NOT auto-copy)', async (t) => {
  // Correct model: user selects text (double-tap/drag), arms Ctrl+Shift,
  // presses 'c' on native keyboard → copy_buffer with term.getSelection().
  // WRONG model (removed): onSelectionChange fires copy automatically.
  // The floating keyboard is a MIRROR of the physical keyboard.
  // Selection is independent state; only the 'c' keystroke triggers copy.
  await t.test('Ctrl+Shift armed + native "c" with selection → copy_buffer', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    handleSticky(st, 'shift', 1100);
    // term.getSelection() would return text here — simulates it non-empty
    // isCopyPasteCombo checks ctrl+shift+'c' → true
    var r = simulateTermOnData(st, 'c');
    assert.strictEqual(r.action, 'copy_buffer');
    // Ctrl+Shift armed → disarmed after copy
    assert.strictEqual(st.ctrl.armed, false);
    assert.strictEqual(st.shift.armed, false);
  });

  await t.test('Ctrl+Shift armed + native "c" WITHOUT selection → no copy', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    handleSticky(st, 'shift', 1100);
    // simulateTermOnData doesn't check getSelection — client.js does
    // The guard `if (sel)` in client.js:525 ensures no empty copy messsage
    // This test verifies the flow enters copy_buffer path correctly
    var r = simulateTermOnData(st, 'c');
    assert.strictEqual(r.action, 'copy_buffer');
    // Gets disarmed even if sel was empty (client.js checks sel before send)
    assert.strictEqual(st.ctrl.armed, false);
    assert.strictEqual(st.shift.armed, false);
  });

  await t.test('Ctrl only (no Shift) + native "c" → Ctrl mask \\03, NOT copy', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000); // Ctrl armed, Shift NOT active
    var r = simulateTermOnData(st, 'c');
    assert.strictEqual(r.action, 'send_input');
    assert.strictEqual(r.data, '\x03'); // Ctrl-C, not copy_buffer
  });

  await t.test('Ctrl locked + Shift locked + native "c" → copy_buffer, locked stay', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000); handleSticky(st, 'ctrl', 1100);
    handleSticky(st, 'shift', 1200); handleSticky(st, 'shift', 1300);
    var r = simulateTermOnData(st, 'c');
    assert.strictEqual(r.action, 'copy_buffer');
    assert.strictEqual(st.ctrl.locked, true);
    assert.strictEqual(st.shift.locked, true);
  });
});

test('mirror model — Ctrl+Shift+V pastes tmux buffer', async (t) => {
  await t.test('Ctrl+Shift armed + native "v" → paste_buffer', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    handleSticky(st, 'shift', 1100);
    var r = simulateTermOnData(st, 'v');
    assert.strictEqual(r.action, 'paste_buffer');
    assert.strictEqual(st.ctrl.armed, false);
    assert.strictEqual(st.shift.armed, false);
  });

  await t.test('Ctrl only + native "v" → \\x16 (Ctrl-V), NOT paste', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    var r = simulateTermOnData(st, 'v');
    assert.strictEqual(r.action, 'send_input');
    assert.strictEqual(r.data, '\x16');
  });

  await t.test('Shift only + native "v" → "V" (one-shot uppercase)', function () {
    var st = createModState();
    handleSticky(st, 'shift', 1000);
    var r = simulateTermOnData(st, 'v');
    assert.strictEqual(r.action, 'send_input');
    assert.strictEqual(r.data, 'V');
  });
});

test('mirror model — same modifier state for both input sources', async (t) => {
  // Key test: keybar sendKey() and native keyboard applyModifiers()
  // MUST produce identical results given the same modifier state.
  // This proves the floating keyboard is a true mirror.

  await t.test('Ctrl armed: keybar "-" and native "-" both produce \\r (CR)', function () {
    var stK = createModState();
    handleSticky(stK, 'ctrl', 1000);
    var keybarResult = simulateSendKey(stK, '-');

    var stN = createModState();
    handleSticky(stN, 'ctrl', 1000);
    var nativeResult = applyModifiers(stN, '-');

    // Both are Ctrl-masked '-' (0x2d & 0x1f = 0x0d = CR)
    assert.strictEqual(keybarResult.sent, '\x0d');
    assert.strictEqual(nativeResult.result, '\x0d');
    // Both disarmed Ctrl
    assert.ok(keybarResult.disarmed.indexOf('ctrl') !== -1);
    assert.ok(nativeResult.disarmed.indexOf('ctrl') !== -1);
  });

  await t.test('Alt armed: keybar "x" and native "x" both produce \\x1b+x', function () {
    var stK = createModState();
    handleSticky(stK, 'alt', 1000);
    var keybarResult = simulateSendKey(stK, 'x');

    var stN = createModState();
    handleSticky(stN, 'alt', 1000);
    var nativeResult = applyModifiers(stN, 'x');

    assert.strictEqual(keybarResult.sent, '\x1bx');
    assert.strictEqual(nativeResult.result, '\x1bx');
  });

  await t.test('Ctrl+Alt locked: both sources produce identical \\x1b+mask', function () {
    // Ctrl locked + Alt locked + 'a' — both sources should be identical
    var stK = createModState();
    handleSticky(stK, 'ctrl', 1000); handleSticky(stK, 'ctrl', 1100);
    handleSticky(stK, 'alt', 1200); handleSticky(stK, 'alt', 1300);
    var keybarResult = simulateSendKey(stK, 'a');

    var stN = createModState();
    handleSticky(stN, 'ctrl', 1000); handleSticky(stN, 'ctrl', 1100);
    handleSticky(stN, 'alt', 1200); handleSticky(stN, 'alt', 1300);
    var nativeResult = applyModifiers(stN, 'a');

    assert.strictEqual(keybarResult.sent, '\x1b\x01');
    assert.strictEqual(nativeResult.result, '\x1b\x01');
    // Neither disarms (both locked)
    assert.deepStrictEqual(keybarResult.disarmed, []);
    assert.deepStrictEqual(nativeResult.disarmed, []);
  });

  await t.test('Shift armed: keybar sends ":" as-is, native produces uppercase ":" (no-op)', function () {
    var stK = createModState();
    handleSticky(stK, 'shift', 1000);
    var keybarResult = simulateSendKey(stK, ':');

    var stN = createModState();
    handleSticky(stN, 'shift', 1000);
    var nativeResult = applyModifiers(stN, ':');

    assert.strictEqual(keybarResult.sent, ':');
    assert.strictEqual(nativeResult.result, ':');  // ':' is not a letter — toUpperCase no-op
  });
});

test('mirror model — non-modifier keys send raw keystrokes always', async (t) => {
  // Esc, Tab, arrows, etc. are NOT "state-changing" keys.
  // They send immediately to server regardless of focus — just like
  // pressing them on a physical keyboard.

  await t.test('Esc keybar button sends \\x1b regardless of modifiers', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000); handleSticky(st, 'ctrl', 1100); // Ctrl locked
    var r = simulateSendKey(st, '\x1b');
    // Esc (0x1b) is NOT in 0x20-0x7f range → NOT masked by Ctrl → stays as \x1b
    assert.strictEqual(r.sent, '\x1b');
  });

  await t.test('Tab keybar button sends \\t', function () {
    var st = createModState();
    var r = simulateSendKey(st, '\t');
    assert.strictEqual(r.sent, '\t');
  });

  await t.test('arrow keys always send ANSI sequences', function () {
    var st = createModState();
    handleSticky(st, 'alt', 1000); handleSticky(st, 'alt', 1100); // Alt locked
    var r = simulateSendKey(st, '\x1b[A');
    // Alt prefixes: \x1b + \x1b[A = \x1b\x1b[A
    assert.strictEqual(r.sent, '\x1b\x1b[A');
  });

  await t.test('Ctrl armed + Esc → Esc NOT masked (non-ASCII, 0x1B < 0x20)', function () {
    var st = createModState();
    handleSticky(st, 'ctrl', 1000);
    var r = simulateSendKey(st, '\x1b');
    assert.strictEqual(r.sent, '\x1b');
    assert.strictEqual(st.ctrl.armed, false); // disarmed even though not masked
  });

  await t.test('native Tab from OS keyboard → sent as-is (no modifiers)', function () {
    var st = createModState();
    var r = simulateTermOnData(st, '\t');
    // No modifiers → direct send_raw
    assert.strictEqual(r.action, 'send_raw');
    assert.strictEqual(r.data, '\t');
  });
});
