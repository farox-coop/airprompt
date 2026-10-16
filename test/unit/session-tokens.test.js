// test/unit/session-tokens.test.js — airprompt-session-tokens.js unit tests.
//
// The contract under test: print the current context size for whichever agent
// produced the session log, and print *nothing* when there is no readable
// source. Silent-and-empty is deliberate — a notification must never show a
// number nobody can justify.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TOKENS = require('../../src/hooks/airprompt-session-tokens');
const SCRIPT = path.join(__dirname, '..', '..', 'src', 'hooks', 'airprompt-session-tokens.js');

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Write a JSONL session log and run `body(filePath)` while it still exists. */
function withLog(lines, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airprompt-tokens-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(
    file,
    lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n'
  );
  try {
    return body(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { stdout: r.stdout.trim(), stderr: r.stderr.trim(), code: r.status };
}

// Fixture provenance (the PLAN doc's rule: say where a shape came from, and say
// when it is unverified):
//   - claudeAssistant / the transcript shape below is taken from real
//     transcripts under $CLAUDE_CONFIG_DIR/projects/ (verified: `type`,
//     `isSidechain`, `message.usage`, one content block per line, identical
//     usage on each line of a message).
//   - codexTokenCount follows the documented rollout schema
//     (`event_msg` → `payload.type === "token_count"` → `payload.info`), but no
//     Codex is installed on the machine this was written on, so it is
//     UNVERIFIED against a real rollout.
const claudeAssistant = (usage, extra = {}) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [], usage },
  ...extra,
});

const codexTokenCount = (info) => ({ type: 'event_msg', payload: { type: 'token_count', info } });

// The two entries a compaction writes, both taken from real transcripts:
// a `system` boundary carrying `compactMetadata`, and the `user` entry holding
// the summary text.
const compactBoundary = (compactMetadata) => ({
  type: 'system',
  subtype: 'compact_boundary',
  content: 'Conversation compacted',
  level: 'info',
  compactMetadata,
});

const compactSummary = () => ({
  type: 'user',
  isCompactSummary: true,
  isVisibleInTranscriptOnly: true,
  message: {
    role: 'user',
    content: 'This session is being continued from a previous conversation.',
  },
});

// ── Claude ──────────────────────────────────────────────────────────────────

test('claude — sums input + cache read + cache creation of the newest message', () => {
  withLog(
    [
      claudeAssistant({ input_tokens: 10, cache_read_input_tokens: 100 }),
      { type: 'user', message: { role: 'user', content: 'hi' } },
      claudeAssistant({
        input_tokens: 446,
        cache_read_input_tokens: 51840,
        cache_creation_input_tokens: 1000,
      }),
    ],
    (file) => {
      assert.strictEqual(TOKENS.resolveTokens({ provider: 'claude', sessionFile: file }), '53k');
    }
  );
});

test('claude — sidechain (subagent) usage is not the session context', () => {
  withLog(
    [
      claudeAssistant({ input_tokens: 100000, cache_read_input_tokens: 0 }),
      claudeAssistant({ input_tokens: 500, cache_read_input_tokens: 0 }, { isSidechain: true }),
    ],
    (file) => {
      assert.strictEqual(TOKENS.resolveTokens({ provider: 'claude', sessionFile: file }), '100k');
    }
  );
});

test('claude — trailing non-usage entries are skipped', () => {
  withLog(
    [
      claudeAssistant({ input_tokens: 20000, cache_read_input_tokens: 1000 }),
      { type: 'last-prompt' },
      { type: 'ai-title', aiTitle: 'x' },
    ],
    (file) => {
      assert.strictEqual(TOKENS.resolveTokens({ provider: 'claude', sessionFile: file }), '21k');
    }
  );
});

// ── Compaction (/compact ends its turn without a following assistant message,
// so the newest usage in the file predates the boundary) ─────────────────────

test('claude — a compaction after the newest usage reports the boundary postTokens', () => {
  withLog(
    [
      claudeAssistant({ input_tokens: 284000, cache_read_input_tokens: 109 }),
      compactBoundary({ preTokens: 284251, postTokens: 20250 }),
      compactSummary(),
    ],
    (file) => {
      assert.strictEqual(TOKENS.resolveTokens({ provider: 'claude', sessionFile: file }), '20k');
    }
  );
});

