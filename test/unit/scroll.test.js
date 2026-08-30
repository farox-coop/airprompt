// ── Scroll strategy + sequence unit tests ──────────────────────────────
// Tests the pure logic in public/scroll.js (strategy dispatch and the
// SGR/arrow-key sequence builders). DOM touch wiring is browser-only.

const test = require('node:test');
const assert = require('node:assert');

// Load the real production module. `window` is shimmed so the browser-only
// touch wiring is skipped (it guards on `typeof document === 'undefined'`).
global.window = {};
require('../../public/scroll.js');
const S = global.window.Scroll;

// ── resolveStrategy ────────────────────────────────────────────────────

test('scroll — resolveStrategy picks mechanism by terminal state', async (t) => {
  await t.test('mouse tracking → sgr', () => {
    assert.strictEqual(S.resolveStrategy('any', 'alternate'), 'sgr');
  });

  await t.test('any non-none mouse mode → sgr (x10 click mode included)', () => {
    assert.strictEqual(S.resolveStrategy('x10', 'alternate'), 'sgr');
  });

  await t.test('mouse mode wins over normal buffer', () => {
    assert.strictEqual(S.resolveStrategy('drag', 'normal'), 'sgr');
  });

  await t.test('no mouse + normal screen → wheel (viewport scrollback)', () => {
    assert.strictEqual(S.resolveStrategy('none', 'normal'), 'wheel');
  });

  await t.test('no mouse + alternate screen → arrow (fallback)', () => {
    assert.strictEqual(S.resolveStrategy('none', 'alternate'), 'arrow');
  });
});

// ── buildSgr ───────────────────────────────────────────────────────────

test('scroll — buildSgr emits SGR mouse-wheel sequences', async (t) => {
  await t.test('negative count = scroll up (button 64), centered coords', () => {
    assert.strictEqual(S.buildSgr(-1, 80, 24), '\x1b[<64;40;12M');
  });

  await t.test('positive count = scroll down (button 65)', () => {
    assert.strictEqual(S.buildSgr(1, 80, 24), '\x1b[<65;40;12M');
  });

  await t.test('coords derived from terminal dimensions', () => {
    assert.strictEqual(S.buildSgr(-2, 100, 40), '\x1b[<64;50;20M');
  });

  await t.test('coords clamp to a minimum of 1', () => {
    assert.strictEqual(S.buildSgr(1, 1, 1), '\x1b[<65;1;1M');
    assert.strictEqual(S.buildSgr(-1, 0, 0), '\x1b[<64;1;1M');
  });

  await t.test('count=0 defaults to down (positive branch)', () => {
    assert.strictEqual(S.buildSgr(0, 80, 24), '\x1b[<65;40;12M');
  });

  await t.test('odd dimensions floor to center', () => {
    assert.strictEqual(S.buildSgr(-1, 81, 25), '\x1b[<64;40;12M');
  });
});

// ── buildArrow ─────────────────────────────────────────────────────────

test('scroll — buildArrow emits arrow-key sequences', async (t) => {
  await t.test('negative count = up', () => {
    assert.strictEqual(S.buildArrow(-1), '\x1b[A');
    assert.strictEqual(S.buildArrow(-3), '\x1b[A');
  });

  await t.test('positive count = down', () => {
    assert.strictEqual(S.buildArrow(1), '\x1b[B');
    assert.strictEqual(S.buildArrow(2), '\x1b[B');
  });

  await t.test('count=0 defaults to down', () => {
    assert.strictEqual(S.buildArrow(0), '\x1b[B');
  });
});

// ── buildWheelDeltaY ───────────────────────────────────────────────────

test('scroll — buildWheelDeltaY passes count through (6.0 negates internally)', async (t) => {
  await t.test('negative count (drag down = older) → negative deltaY', () => {
    assert.strictEqual(S.buildWheelDeltaY(-2), -2);
  });

  await t.test('positive count (drag up = newer) → positive deltaY', () => {
    assert.strictEqual(S.buildWheelDeltaY(3), 3);
  });
});
