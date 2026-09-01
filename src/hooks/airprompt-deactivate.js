#!/usr/bin/env node
// airprompt-deactivate.js — Stop hook wrapper.
//
// Provider-agnostic. Resolves the provider from argv, parses its hook stdin,
// and delegates to the shared core deactivation. Defaults to `claude`.
//
// `--dump-stdin` prints the raw stdin it received and exits without side effects.

'use strict';

const { resolveProvider } = require('./core/resolve-provider');
const { deactivateSession } = require('./core/deactivate');

async function main() {
  const argv = process.argv.slice(2);
  const dumpStdin = argv.includes('--dump-stdin');

  // Read stdin (provider passes hook context as JSON).
  // Skip when TTY (same guard as activate.js) — never hang on inherited stdin.
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
  const result = await deactivateSession({ ...ctx, provider });

  // Silent when nothing to unregister (spurious Stop guard)
  if (result.sessionId) {
    process.stdout.write(provider.formatHookOutput(result) + '\n');
  }
  setImmediate(() => process.exit(0));
}

main().catch((e) => {
  process.stderr.write(`airprompt deactivate error: ${e && e.message ? e.message : e}\n`);
  setImmediate(() => process.exit(1));
});