test('claude — a compaction whose newest boundary has no postTokens records nothing, not an older one', () => {
  // Both failure modes at once: the newest boundary carries no number (so the
  // honest answer is "unknown"), and an older one still has one it must not
  // fall back to — that context was replaced again long ago.
  withLog(
    [
      claudeAssistant({ input_tokens: 400000 }),
      compactBoundary({ preTokens: 400000, postTokens: 90000 }),
      compactSummary(),
      claudeAssistant({ input_tokens: 120000 }),
      compactBoundary({ preTokens: 120000 }),
      compactSummary(),
    ],
    (file) => {
      assert.strictEqual(TOKENS.resolveTokens({ provider: 'claude', sessionFile: file }), '');
    }
  );
  withLog(
    [
      claudeAssistant({ input_tokens: 400000 }),
      compactBoundary({ preTokens: 400000, postTokens: 90000 }),
      claudeAssistant({ input_tokens: 120000 }),
      compactBoundary({ preTokens: 120000, postTokens: 0 }),
    ],
    (file) => {
      assert.strictEqual(TOKENS.resolveTokens({ provider: 'claude', sessionFile: file }), '');
    }
  );
});

test('claude — a compaction with no postTokens records nothing, not the stale pre-compaction number', () => {
  withLog(
    [claudeAssistant({ input_tokens: 284000 }), compactSummary(), { type: 'system' }],
    (file) => {
      assert.strictEqual(TOKENS.resolveTokens({ provider: 'claude', sessionFile: file }), '');
    }
  );
});

test('claude — a usage after the boundary is the context, not the boundary number', () => {
  withLog(
    [
      claudeAssistant({ input_tokens: 284000 }),
      compactBoundary({ preTokens: 284251, postTokens: 20250 }),
      claudeAssistant({ input_tokens: 23000 }),
    ],
    (file) => {
      assert.strictEqual(TOKENS.resolveTokens({ provider: 'claude', sessionFile: file }), '23k');
    }
  );
});

test('claude — a summary-only newest compaction records nothing, not an older boundary number', () => {
  // Claude writes the boundary and its summary ~1 ms apart, so in practice they
  // appear together — but a transcript carrying the summary without its numbered
  // boundary must not fall back to the previous compaction's postTokens: an
  // intervening usage entry proves that context was replaced again.
  withLog(
    [
      claudeAssistant({ input_tokens: 284000 }),
      compactBoundary({ preTokens: 284000, postTokens: 90000 }),
      claudeAssistant({ input_tokens: 120000 }),
      compactSummary(),
    ],
    (file) => {
      assert.strictEqual(TOKENS.resolveTokens({ provider: 'claude', sessionFile: file }), '');
    }
  );
});

test('claude — the boundary and its summary may be separated by other entries', () => {
  // Real shape: the system boundary, then attachment entries, then the summary.
  withLog(
    [
      claudeAssistant({ input_tokens: 284000 }),
      compactBoundary({ preTokens: 284251, postTokens: 20250 }),
      { type: 'attachment', attachment: { type: 'skill_listing' } },
      { type: 'attachment', attachment: { type: 'instructions' } },
      compactSummary(),
    ],
    (file) => {
      assert.strictEqual(TOKENS.resolveTokens({ provider: 'claude', sessionFile: file }), '20k');
    }
  );
});

test('claude — a second compaction event also proves the numbered boundary is older', () => {
  // The newest event here is summary-only, so the number below it belongs to a
  // context that was replaced again — even though no usage entry sits in
  // between. `U B(90000) S A S` in the walk's terms.
  withLog(
    [
      claudeAssistant({ input_tokens: 284000 }),
      compactBoundary({ preTokens: 284000, postTokens: 90000 }),
      compactSummary(),
      { type: 'attachment', attachment: { type: 'skill_listing' } },
      compactSummary(),
    ],
    (file) => {
      assert.strictEqual(TOKENS.resolveTokens({ provider: 'claude', sessionFile: file }), '');
    }
  );
});

test('claude — an explicit but invalid token count is unknown, not a reason to read the log', () => {
  withLog([claudeAssistant({ input_tokens: 30000 })], (file) => {
    for (const tokens of [0, -5, NaN, Infinity, null]) {
      assert.strictEqual(
        TOKENS.resolveTokens({ provider: 'claude', sessionFile: file, tokens }),
        '',
        `tokens=${tokens} must not fall back to the transcript`
      );
    }
    assert.strictEqual(
      TOKENS.resolveTokens({ provider: 'claude', sessionFile: file, tokens: 115000 }),
      '115k'
    );
  });
});

test('readTail — a negative window is empty, not a RangeError', () => {
  withLog([claudeAssistant({ input_tokens: 30000 })], (file) => {
    assert.strictEqual(TOKENS.readTail(file, -1), '');
    assert.strictEqual(TOKENS.readTail(file, -5), '');
  });
});

