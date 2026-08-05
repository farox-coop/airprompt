#!/usr/bin/env node
// airprompt-deactivate.js — Stop hook (Claude Code wrapper).
//
// Thin wrapper that parses Claude's hook stdin, delegates to shared core logic,
// and formats output back to Claude's expected format.
//
// Claude Code Stop hook wrapper. Delegates to provider-agnostic core.
// Plugin.json and settings.json hook entries point here.

'use strict';

const ClaudeProvider = require('../providers/claude');
const { deactivateSession } = require('./core/deactivate');

async function main() {
  // Read stdin (provider passes hook context as JSON).
  // Skip when TTY (same guard as activate.js) — never hang on inherited stdin.
  let input = '';
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    input = Buffer.concat(chunks).toString();
  }

  const ctx = ClaudeProvider.parseHookStdin(input);
  const result = await deactivateSession({ ...ctx, provider: ClaudeProvider });

  // Silent when nothing to unregister (spurious Stop guard)
  if (result.sessionId) {
    process.stdout.write(ClaudeProvider.formatHookOutput(result) + '\n');
  }
  process.exit(0);
}

main().catch(() => process.exit(0));
