#!/usr/bin/env node
// airprompt-activate.js — SessionStart hook (Claude Code wrapper).
//
// Thin wrapper that parses Claude's hook stdin, delegates to shared core logic,
// and formats output back to Claude's expected format.
//
// Claude Code SessionStart hook wrapper. Delegates to provider-agnostic core.
// Plugin.json and settings.json hook entries point here.

'use strict';

const ClaudeProvider = require('../providers/claude');
const { activateSession } = require('./core/activate');

async function main() {
  // Read stdin (provider passes hook context as JSON).
  // Skip stdin read when invoked from a TTY (e.g. autostart.sh immediate register)
  // or when piped stdin is already closed — for-await would hang forever.
  let input = '';
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    input = Buffer.concat(chunks).toString();
  }

  const ctx = ClaudeProvider.parseHookStdin(input);
  const result = await activateSession({ ...ctx, provider: ClaudeProvider });

  // Only write structured output for errors — Claude Code reads this as
  // hook feedback. Success cases already print human-friendly messages
  // via process.stdout.write in activateSession.
  if (result.status === 'error') {
    process.stdout.write(ClaudeProvider.formatHookOutput(result) + '\n');
  }
  // Let event loop drain before exit — ensures pending async work completes.
  setImmediate(() => process.exit(0));
}

main().catch(() => {
  setImmediate(() => process.exit(0));
});