test('claude — only the newest boundary counts when a session compacted twice', () => {
  withLog(
    [
      claudeAssistant({ input_tokens: 400000 }),
      compactBoundary({ preTokens: 400000, postTokens: 90000 }),
      claudeAssistant({ input_tokens: 120000 }),
      compactBoundary({ preTokens: 120000, postTokens: 30000 }),
    ],
    (file) => {
      assert.strictEqual(TOKENS.resolveTokens({ provider: 'claude', sessionFile: file }), '30k');
    }
  );
});

// ── Codex ───────────────────────────────────────────────────────────────────

test('codex — the prompt (input_tokens) is the context, not input+output', () => {
  withLog(
    [
      codexTokenCount({ total_token_usage: { total_tokens: 76484 } }),
      codexTokenCount({
        total_token_usage: { total_tokens: 500000 },
        last_token_usage: { input_tokens: 76000, total_tokens: 76484 },
        model_context_window: 258400,
      }),
    ],
    (file) => {
      assert.strictEqual(TOKENS.resolveTokens({ provider: 'codex', sessionFile: file }), '76k');
    }
  );
});

test('codex — input_tokens wins even when the output pushes total across a rounding step', () => {
  withLog(
    [codexTokenCount({ last_token_usage: { input_tokens: 114600, total_tokens: 116400 } })],
    (file) => {
      assert.strictEqual(TOKENS.resolveTokens({ provider: 'codex', sessionFile: file }), '115k');
    }
  );
});

test('codex — falls back to total_tokens when input_tokens is absent', () => {
  withLog([codexTokenCount({ last_token_usage: { total_tokens: 12000 } })], (file) => {
    assert.strictEqual(TOKENS.resolveTokens({ provider: 'codex', sessionFile: file }), '12k');
  });
});

test('codex — cumulative-only and info:null events yield no badge', () => {
  withLog(
    [
      codexTokenCount({ total_token_usage: { total_tokens: 76484 } }),
      { type: 'event_msg', payload: { type: 'token_count', info: null } },
    ],
    (file) => {
      assert.strictEqual(TOKENS.resolveTokens({ provider: 'codex', sessionFile: file }), '');
    }
  );
});

// ── Sniffing, passthrough, unavailable providers ─────────────────────────────

test('auto-sniff — detects a claude transcript and a codex rollout without --provider', () => {
  withLog([claudeAssistant({ input_tokens: 40000 })], (claude) => {
    assert.strictEqual(TOKENS.resolveTokens({ sessionFile: claude }), '40k');
  });
  withLog([codexTokenCount({ last_token_usage: { total_tokens: 12000 } })], (codex) => {
    assert.strictEqual(TOKENS.resolveTokens({ sessionFile: codex }), '12k');
  });
});

test('--tokens passes an already-known count through', () => {
  assert.strictEqual(TOKENS.resolveTokens({ provider: 'cursor', tokens: 115000 }), '115k');
});

test('providers with no readable log print nothing', () => {
  withLog([claudeAssistant({ input_tokens: 40000 })], (file) => {
    assert.strictEqual(TOKENS.resolveTokens({ provider: 'cursor', sessionFile: file }), '');
    assert.strictEqual(TOKENS.resolveTokens({ provider: 'windsurf', sessionFile: file }), '');
  });
});

test('missing log or empty log prints nothing (unknown, not zero)', () => {
  assert.strictEqual(
    TOKENS.resolveTokens({ provider: 'claude', sessionFile: '/nonexistent/x.jsonl' }),
    ''
  );
  assert.strictEqual(TOKENS.resolveTokens({ provider: 'claude' }), '');
  withLog([], (file) => {
    assert.strictEqual(fs.statSync(file).size, 1, 'fixture is the trailing newline alone');
    assert.strictEqual(TOKENS.resolveTokens({ provider: 'claude', sessionFile: file }), '');
  });
});

test('a log with no trailing newline still finds the newest entry', () => {
  withLog([claudeAssistant({ input_tokens: 30000 })], (file) => {
    const body = fs.readFileSync(file, 'utf8').trimEnd();
    fs.writeFileSync(file, body); // no '\n' at EOF
    assert.strictEqual(TOKENS.resolveTokens({ provider: 'claude', sessionFile: file }), '30k');
  });
});

test('a line that parses to null (valid JSON, not an object) does not crash the scan', () => {
  withLog([claudeAssistant({ input_tokens: 30000 }), 'null', '123'], (file) => {
    assert.strictEqual(TOKENS.resolveTokens({ provider: 'claude', sessionFile: file }), '30k');
  });
});

test('a truncated final line does not break the scan', () => {
  withLog([claudeAssistant({ input_tokens: 30000 }), '{"type":"assis'], (file) => {
    assert.strictEqual(TOKENS.resolveTokens({ provider: 'claude', sessionFile: file }), '30k');
  });
});

