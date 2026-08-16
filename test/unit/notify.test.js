// ── Notification toast unit tests ──────────────────────────────────────
// Tests pure logic extracted from public/notify.js.
// DOM-dependent code (swipe, toast rendering, container management) is
// tested via integration.

const test = require('node:test');
const assert = require('node:assert');

// ═══════════════════════════════════════════════════════════════════════
// Replicated pure functions — notify.js
// ═══════════════════════════════════════════════════════════════════════

const NOTIFY_EMOJIS = {
  idle_prompt:       '⏳',
  permission_prompt: '✋',
  agent_needs_input: '📥',
  agent_completed:   '✅',
};
const NOTIFY_SUMMARIES = {
  idle_prompt:       'Done — ready for input',
  permission_prompt: 'User action needed',
  agent_needs_input: 'Background agent needs input',
  agent_completed:   'Background agent finished',
};

// ── Suppression guard (notify.js:41-42) ──────────────────────────────

function shouldSuppressToast(activeSessionId, notificationSessionId) {
  // Mirror of: typeof activeSessionId !== 'undefined' && activeSessionId &&
  //            String(n.session_id) === String(activeSessionId)
  if (typeof activeSessionId === 'undefined') return false;
  if (!activeSessionId) return false;
  return String(notificationSessionId) === String(activeSessionId);
}

// ── Label builder (notify.js:46-58) ───────────────────────────────────

function buildSessionLabel(n, sessions) {
  const sid = String(n.session_id || '');
  let label = n.session_label || '';

  // Priority 2: lookup in sessions array by id
  if (!label && sid && sessions) {
    const match = sessions.find(function (s) { return s.id === sid; });
    if (match) {
      label = match.name || (match.cwd ? String(match.cwd).split('/').pop() : '');
    }
  }

  // Priority 3: cwd basename → session_id prefix
  if (!label) {
    const cwd = (n.cwd != null && n.cwd !== 'null' && typeof n.cwd === 'string')
      ? n.cwd.split('/').pop()
      : '';
    label = cwd || (sid ? sid.slice(0, 8) : '');
  }

  return label;
}

// ── Toast message filter (notify.js:82) ──────────────────────────────

function isMessageFiltered(message) {
  // Filter out default/empty IDE status messages
  if (!message) return true;
  if (message === 'null') return true;
  if (message === 'Claude Code') return true;
  if (message === 'Codex') return true;
  if (message === 'Cursor') return true;
  return false;
}

// ═══════════════════════════════════════════════════════════════════════
// Tests — NOTIFY_EMOJIS / NOTIFY_SUMMARIES maps
// ═══════════════════════════════════════════════════════════════════════

test('NOTIFY_EMOJIS — all known notification types have an emoji', async (t) => {
  await t.test('idle_prompt → ⏳', function () {
    assert.strictEqual(NOTIFY_EMOJIS.idle_prompt, '⏳');
  });
  await t.test('permission_prompt → ✋', function () {
    assert.strictEqual(NOTIFY_EMOJIS.permission_prompt, '✋');
  });
  await t.test('agent_needs_input → 📥', function () {
    assert.strictEqual(NOTIFY_EMOJIS.agent_needs_input, '📥');
  });
  await t.test('agent_completed → ✅', function () {
    assert.strictEqual(NOTIFY_EMOJIS.agent_completed, '✅');
  });
  await t.test('unknown type → 📨 (fallback, tested via absence in map)', function () {
    assert.strictEqual(NOTIFY_EMOJIS.unknown_type, undefined);
    // showNotification falls back to '📨' when lookup is undefined
    assert.strictEqual(NOTIFY_EMOJIS.unknown_type || '📨', '📨');
  });
});

