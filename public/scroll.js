// ── One-finger touch → adaptive scroll (rAF-batched) ───────────────────
// Depends on globals from client.js: `term` (xterm instance) and `send`
// (WebSocket message helper). Loaded after client.js so both exist.
//
// xterm.js has poor mobile touch support (xtermjs/xterm.js#5377) and iOS
// Safari fails to scroll when a touch starts on rendered text
// (xtermjs/xterm.js#3613), so native touch scrolling is unreliable here.
//
// Strategy is picked at touchstart from the terminal's state:
//  - mouse mode (term.modes.mouseTrackingMode !== 'none') → SGR wheel events
//    (button 64/65). Apps like Claude Code / vim / k9s scroll their own
//    output this way, without touching input focus.
//  - normal screen (buffer.type === 'normal') → scroll xterm's scrollback
//    via synthetic wheel events.
//  - alternate screen without mouse → arrow keys (may navigate input when
//    the prompt is focused — a known protocol limitation).
//
// Direction: content follows the finger — drag DOWN = scroll back (older),
// drag UP = newer. Fractional carry emits one event per TICK_PX of finger
// travel; rAF batching caps it at one burst per frame.
(function () {
  'use strict';

  // ── Pure helpers (exported via window.Scroll for unit tests) ──────────

  // Pick the scroll mechanism from the terminal's current state.
  function resolveStrategy(mouseTrackingMode, bufferType) {
    if (mouseTrackingMode !== 'none') return 'sgr';   // app handles its own scroll
    if (bufferType !== 'alternate') return 'wheel';   // xterm scrollback
    return 'arrow';                                   // fallback (input may hijack)
  }

  // SGR mouse-wheel event. count < 0 = scroll up (older, button 64);
  // count > 0 = scroll down (newer, button 65). Coordinates are the
  // terminal center (1-based), which the app ignores for wheel scrolling.
  function buildSgr(count, cols, termRows) {
    const mcol = Math.max(1, Math.floor(cols / 2));
    const mrow = Math.max(1, Math.floor(termRows / 2));
    return '\x1b[<' + (count < 0 ? '64' : '65') + ';' + mcol + ';' + mrow + 'M';
  }

  // Arrow-key fallback. count < 0 = up, count > 0 = down.
  function buildArrow(count) {
    return count < 0 ? '\x1b[A' : '\x1b[B';
  }

  // xterm's viewport is inverted: a positive wheel deltaY scrolls toward
  // OLDER content, but our `count` is positive for drag-up (newer). Negate
  // so the wheel path matches buildSgr/buildArrow (count < 0 = older).
  function buildWheelDeltaY(count) {
    return -count;
  }

  if (typeof window !== 'undefined') {
    window.Scroll = { resolveStrategy: resolveStrategy, buildSgr: buildSgr, buildArrow: buildArrow, buildWheelDeltaY: buildWheelDeltaY };
  }

  // ── Browser-only touch wiring ─────────────────────────────────────────
  if (typeof document === 'undefined') return;

  const container = document.getElementById('terminal-container');
  const viewport = container.querySelector('.xterm-viewport');
  let startY = 0;
  let lastY = 0;
  let accumPx = 0;
  let scrollActive = false;
  let scrolling = false;
  let rafId = null;
  let strategy = 'arrow';

  // Tap slop: total displacement below this is a tap (preventDefault is
  // only called past it, so taps still synthesize a click for focus).
  const TAP_SLOP = 6;

  // Finger px per SGR wheel event. Smaller = faster + smoother (more events
  // per finger travel). Tune for "mouse-wheel feel": ~5px ≈ 3 lines.
  const TICK_PX = 5;

  container.addEventListener('touchstart', function (e) {
    if (e.touches.length !== 1) { scrollActive = false; return; }
    scrollActive = true;
    scrolling = false;
    startY = e.touches[0].clientY;
    lastY = e.touches[0].clientY;
    accumPx = 0;
    strategy = resolveStrategy(term.modes.mouseTrackingMode, term.buffer.active.type);
  }, { passive: true, capture: true });

  function flushScroll() {
    if (!scrollActive) { rafId = null; return; }
    const rows = Math.trunc(accumPx / TICK_PX);
    if (rows !== 0) {
      if (strategy === 'sgr') {
        send({ type: 'input', data: buildSgr(rows, term.cols, term.rows).repeat(Math.abs(rows)) });
      } else if (strategy === 'wheel') {
        viewport.dispatchEvent(new WheelEvent('wheel', {
          deltaY: buildWheelDeltaY(rows),  // negated: xterm wheel is inverted
          deltaMode: 1,       // DOM_DELTA_LINE
          bubbles: true,
          cancelable: true,
        }));
      } else {
        send({ type: 'input', data: buildArrow(rows).repeat(Math.abs(rows)) });
      }
      accumPx -= rows * TICK_PX;
    }
    rafId = requestAnimationFrame(flushScroll);
  }

  container.addEventListener('touchmove', function (e) {
    if (!scrollActive || e.touches.length !== 1) return;
    const absDy = startY - e.touches[0].clientY; // absolute displacement
    const dy = lastY - e.touches[0].clientY;     // finger delta (px)
    lastY = e.touches[0].clientY;
    if (!scrolling && Math.abs(absDy) < TAP_SLOP) return;
    scrolling = true;
    e.preventDefault();
    e.stopPropagation(); // stop xterm's native viewport touch handler from double-scrolling
    accumPx += dy;
    if (!rafId) rafId = requestAnimationFrame(flushScroll);
  }, { passive: false, capture: true });

  function finish() {
    scrollActive = false;
    scrolling = false;
    lastY = 0; accumPx = 0;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  container.addEventListener('touchend', function () { finish(); }, { passive: true, capture: true });
  container.addEventListener('touchcancel', function () { finish(); }, { passive: true, capture: true });
})();