// ── Tail window (the seam TAIL_BYTES exists for) ─────────────────────────────

test('readTail — a window that starts mid-line drops the fragment, keeping the rest', () => {
  withLog(
    [
      claudeAssistant({ input_tokens: 111000 }, { pad: 'x'.repeat(200) }),
      claudeAssistant({ input_tokens: 30000 }),
    ],
    (file) => {
      const text = TOKENS.readTail(file, 120);
      assert.ok(!text.startsWith('x'), 'leading fragment dropped');
      assert.match(text, /"input_tokens":30000/, 'newest entry kept');
      assert.strictEqual(TOKENS.resolveTokens({ provider: 'claude', sessionFile: file }), '30k');
    }
  );
});

test('readTail — a window that lands exactly on a line boundary keeps that whole line', () => {
  const older = JSON.stringify(claudeAssistant({ input_tokens: 111000 }));
  const newer = JSON.stringify(claudeAssistant({ input_tokens: 30000 }));
  withLog([older, newer], (file) => {
    // Window = the newest line plus its newline: `start` is the byte after the
    // previous line's '\n', so the first line of the window is complete.
    const window = newer.length + 1;
    assert.strictEqual(fs.statSync(file).size, older.length + 1 + window);
    assert.strictEqual(TOKENS.readTail(file, window), newer + '\n');
    assert.strictEqual(TOKENS.claudeTokens(TOKENS.readTail(file, window)), 30000);
  });
});

test('readTail — a window smaller than the newest line yields nothing, never a wrong line', () => {
  withLog(
    [claudeAssistant({ input_tokens: 111000 }), claudeAssistant({ input_tokens: 30000 })],
    (file) => {
      assert.strictEqual(TOKENS.readTail(file, 20), '');
    }
  );
});

// ── Badge formatting + CLI contract ─────────────────────────────────────────

test('badge — rounds to the nearest k, exactly like the statusline', () => {
  assert.strictEqual(TOKENS.badge(115000), '115k');
  assert.strictEqual(TOKENS.badge(114500), '115k');
  assert.strictEqual(TOKENS.badge(114499), '114k');
  assert.strictEqual(TOKENS.badge(52286), '52k');
});

test('CLI — prints the badge for a real log, nothing for an unreadable provider', () => {
  withLog([claudeAssistant({ input_tokens: 115000 })], (file) => {
    const hit = run(['--provider', 'claude', '--session-file', file]);
    assert.strictEqual(hit.code, 0);
    assert.strictEqual(hit.stdout, '115k');

    const miss = run(['--provider', 'windsurf', '--session-file', file]);
    assert.strictEqual(miss.code, 0);
    assert.strictEqual(miss.stdout, '');
  });
});

test('CLI — an unknown provider is a loud error, not a silent empty badge', () => {
  const r = run(['--provider', 'nope', '--session-file', '/tmp/x.jsonl']);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /unknown provider/);
});

test('CLI — --tokens end to end, and a value that is not a count is loud', () => {
  const ok = run(['--provider', 'cursor', '--tokens', '115000']);
  assert.strictEqual(ok.code, 0);
  assert.strictEqual(ok.stdout, '115k');

  // `Infinity`/`1e400` matter: they are numbers, so an `n > 0` test alone would
  // print `Infinityk` as if it were a count.
  for (const bad of ['abc', '0', '-5', 'Infinity', '1e400']) {
    const r = run(['--provider', 'cursor', '--tokens', bad]);
    assert.strictEqual(r.code, 1, `--tokens ${bad} must not be accepted`);
    assert.strictEqual(r.stdout, '', `--tokens ${bad} must print no badge`);
    assert.match(r.stderr, /--tokens expects a positive number/);
  }

  const empty = run(['--provider', 'cursor', '--tokens', '']);
  assert.strictEqual(empty.code, 1);
  assert.strictEqual(empty.stdout, '');
  assert.match(empty.stderr, /--tokens expects a value/);
});

test('CLI — a flag whose value went missing is loud, not a silently skipped badge', () => {
  for (const args of [['--provider'], ['--tokens'], ['--session-file'], ['--provider', '']]) {
    const r = run(args);
    assert.strictEqual(r.code, 1, `${args.join(' ')} must not be accepted`);
    assert.strictEqual(r.stdout, '');
    assert.match(r.stderr, /expects a value/);
  }
});

test('CLI — --help exits 0 and prints the usage line', () => {
  const r = run(['--help']);
  assert.strictEqual(r.code, 0);
  assert.match(r.stdout, /usage: airprompt-session-tokens\.js/);
});