test('NOTIFY_SUMMARIES — all known types have human-readable summary', async (t) => {
  await t.test('idle_prompt summary', function () {
    assert.strictEqual(NOTIFY_SUMMARIES.idle_prompt, 'Done — ready for input');
  });
  await t.test('permission_prompt summary', function () {
    assert.strictEqual(NOTIFY_SUMMARIES.permission_prompt, 'User action needed');
  });
  await t.test('agent_needs_input summary', function () {
    assert.strictEqual(NOTIFY_SUMMARIES.agent_needs_input, 'Background agent needs input');
  });
  await t.test('agent_completed summary', function () {
    assert.strictEqual(NOTIFY_SUMMARIES.agent_completed, 'Background agent finished');
  });
  await t.test('EMOJIS and SUMMARIES cover same keys', function () {
    const emojiKeys = Object.keys(NOTIFY_EMOJIS).sort();
    const summaryKeys = Object.keys(NOTIFY_SUMMARIES).sort();
    assert.deepStrictEqual(emojiKeys, summaryKeys);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tests — shouldSuppressToast (suppression guard)
// ═══════════════════════════════════════════════════════════════════════

test('shouldSuppressToast — session matches active session → suppress', async (t) => {
  await t.test('exact string match', function () {
    assert.strictEqual(shouldSuppressToast('claude-123', 'claude-123'), true);
  });

  await t.test('activeSessionId string, notification session_id number, ids different → no match', function () {
    // Server may send session_id as number or string depending on JSON path
    // 'claude-123' vs 123 — String(123)='123' ≠ 'claude-123'
    assert.strictEqual(shouldSuppressToast('claude-123', 123), false);
  });

  await t.test('activeSessionId string, notification session_id number same value → coerced match', function () {
    // String('123') === String(123) → '123' === '123' → suppress
    assert.strictEqual(shouldSuppressToast('123', 123), true);
  });

  await t.test('activeSessionId string, notification session_id matching string', function () {
    assert.strictEqual(shouldSuppressToast('session-abc', 'session-abc'), true);
  });

  await t.test('truncated prefix does NOT match', function () {
    assert.strictEqual(shouldSuppressToast('claude-32142-1785341055', 'claude-3'), false);
  });
});

test('shouldSuppressToast — different session → show toast', async (t) => {
  await t.test('completely different session IDs', function () {
    assert.strictEqual(shouldSuppressToast('claude-session-a', 'claude-session-b'), false);
  });

  await t.test('watching session A, notification from session B', function () {
    const activeSessionId = 'claude-42';
    const notifySessionId  = 'claude-43';
    assert.strictEqual(shouldSuppressToast(activeSessionId, notifySessionId), false);
  });
});

test('shouldSuppressToast — edge cases (no active session)', async (t) => {
  await t.test('activeSessionId is null → show toast (no session selected)', function () {
    assert.strictEqual(shouldSuppressToast(null, 'any-session'), false);
  });

  await t.test('activeSessionId is undefined → show toast (not initialized)', function () {
    assert.strictEqual(shouldSuppressToast(undefined, 'any-session'), false);
  });

  await t.test('activeSessionId is empty string → show toast', function () {
    assert.strictEqual(shouldSuppressToast('', 'any-session'), false);
  });

  await t.test('activeSessionId is 0 → show toast (0 is falsy)', function () {
    assert.strictEqual(shouldSuppressToast(0, '0'), false);
  });
});

test('shouldSuppressToast — notification with null/undefined session_id', async (t) => {
  await t.test('notification session_id is null → no match, show toast', function () {
    assert.strictEqual(shouldSuppressToast('claude-123', null), false);
  });

  await t.test('notification session_id is undefined → no match, show toast', function () {
    assert.strictEqual(shouldSuppressToast('claude-123', undefined), false);
  });

  await t.test('notification session_id is empty string → does NOT match non-empty active', function () {
    assert.strictEqual(shouldSuppressToast('claude-123', ''), false);
  });

  await t.test('both empty string → activeSessionId falsy → show toast (guard short-circuits)', function () {
    // Guard: !activeSessionId catches '' → returns false → toast SHOWN, not suppressed
    assert.strictEqual(shouldSuppressToast('', ''), false);
  });

  await t.test('both null → activeSessionId null is falsy → guard returns false before comparison', function () {
    assert.strictEqual(shouldSuppressToast(null, null), false);
  });

  await t.test('notification session_id omitted → String(undefined) = "undefined" — unlikely match', function () {
    // In practice, String(undefined) === 'undefined', which won't match any real session ID
    assert.strictEqual(String(undefined), 'undefined');
    assert.strictEqual(shouldSuppressToast('claude-123', undefined), false);
  });

  await t.test('String(null) = "null" — collision would suppress if activeSessionId is literally "null"', function () {
    // Defensive: String(null) === 'null'. If activeSessionId is the string 'null',
    // suppression would fire. Unlikely in practice but worth pinning.
    assert.strictEqual(shouldSuppressToast('null', null), true);
  });

  await t.test('String(undefined) = "undefined" — collision with literal "undefined"', function () {
    assert.strictEqual(shouldSuppressToast('undefined', undefined), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tests — buildSessionLabel
// ═══════════════════════════════════════════════════════════════════════

test('buildSessionLabel — session_label has top priority', async (t) => {
  await t.test('session_label present → returned directly', function () {
    const n = { session_label: 'my-project', session_id: 'abc', cwd: '/home/proj' };
    assert.strictEqual(buildSessionLabel(n, []), 'my-project');
  });

  await t.test('session_label present → ignores sessions array', function () {
    const n = { session_label: 'explicit-label', session_id: 'abc' };
    const sessions = [{ id: 'abc', name: 'from-session-array' }];
    assert.strictEqual(buildSessionLabel(n, sessions), 'explicit-label');
  });
});

test('buildSessionLabel — fallback to sessions array lookup', async (t) => {
  await t.test('no session_label, matched by id → returns session name', function () {
    const n = { session_id: 'abc' };
    const sessions = [{ id: 'abc', name: 'Cool Project' }];
    assert.strictEqual(buildSessionLabel(n, sessions), 'Cool Project');
  });

  await t.test('matched by id, session has no name → returns cwd basename', function () {
    const n = { session_id: 'abc' };
    const sessions = [{ id: 'abc', cwd: '/home/user/work' }];
    assert.strictEqual(buildSessionLabel(n, sessions), 'work');
  });

  await t.test('matched by id, session has both name and cwd → name wins', function () {
    const n = { session_id: 'abc' };
    const sessions = [{ id: 'abc', name: 'Named', cwd: '/home/fallback' }];
    assert.strictEqual(buildSessionLabel(n, sessions), 'Named');
  });

  await t.test('session_id not found in sessions array → falls to cwd/session_id', function () {
    const n = { session_id: 'xyz', cwd: '/tmp/mywork' };
    const sessions = [{ id: 'abc', name: 'Other' }];
    assert.strictEqual(buildSessionLabel(n, sessions), 'mywork');
  });

  await t.test('sessions array is null/undefined → falls through to cwd', function () {
    const n = { session_id: 'abc', cwd: '/home/fallback' };
    assert.strictEqual(buildSessionLabel(n, null), 'fallback');
    assert.strictEqual(buildSessionLabel(n, undefined), 'fallback');
  });
});

test('buildSessionLabel — fallback to notification cwd basename', async (t) => {
  await t.test('cwd present, no session_label → basename', function () {
    const n = { cwd: '/home/diego/projects/airprompt' };
    assert.strictEqual(buildSessionLabel(n, []), 'airprompt');
  });

  await t.test('cwd with trailing slash → basename', function () {
    const n = { cwd: '/home/user/' };
    // split('/').pop() on trailing slash gives ''
    assert.strictEqual(buildSessionLabel(n, []), '');
  });

  await t.test('cwd is "null" string → treated as falsy (filtered by cwd !== "null")', function () {
    const n = { cwd: 'null', session_id: 'sid-123' };
    // cwd === 'null' → filtered out → falls to session_id prefix
    assert.strictEqual(buildSessionLabel(n, []), 'sid-123');
  });

  await t.test('cwd is null (actual null) → filtered by != null check', function () {
    const n = { cwd: null, session_id: 'abc12345' };
    assert.strictEqual(buildSessionLabel(n, []), 'abc12345');
  });

  await t.test('cwd is number → filtered by typeof string check', function () {
    // typeof 42 !== 'string' → cwd = '' → falls to session_id
    const n = { cwd: 42, session_id: 'prefix-h' };
    assert.strictEqual(buildSessionLabel(n, []), 'prefix-h');
  });
});

test('buildSessionLabel — final fallback to session_id prefix', async (t) => {
  await t.test('no label, no cwd, no sessions match → session_id first 8 chars', function () {
    const n = { session_id: 'claude-32142-1785341055' };
    assert.strictEqual(buildSessionLabel(n, []), 'claude-3');
  });

  await t.test('short session_id → full id', function () {
    const n = { session_id: 'abc' };
    assert.strictEqual(buildSessionLabel(n, []), 'abc');
  });

  await t.test('session_id is null → empty string', function () {
    const n = {};
    assert.strictEqual(buildSessionLabel(n, []), '');
  });

  await t.test('session_id is empty string → empty string', function () {
    const n = { session_id: '' };
    assert.strictEqual(buildSessionLabel(n, []), '');
  });

  await t.test('everything missing → empty string', function () {
    const n = {};
    assert.strictEqual(buildSessionLabel(n, undefined), '');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tests — isMessageFiltered (default IDE status filtering)
// ═══════════════════════════════════════════════════════════════════════

test('isMessageFiltered — empty/default IDE messages filtered out', async (t) => {
  await t.test('empty string → filtered', function () {
    assert.strictEqual(isMessageFiltered(''), true);
  });

  await t.test('"null" string → filtered', function () {
    assert.strictEqual(isMessageFiltered('null'), true);
  });

  await t.test('"Claude Code" → filtered', function () {
    assert.strictEqual(isMessageFiltered('Claude Code'), true);
  });

  await t.test('"Codex" → filtered', function () {
    assert.strictEqual(isMessageFiltered('Codex'), true);
  });

  await t.test('"Cursor" → filtered', function () {
    assert.strictEqual(isMessageFiltered('Cursor'), true);
  });

  await t.test('null value → filtered (falsy)', function () {
    assert.strictEqual(isMessageFiltered(null), true);
  });

  await t.test('undefined value → filtered (falsy)', function () {
    assert.strictEqual(isMessageFiltered(undefined), true);
  });

  await t.test('"Shell" → NOT filtered (real message)', function () {
    assert.strictEqual(isMessageFiltered('Shell'), false);
  });

  await t.test('"Build failed: 2 errors" → NOT filtered (real message)', function () {
    assert.strictEqual(isMessageFiltered('Build failed: 2 errors'), false);
  });

  await t.test('"null-like-but-not-exact" → NOT filtered', function () {
    assert.strictEqual(isMessageFiltered('null-like-but-not-exact'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Tests — composite suppression + label scenarios (multi-client)
// ═══════════════════════════════════════════════════════════════════════

test('multi-client scenario — each WebUI suppresses only its own active session', async (t) => {
  // Three clients, each viewing different sessions:
  // Client A → watching "proj-x"
  // Client B → watching "proj-x" (same session)
  // Client C → watching "proj-y"
  // Notification arrives for "proj-x"

  await t.test('client A watching proj-x → notification for proj-x → SUPPRESS', function () {
    assert.strictEqual(shouldSuppressToast('proj-x', 'proj-x'), true);
  });

  await t.test('client B also watching proj-x → notification for proj-x → SUPPRESS', function () {
    assert.strictEqual(shouldSuppressToast('proj-x', 'proj-x'), true);
  });

  await t.test('client C watching proj-y → notification for proj-x → SHOW', function () {
    assert.strictEqual(shouldSuppressToast('proj-y', 'proj-x'), false);
  });

  await t.test('no active session → notification for proj-x → SHOW', function () {
    assert.strictEqual(shouldSuppressToast(null, 'proj-x'), false);
  });
});

test('multi-client scenario — session switch updates suppression target', async (t) => {
  // Client starts watching "proj-x", then switches to "proj-y"
  let activeSessionId;

  // Initially watching proj-x
  activeSessionId = 'proj-x';
  assert.strictEqual(shouldSuppressToast(activeSessionId, 'proj-x'), true);
  assert.strictEqual(shouldSuppressToast(activeSessionId, 'proj-y'), false);

  // User switches to proj-y
  activeSessionId = 'proj-y';
  assert.strictEqual(shouldSuppressToast(activeSessionId, 'proj-x'), false);
  assert.strictEqual(shouldSuppressToast(activeSessionId, 'proj-y'), true);
});
