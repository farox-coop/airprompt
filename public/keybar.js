// ── Keybar: on-screen keyboard toolbar for mobile terminals ───────────
(function () {
  'use strict';

  // ── Key definitions ──────────────────────────────────────────────────
  var ROWS = [
    [
      { label: 'Esc',   seq: '\x1b',     cls: 'modifier' },
      { label: 'Tab',   seq: '\t',       cls: 'modifier' },
      { label: 'Ctrl',  seq: null,       cls: 'modifier sticky', id: 'ctrl' },
      { label: 'Alt',   seq: null,       cls: 'modifier sticky', id: 'alt' },
      { label: '-',     seq: '-',        cls: '' },
      { label: '/',     seq: '/',        cls: '' },
      { label: '.',     seq: '.',        cls: '' },
      { label: '|',     seq: '|',        cls: '' },
    ],
    [
      { label: '↑', seq: '\x1b[A',  cls: 'arrow' },
      { label: '↓', seq: '\x1b[B',  cls: 'arrow' },
      { label: '←', seq: '\x1b[D',  cls: 'arrow' },
      { label: '→', seq: '\x1b[C',  cls: 'arrow' },
      { label: 'Home',  seq: '\x1b[H',   cls: '' },
      { label: 'End',   seq: '\x1b[F',   cls: '' },
    ],
    [
      { label: 'PgUp',  seq: '\x1b[5~',  cls: '' },
      { label: 'PgDn',  seq: '\x1b[6~',  cls: '' },
      { label: 'Del',   seq: '\x1b[3~',  cls: '' },
      { label: ':',     seq: ':',        cls: '' },
    ],
  ];

  // ── State ─────────────────────────────────────────────────────────────
  var container = null;
  var ctrlBtn = null;
  var altBtn = null;
  var ctrlArmed = false;
  var ctrlLocked = false;
  var altArmed = false;
  var altLocked = false;
  var ctrlLastTap = 0;
  var altLastTap = 0;
  var DOUBLE_TAP_MS = 300;

  // ── Helpers ───────────────────────────────────────────────────────────
  function isMobile() {
    try {
      return window.matchMedia('(pointer: coarse)').matches;
    } catch (_) { return false; }
  }

  function sendKey(seq) {
    if (!seq) return;

    // Apply sticky Ctrl: mask ASCII chars with 0x1f
    if ((ctrlArmed || ctrlLocked) && seq.length === 1) {
      var code = seq.charCodeAt(0);
      if (code >= 0x20 && code < 0x7f) {
        seq = String.fromCharCode(code & 0x1f);
      }
    }
    // Disarm Ctrl after any keypress (armed is single-shot).
    // Always disarm even on multi-char sequences (arrows, Home, etc.)
    // where the mask wasn't applied — otherwise Ctrl stays blue forever.
    if (ctrlArmed) { ctrlArmed = false; updateModUI(); }

    // Apply sticky Alt: prefix \x1b
    if (altArmed || altLocked) {
      seq = '\x1b' + seq;
      if (!altLocked) { altArmed = false; updateModUI(); }
    }

    if (window._airpromptSend) {
      window._airpromptSend({ type: 'input', data: seq });
    }
  }

  function updateModUI() {
    if (ctrlBtn) {
      ctrlBtn.classList.toggle('armed', ctrlArmed);
      ctrlBtn.classList.toggle('locked', ctrlLocked);
    }
    if (altBtn) {
      altBtn.classList.toggle('armed', altArmed);
      altBtn.classList.toggle('locked', altLocked);
    }
  }

  function handleSticky(mod) {
    var now = Date.now();

    if (mod === 'ctrl') {
      if (ctrlLocked) {
        // Locked → unlock (completely disarm)
        ctrlLocked = false;
        ctrlArmed = false;
      } else if (ctrlArmed) {
        // Armed: double-tap → lock, otherwise disarm
        if (now - ctrlLastTap <= DOUBLE_TAP_MS) {
          ctrlArmed = false;
          ctrlLocked = true;
        } else {
          ctrlArmed = false;
        }
      } else {
        // Idle → arm (start double-tap window)
        ctrlArmed = true;
        ctrlLastTap = now;
      }
    } else if (mod === 'alt') {
      if (altLocked) {
        altLocked = false;
        altArmed = false;
      } else if (altArmed) {
        if (now - altLastTap <= DOUBLE_TAP_MS) {
          altArmed = false;
          altLocked = true;
        } else {
          altArmed = false;
        }
      } else {
        altArmed = true;
        altLastTap = now;
      }
    }

    updateModUI();
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

      for (var ki = 0; ki < row.length; ki++) {
        var key = row[ki];
        var btn = document.createElement('button');
        btn.className = 'keybar-btn';
        if (key.cls) {
          btn.className += ' ' + key.cls.split(' ').map(function (c) { return 'keybar-' + c; }).join(' ');
        }
        btn.textContent = key.label;
        btn.setAttribute('aria-label', key.id || key.label);

        if (key.id === 'ctrl') {
          ctrlBtn = btn;
          btn.addEventListener('click', function () { handleSticky('ctrl'); });
        } else if (key.id === 'alt') {
          altBtn = btn;
          btn.addEventListener('click', function () { handleSticky('alt'); });
        } else {
          (function (s) {
            btn.addEventListener('click', function () { sendKey(s); });
          })(key.seq);
        }

        rowDiv.appendChild(btn);
      }

      container.appendChild(rowDiv);
    }
  }

  function toggle() {
    if (!container) return;
    container.classList.toggle('keybar-hidden');
  }

  function init() {
    buildToolbar();

    // Hide toolbar + toggle on desktop; on mobile show toggle, toolbar hidden
    if (!isMobile()) {
      var toggle = document.getElementById('keybar-toggle');
      toggle && (toggle.style.display = 'none');
      container && container.classList.add('keybar-hidden');
    } else {
      container && container.classList.add('keybar-hidden');
    }
  }

  // ── Exports ───────────────────────────────────────────────────────────
  window._airpromptKeybar = {
    toggle: toggle,
    sendKey: sendKey,
  };

  // ── Start ─────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
