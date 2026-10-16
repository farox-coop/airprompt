#!/usr/bin/env node
// src/hooks/airprompt-session-tokens.js — "how many tokens is this session
// holding right now?"
//
// Every agent's notification hook wants the same badge: the size of the
// session's current context ("115k"), which is the number the statusline
// already shows. Where that number lives is entirely provider-specific — a
// Claude transcript and a Codex rollout share nothing but the JSONL shape — so
// the per-provider readers live here, in one place. Each notification hook
// calls this script instead of re-implementing its own provider's reader, and
// a provider nobody can read from simply prints nothing.
//
// Usage:
//   airprompt-session-tokens.js [--provider <id>] [--session-file <path>] [--tokens <n>]
//
//   --provider      claude | codex | cursor | windsurf. Default: sniff the
//                   session file, trying each reader in turn.
//   --session-file  the agent's session log (transcript / rollout JSONL).
//   --tokens        an already-known count, passed straight through — for
//                   agents whose notification payload carries the number
//                   itself.
//
// Prints "<N>k" (the same rounding the statusline badge uses) or nothing at
// all. Nothing is the contract: a caller drops the badge rather than showing
// an invented number.
//
// Requires: nothing. No deps, no daemon, no network.

'use strict';

const fs = require('fs');

const PROVIDERS = ['claude', 'codex', 'cursor', 'windsurf'];

// Only the end of the log matters — the notification fires right after a turn,
// so the newest usage record is within the last few lines. Reading a bounded
// tail keeps a multi-hundred-MB transcript as cheap as a small one.
//
// Sized from measurement, not taste: across the transcripts on the machine this
// was written on, the newest main-thread usage entry sat up to ~350 KB back from
// EOF (a turn can end with a long stretch of file-history, attachment and
// subagent lines). Too small a window does not degrade — it prints nothing, at
// exactly the moment the badge is wanted — so the window is set an order of
// magnitude clear of that, and one read of it still costs a few milliseconds.
const TAIL_BYTES = 4 * 1024 * 1024;

// ── Session log reading ─────────────────────────────────────────────────────

/**
 * Read at most `maxBytes` from the end of a file. A read that began mid-file
 * starts mid-line, so that leading fragment is dropped — unless the window
 * happens to begin exactly on a line boundary (the preceding byte is a newline),
 * in which case the first line is whole and is kept.
 * @param {string} file
 * @param {number} [maxBytes]
 * @returns {string}
 */
function readTail(file, maxBytes = TAIL_BYTES) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - Math.max(0, maxBytes));
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0 && !startsAtLineBoundary(fd, start)) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * True when the byte just before `offset` ends the previous line, i.e. the read
 * begins on a line boundary and nothing needs dropping.
 * @param {number} fd
 * @param {number} offset
 * @returns {boolean}
 */
function startsAtLineBoundary(fd, offset) {
  const prev = Buffer.alloc(1);
  return fs.readSync(fd, prev, 0, 1, offset - 1) === 1 && prev[0] === 0x0a;
}

/**
 * Walk JSONL from the end, returning the first non-null value `pick` yields.
 * Lines that are unparseable (a half-written last line, a chunk boundary) or
 * that parse to a non-object (`null` is valid JSON) are skipped — a caller is
 * reading a log somebody else is writing. An array parses to an object and is
 * simply inert: no reader matches one.
 * @param {string} text
 * @param {(entry: any) => number|null} pick
 * @returns {number|null}
 */
function findLast(text, pick) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const hit = pick(entry);
    if (typeof hit === 'number' && hit > 0) return hit;
  }
  return null;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

// ── Provider readers ────────────────────────────────────────────────────────
// Each returns the tokens the session's context currently holds, or null when
// this log carries no such record.

/**
 * True for the entry that marks a compaction boundary: a `system` entry with
 * `subtype: "compact_boundary"`, and — in the same event — the `user` entry
 * that carries the summary itself (`isCompactSummary`). Everything before such
 * an entry is no longer in the session's context.
 * @param {any} entry
 * @returns {boolean}
 */
function isCompactionBoundary(entry) {
  return entry.subtype === 'compact_boundary' || entry.isCompactSummary === true;
}

/**
 * Claude transcript: the newest main-thread assistant message's usage. The
 * three input counters together are the prompt that message was answered from
 * — i.e. the context size. Sidechain (subagent) entries are skipped: their
 * context is the subagent's own, not the session's (in the versions seen so
 * far, subagents write to their own files, so this is a safety net — a subagent
 * log handed in directly would still report its boundary's `postTokens` while
 * skipping every usage in it).
 *
 * A compaction boundary is where the naive reading goes wrong: `/compact` ends
 * its turn without a following assistant message, so the newest usage in the
 * file is the *pre*-compaction one and would report a context that no longer
 * exists (284k for a session now holding ~20k). When the newest boundary comes
 * after the newest usage, the newest boundary's own `postTokens` is the honest
 * answer; if that field is absent the count is unknown — never the stale usage,
 * and never an *older* boundary's number (that context has since been replaced
 * again).
 * @param {string} text
 * @returns {number|null}
 */
