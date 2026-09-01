#!/usr/bin/env node
// airprompt-activate.js — SessionStart hook wrapper.
//
// Provider-agnostic. Resolves the provider from argv (`node airprompt-activate.js codex`
// or `--provider codex`), parses that provider's hook stdin, and delegates to the
// shared core activation. Defaults to `claude` when no provider id is given.
//
// `--dump-stdin` prints the raw stdin it received and exits without side effects —
// a beta helper for confirming each IDE's exact hook wire format.

'use strict';

const { resolveProvider } = require('./core/resolve-provider');
const { activateSession } = require('./core/activate');

async function main() {
  const argv = process.argv.slice(2);
  const dumpStdin = argv.includes('--dump-stdin');

  // Read stdin (provider passes hook context as JSON).
  // Skip stdin read when invoked from a TTY (e.g. autostart.sh immediate register)
  // or when piped stdin is already closed — for-await would hang forever.
  let input = '';
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    input = Buffer.concat(chunks).toString();
  }

  if (dumpStdin) {
    process.stdout.write(input || '(no stdin)\n');
    process.exit(0);
  }

  const provider = resolveProvider(argv);
  const ctx = provider.parseHookStdin(input);
  const result = await activateSession({ ...ctx, provider });

  // Only write structured output for errors — the IDE reads this as hook
  // feedback. Success cases already print human-friendly messages via
  // process.stdout.write in activateSession.
  if (result.status === 'error') {
    process.stdout.write(provider.formatHookOutput(result) + '\n');
  }
  // Let event loop drain before exit — ensures pending async work completes.
  setImmediate(() => process.exit(0));
}

main().catch((e) => {
  process.stderr.write(`airprompt activate error: ${e && e.message ? e.message : e}\n`);
  setImmediate(() => process.exit(1));
});
