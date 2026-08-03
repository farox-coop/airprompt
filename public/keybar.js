// ── Keybar: on-screen keyboard toolbar for mobile terminals ───────────
(function () {
  'use strict';

  // Shift modifier does NOT transform characters — it is purely a sticky
  // modifier to combine with Ctrl/Alt for terminal shortcuts (e.g. Ctrl+Shift+C).
  // In a raw PTY, Ctrl+Shift+letter sends the same control char as Ctrl+letter.

  // ── Key definitions ──────────────────────────────────────────────────
  var SPACER = { label: '', seq: null, cls: 'spacer' };

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
      { label: 'S+T',   seq: '\x1b[Z',   cls: 'combo', raw: true },
      { label: 'Undo',  seq: '/rewind\r', cls: 'combo', raw: true },
      { label: 'Stash', seq: '\x13',     cls: 'combo', raw: true },
      { label: 'Search',seq: '\x12',     cls: 'combo', raw: true },
      { label: 'Send',  seq: '\r',       cls: 'send', raw: true,
        html: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/></svg>' },
      { label: '←',     seq: '\x1b[D',   cls: 'arrow' },
      { label: '↓',     seq: '\x1b[B',   cls: 'arrow' },
      { label: '→',     seq: '\x1b[C',   cls: 'arrow' },
    ],
  ];

  // ── State ─────────────────────────────────────────────────────────────
  var container = null;
  var modBtns = {};       // { ctrl: btn, alt: btn, shift: btn }
  var modState = {
    ctrl:  { armed: false, locked: false, lastTap: 0 },
    alt:   { armed: false, locked: false, lastTap: 0 },
    shift: { armed: false, locked: false, lastTap: 0 },
  };
  var DOUBLE_TAP_MS = 300;

  // ── Helpers ───────────────────────────────────────────────────────────
  // SHIFT_MAP: terminal control sequences → Shift-modified version.
  // This is NOT character casing (a→A). It maps terminal escape codes
  // that change when Shift is held (e.g. Tab → reverse tab \x1b[Z]).
  var SHIFT_MAP = {
    '\t': '\x1b[Z',   // Tab → Shift+Tab (reverse tab)
  };

  function isMobile() {
    try {
      return window.matchMedia('(pointer: coarse)').matches;
    } catch (_) { return false; }
  }

  // Re-focus mobile input to keep native Android keyboard open.
  // keybar buttons have tabindex=-1 but the browser still transfers
  // focus on touch → virtual keyboard dismisses → user forced to re-tap.
  // Must suppress disarm: refocus can trigger spurious onData events
  // that would disarm one-shot modifiers via applyModifiers().
  function refocusMobileInput() {
    if (!isMobile()) return;
    suppressDisarm(300);
    var mi = document.getElementById('mobile-input');
    if (mi) {
      try { mi.focus(); } catch (_) {}
    }
  }

  function sendKey(seq) {
    if (!seq) return;

    // Apply sticky Ctrl: mask ASCII chars with 0x1f
    var s = modState.ctrl;
    if ((s.armed || s.locked) && seq.length === 1) {
      var code = seq.charCodeAt(0);
      if (code >= 0x20 && code < 0x7f) {
        seq = String.fromCharCode(code & 0x1f);
      }
    }
    if (s.armed) { s.armed = false; updateModUI(); }

    // Apply sticky Alt: prefix \x1b
    var a = modState.alt;
    if (a.armed || a.locked) {
      seq = '\x1b' + seq;
      if (!a.locked) { a.armed = false; updateModUI(); }
    }

    // Apply sticky Shift: map known control sequences. Only for keys in
    // SHIFT_MAP — regular characters are NOT transformed (a stays a).
    var sh = modState.shift;
    if ((sh.armed || sh.locked) && SHIFT_MAP[seq]) {
      seq = SHIFT_MAP[seq];
    }
    if (sh.armed) { sh.armed = false; updateModUI(); }

    if (window._airpromptSend) {
      window._airpromptSend({ type: 'input', data: seq });
    }
    // tabindex=-1 on buttons prevents focus theft from xterm's textarea.
    // Do NOT force focus() here — it opens the native keyboard even for
    // keys that don't need it (Esc, Tab, arrows). Focus stays where it
    // was; if the user had the native keyboard open, it stays open.
  }

  function updateModUI() {
    for (var mod in modState) {
      var btn = modBtns[mod];
      if (!btn) continue;
      btn.classList.toggle('armed', modState[mod].armed);
      btn.classList.toggle('locked', modState[mod].locked);
    }
  }

  function handleSticky(mod) {
    var now = Date.now();
    var s = modState[mod];
    if (!s) return;

    if (s.locked) {
      // Locked → unlock (completely disarm)
      s.locked = false;
      s.armed = false;
    } else if (s.armed) {
      // Armed: double-tap within window → lock, otherwise disarm
      if (now - s.lastTap <= DOUBLE_TAP_MS) {
        s.armed = false;
        s.locked = true;
      } else {
        s.armed = false;
      }
    } else {
      // Idle → arm (start double-tap window)
      s.armed = true;
      s.lastTap = now;
    }

    updateModUI();
    // NOTE: do NOT call refocusTerminal() here. Modifier buttons have
    // tabindex=-1 so focus stays in xterm's textarea naturally. Forcing
    // focus() would open the native keyboard and trigger xterm.js flushes
    // through onData, which could send spurious keystrokes to the shell.
  }

  // ── Build DOM ─────────────────────────────────────────────────────────
  function buildToolbar() {
    container = document.getElementById('keybar-container');
    if (!container) return;

    container.innerHTML = '';

    for (var ri = 0; ri < ROWS.length; ri++) {
      var row = ROWS[ri];
      var rowDiv = document.createElement('div');
      rowDiv.className = 'keybar-row';
      rowDiv.style.gridTemplateColumns = 'repeat(' + row.length + ', 1fr)';

      for (var ki = 0; ki < row.length; ki++) {
        var key = row[ki];
        var clsList = key.cls ? key.cls.split(' ') : [];

        // Spacer: invisible placeholder for layout
        if (clsList.indexOf('spacer') !== -1) {
          var spacer = document.createElement('div');
          spacer.className = 'keybar-spacer';
          spacer.setAttribute('aria-hidden', 'true');
          rowDiv.appendChild(spacer);
          continue;
        }

        var btn = document.createElement('button');
        btn.className = 'keybar-btn';
        for (var ci = 0; ci < clsList.length; ci++) {
          btn.className += ' keybar-' + clsList[ci];
        }
        if (key.html) {
          btn.innerHTML = key.html;
          btn.setAttribute('aria-label', key.label);
        } else {
          btn.textContent = key.label;
          btn.setAttribute('aria-label', key.id || key.label);
        }
        // Prevent button from stealing focus from xterm.js textarea.
        // On mobile, focus loss dismisses the virtual keyboard. When the
        // user re-taps the terminal to bring it back, xterm.js fires
        // onData with buffered IME content → modifier pipeline processes
        // it → one-shot (armed) Ctrl/Shift get disarmed. tabindex=-1
        // keeps focus in xterm.js, keyboard stays open.
        btn.setAttribute('tabindex', '-1');

        if (key.id && modState[key.id]) {
          // Sticky modifier key
          modBtns[key.id] = btn;
          (function (m) {
            btn.addEventListener('click', function () { handleSticky(m); refocusMobileInput(); });
          })(key.id);
        } else if (key.raw && key.seq) {
          // Combo key: send pre-composed sequence, bypass modifier pipeline
          (function (s) {
            btn.addEventListener('click', function () {
              if (window._airpromptSend) {
                window._airpromptSend({ type: 'input', data: s });
              }
              refocusMobileInput();
            });
          })(key.seq);
        } else {
          (function (s) {
            btn.addEventListener('click', function () { sendKey(s); refocusMobileInput(); });
          })(key.seq);
        }

        rowDiv.appendChild(btn);
      }

      container.appendChild(rowDiv);
    }
  }

  function toggle() {
    if (!container) return;
    var hidden = container.classList.toggle('keybar-hidden');
    var toggleBtn = document.getElementById('keybar-toggle');
    if (toggleBtn) {
      toggleBtn.classList.toggle('active', !hidden);
    }
  }

  function init() {
    buildToolbar();

    if (!isMobile()) {
      var toggle = document.getElementById('keybar-toggle');
      toggle && (toggle.style.display = 'none');
      container && container.classList.add('keybar-hidden');
    } else {
      container && container.classList.add('keybar-hidden');
    }
  }

  var _focusGraceUntil = 0;  // suppress disarm until this timestamp

  // ── Apply modifiers to data from native keyboard ──────────────────────
  // Called by client.js term.onData() to inject Ctrl/Alt/Shift before send.
  // Returns Promise<string|null> — null means already handled, don't send.
  function applyModifiers(data) {
    // Guard: empty/ghost events must not disarm one-shot modifiers.
    if (!data) return Promise.resolve(data);

    var ctrl  = modState.ctrl.armed  || modState.ctrl.locked;
    var alt   = modState.alt.armed   || modState.alt.locked;
    var shift = modState.shift.armed || modState.shift.locked;

    // Disarm one-shot modifiers (locked stay active)
    var inGrace = Date.now() < _focusGraceUntil;
    if (!inGrace) {
      if (modState.ctrl.armed)  { modState.ctrl.armed = false; }
      if (modState.alt.armed && !modState.alt.locked) {
        modState.alt.armed = false;
      }
      if (modState.shift.armed) { modState.shift.armed = false; }
      updateModUI();
    }

    var result = data;

    // Apply Ctrl mask per code point (emoji-safe — iterates chars, not UTF-16 units)
    if (ctrl) {
      var masked = '';
      var chars = Array.from(result);
      for (var i = 0; i < chars.length; i++) {
        var code = chars[i].codePointAt(0);
        if (code >= 0x20 && code < 0x7f) {
          masked += String.fromCharCode(code & 0x1f);
        } else {
          masked += chars[i];
        }
      }
      result = masked;
    }

    // Apply Alt prefix (single \x1b, not per-char)
    if (alt) {
      result = '\x1b' + result;
    }

    // Apply Shift map — terminal control sequences + char casing.
    // SHIFT_MAP: known control sequences (e.g. Tab → Shift+Tab).
    // Character casing: armed (one-shot) → first letter uppercase.
    // Locked (double-tap) → ALL letters uppercase.
    // Uses String.prototype.toUpperCase() for full Unicode coverage
    // (handles accented letters like áéíóúüñ correctly).
    if (shift) {
      if (SHIFT_MAP[result]) {
        result = SHIFT_MAP[result];
      } else if (!ctrl) {
        if (modState.shift.locked) {
          result = result.toUpperCase();
        } else {
          // One-shot: uppercase first character only
          var chars = Array.from(result);
          if (chars.length > 0) chars[0] = chars[0].toUpperCase();
          result = chars.join('');
        }
      }
    }

    return Promise.resolve(result);
  }

  // ── Check if Ctrl+Shift+<key> combo is active ─────────────────────────
  // These are pure checks — client.js calls them before applyModifiers()
  // to decide whether to send copy_buffer / paste_buffer to server.
  function isCopyPasteCombo(key) {
    var ctrl  = modState.ctrl.armed  || modState.ctrl.locked;
    var shift = modState.shift.armed || modState.shift.locked;
    return ctrl && shift && (key === 'c' || key === 'v');
  }

  function disarmCopyPaste() {
    if (modState.ctrl.armed)  { modState.ctrl.armed = false; }
    if (modState.shift.armed) { modState.shift.armed = false; }
    updateModUI();
  }

  function hasAnyModifier() {
    return modState.ctrl.armed  || modState.ctrl.locked ||
           modState.alt.armed   || modState.alt.locked  ||
           modState.shift.armed || modState.shift.locked;
  }

  function suppressDisarm(ms) {
    _focusGraceUntil = Date.now() + (ms || 300);
  }

  // ── Exports ───────────────────────────────────────────────────────────
  window._airpromptKeybar = {
    toggle: toggle,
    sendKey: sendKey,
    hasAnyModifier: hasAnyModifier,
    applyModifiers: applyModifiers,
    isCopyPasteCombo: isCopyPasteCombo,
    disarmCopyPaste: disarmCopyPaste,
    suppressDisarm: suppressDisarm,
  };

  // ── Start ─────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