function claudeTokens(text) {
  let boundaryishSeen = 0;
  let sawSystemBoundary = false;
  let crossedUsage = false;
  let boundaryTokens = null;
  const usageTokens = findLast(text, (entry) => {
    if (isCompactionBoundary(entry)) {
      // At most one system boundary is consulted, and it belongs to the NEWEST
      // compaction event — never to an earlier one, whose context has since been
      // replaced again. Two things prove a boundary is older: an intervening
      // usage entry (a turn happened since), or a second boundary-ish entry (a
      // later compaction event of its own). The summary that follows the newest
      // boundary is the same event and carries no metadata, which is why the
      // walk does not stop at the first boundary-ish entry it meets.
      if (entry.subtype === 'compact_boundary' && !sawSystemBoundary) {
        sawSystemBoundary = true;
        if (!crossedUsage && boundaryishSeen <= 1) {
          const metadata = entry.compactMetadata;
          boundaryTokens = metadata ? num(metadata.postTokens) || null : null;
        }
      }
      boundaryishSeen++;
      return null; // keep walking: a usage *after* the boundary still wins
    }
    if (entry.type !== 'assistant' || entry.isSidechain) return null;
    const usage = entry.message && entry.message.usage;
    if (!usage) return null;
    if (boundaryishSeen > 0) {
      crossedUsage = true; // this usage belongs to a context a later boundary replaced
      return null;
    }
    const total =
      num(usage.input_tokens) +
      num(usage.cache_read_input_tokens) +
      num(usage.cache_creation_input_tokens);
    return total > 0 ? total : null;
  });
  return usageTokens || boundaryTokens;
}

/**
 * Codex rollout: the newest `token_count` event. `last_token_usage.input_tokens`
 * is the prompt that request re-sent, i.e. the context the session holds;
 * `total_tokens` adds that request's output, and `total_token_usage` is
 * cumulative over the whole session — orders of magnitude too large. Unlike
 * Anthropic's, Codex's `cached_input_tokens` is a subset of `input_tokens`, so
 * it is not added.
 * @param {string} text
 * @returns {number|null}
 */
function codexTokens(text) {
  return findLast(text, (entry) => {
    const payload = entry.payload;
    if (!payload || payload.type !== 'token_count' || !payload.info) return null;
    const last = payload.info.last_token_usage;
    if (!last) return null;
    const context = num(last.input_tokens) || num(last.total_tokens);
    return context > 0 ? context : null;
  });
}

// Cursor and Windsurf keep no local session log in a shape we can rely on:
// Cursor reports per-response usage to its hooks rather than to disk, and
// Windsurf's hook payload is undocumented. Both print nothing — a hook that
// *is* handed a number (Cursor's afterAgentResponse) passes it via --tokens.

const READERS = {
  claude: claudeTokens,
  codex: codexTokens,
  cursor: () => null,
  windsurf: () => null,
};

/** Reader order for --provider-less sniffing. */
const SNIFF_ORDER = ['claude', 'codex'];

// ── Formatting ──────────────────────────────────────────────────────────────

/**
 * Format a token count the way the *statusline's* badge reads — `115k`, the
 * number `~/.claude/hooks/statusline.sh` (`$(( (ctx_used + 500) / 1000 ))`)
 * wraps in its own colour codes. Same rounding on purpose: a hook
 * showing a different number than the statusline for the same moment reads as a
 * bug. (This file's `src/hooks/` neighbour, airprompt-statusline.sh, prints no
 * token count at all.)
 * @param {number} tokens
 * @returns {string}
 */
function badge(tokens) {
  return `${Math.floor((tokens + 500) / 1000)}k`;
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * @param {{provider?: string, sessionFile?: string, tokens?: number}} opts
 * @returns {string} badge, or '' when the count is unknown
 */
function resolveTokens(opts = {}) {
  // An explicit count is authoritative: invalid means unknown, never "read the
  // log instead" — a caller that passed one wanted that one.
  if (opts.tokens !== undefined) {
    return Number.isFinite(opts.tokens) && opts.tokens > 0 ? badge(opts.tokens) : '';
  }

  if (!opts.sessionFile) return '';
  let text;
  try {
    text = readTail(opts.sessionFile);
  } catch (_) {
    return ''; // missing/unreadable log is "unknown", never "zero"
  }

  const names = opts.provider ? [opts.provider] : SNIFF_ORDER;
  for (const name of names) {
    const reader = READERS[name];
    if (!reader) continue;
    const tokens = reader(text);
    if (tokens) return badge(tokens);
  }
  return '';
}

function parseArgs(argv) {
  const opts = {};
  let i = 0;
  // Every value-taking flag requires a non-empty value: a hook that builds its
  // command line from shell variables can silently drop one, and "no arguments"
  // must not quietly become a skipped badge.
  const value = (flag) => {
    const raw = argv[++i];
    if (raw === undefined || raw === '') throw new Error(`${flag} expects a value`);
    return raw;
  };
  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--provider') opts.provider = value(arg);
    else if (arg === '--session-file') opts.sessionFile = value(arg);
    else if (arg === '--tokens') {
      const raw = value(arg);
      const n = Number(raw);
      // Loud, like a bad --provider: a caller bug that silently degrades into
      // "no badge" is the failure this whole script exists to avoid, and
      // `Infinity` would otherwise print `Infinityk` as if it were a count.
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--tokens expects a positive number, got ${JSON.stringify(raw)}`);
      }
      opts.tokens = n;
    } else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (opts.provider && !PROVIDERS.includes(opts.provider)) {
    throw new Error(`unknown provider: ${opts.provider} (${PROVIDERS.join('|')})`);
  }
  return opts;
}

function usage() {
  return 'usage: airprompt-session-tokens.js [--provider <id>] [--session-file <path>] [--tokens <n>] [-h|--help]';
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`airprompt-session-tokens: ${e.message}\n${usage()}\n`);
    return 1;
  }
  if (opts.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const out = resolveTokens(opts);
  if (out) process.stdout.write(`${out}\n`);
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { resolveTokens, badge, readTail, claudeTokens, codexTokens, PROVIDERS };
