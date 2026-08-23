#!/usr/bin/env node
// airprompt — unified cross-platform installer.
//
// Adapted from caveman's bin/install.js. Single Node script replaces the manual
// multi-step install (clone → npm install → copy hooks → wire settings.json).
// Works on macOS, Linux, and Windows.
//
// Distribution:
//   Local clone: node bin/install.js [flags]
//   curl|bash:   delegated from install.sh shim → git clone + exec
//   Windows:     pwsh install.ps1 [flags] → same delegation
//
// Pure stdlib, zero npm runtime deps.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const registry = require('../src/providers/registry');
const { expandHome } = require('../src/install-helpers');

const REPO = 'farox-coop/airprompt';

// ── Argv ───────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    dryRun: false, force: false, withHooks: 'auto',
    only: [], uninstall: false, nonInteractive: false,
    configDir: null, help: false, noColor: false,
    targetDir: null, port: 3210,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--dry-run': opts.dryRun = true; break;
      case '--force': opts.force = true; break;
      case '--with-hooks': opts.withHooks = true; break;
      case '--no-hooks': opts.withHooks = false; break;
      case '--no-color': opts.noColor = true; break;
      case '--uninstall': case '-u': opts.uninstall = true; break;
      case '--non-interactive': opts.nonInteractive = true; break;
      case '-h': case '--help': opts.help = true; break;
      case '--': break;
      case '--list': printList(opts.noColor); process.exit(0);
      case '--only': {
        const v = argv[++i];
        if (!v) die('error: --only requires an argument');
        opts.only.push(v);
        break;
      }
      case '--config-dir': {
        const v = argv[++i];
        if (!v || v.startsWith('--')) die('error: --config-dir requires a path');
        opts.configDir = expandHome(v);
        break;
      }
      case '--target-dir': {
        const v = argv[++i];
        if (!v || v.startsWith('--')) die('error: --target-dir requires a path');
        opts.targetDir = expandHome(v);
        break;
      }
      case '--port': {
        const v = parseInt(argv[++i], 10);
        if (!v || v < 1 || v > 65535) die('error: --port requires a valid port (1-65535)');
        opts.port = v;
        break;
      }
      default:
        die(`error: unknown flag: ${a}\nrun 'airprompt --help' for usage`);
    }
  }
  if (opts.only.length) {
    const knownIds = new Set(registry.listProviders());
    const plannedIds = new Set(['codex', 'cursor', 'windsurf']); // not yet implemented
    for (const id of opts.only) {
      if (knownIds.has(id)) continue;
      if (plannedIds.has(id)) {
        die(`error: ${id} is not yet implemented — coming soon.\n  Available today: ${[...knownIds].join(', ')}`);
      }
      die(`error: unknown agent: ${id}\n  see 'airprompt --list' for valid ids`);
    }
  }
  return opts;
}

function die(msg) { process.stderr.write(msg + '\n'); process.exit(2); }

// ── Color helpers ──────────────────────────────────────────────────────────
function makeChalk(noColor) {
  const useColor = !noColor && process.stdout.isTTY && !process.env.NO_COLOR;
  const wrap = (codes) => (s) => useColor ? `\x1b[${codes}m${s}\x1b[0m` : s;
  return {
    orange: wrap('38;5;172'), dim: wrap('2'), red: wrap('31'),
    green: wrap('32'), yellow: wrap('33'),
  };
}

// ── Env guards ─────────────────────────────────────────────────────────────
function checkNodeVersion() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 18) die(`airprompt: Node ${process.versions.node} too old. Need Node ≥18. https://nodejs.org`);
}

// ── Repo root resolution ───────────────────────────────────────────────────
function detectRepoRoot() {
  const here = path.dirname(__filename);
  const root = path.resolve(here, '..');
  if (fs.existsSync(path.join(root, 'server.js')) &&
      fs.existsSync(path.join(root, 'src', 'hooks'))) {
    return root;
  }
  return null;
}

// ── Config dir resolution (shared) ─────────────────────────────────────────
function resolveConfigDir(opts, provider) {
  if (opts && opts.configDir) return opts.configDir;
  if (provider && typeof provider.configDir === 'function') return provider.configDir();
  throw new Error('airprompt: cannot resolve config dir — no provider, no --config-dir flag');
}

// ── Help ───────────────────────────────────────────────────────────────────
function printHelp() {
  process.stdout.write(`airprompt installer — one command to set up remote IDE/CLI access.

USAGE
  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash
  node bin/install.js [flags]
  bash install.sh [flags]
  pwsh install.ps1 [flags]

FLAGS
  --dry-run             Print what would run, do nothing.
  --force               Re-run even if already installed.
  --only <agent>        Install only for the named agent. Repeatable.
  --with-hooks          Wire standalone hooks into settings.json.
  --no-hooks            Skip hook wiring (plugin manifest handles hooks).
  --uninstall, -u       Remove airprompt from this machine.
  --config-dir <path>   IDE config dir. Default: provider-specific (~/.claude, ~/.codex, ...).
  --target-dir <path>   Where to install. Default: ~/.airprompt/.
  --port <n>            Daemon port. Default: 3210.
  --non-interactive     Never prompt; use defaults.
  --list                Print supported agents and exit.
  --no-color            Disable ANSI colors.
  -h, --help            Show this help.

EXAMPLES
  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash
  node bin/install.js --force
  node bin/install.js --uninstall

  Issues: https://github.com/${REPO}/issues
`);
}

function printList(noColor) {
  const c = makeChalk(noColor);
  process.stdout.write(c.orange('airprompt supported agents') + '\n\n');
  process.stdout.write(`  ${pad('ID', 10)} ${pad('AGENT', 18)} INSTALL MECHANISM\n`);
  process.stdout.write(`  ${pad('--', 10)} ${pad('-----', 18)} -----------------\n`);
  for (const prov of registry.allProviders()) {
    process.stdout.write(`  ${pad(prov.id, 10)} ${pad(prov.label, 18)} ${prov.mech}\n`);
  }
  process.stdout.write('\n');
}

function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }

// ── Uninstall (provider dispatch) ──────────────────────────────────────────
async function uninstall(ctx) {
  const { opts } = ctx;
  const want = (id) => opts.only.length === 0 || opts.only.includes(id);

  for (const prov of registry.allProviders()) {
    if (!want(prov.id)) continue;
    const configDir = resolveConfigDir(opts, prov);
    const provCtx = { ...ctx, configDir };
    try {
      await prov.uninstall(provCtx);
    } catch (e) {
      ctx.warn(`  ${prov.id} uninstall failed: ${e.message}`);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const c = makeChalk(opts.noColor);
  if (opts.help) { printHelp(); return 0; }

  checkNodeVersion();

  const repoRoot = detectRepoRoot();

  // Default configDir from first provider (or --config-dir flag)
  const firstProv = registry.allProviders()[0];
  const configDir = resolveConfigDir(opts, firstProv);

  const ctx = {
    opts, configDir, repoRoot,
    say:  (s) => process.stdout.write(c.orange(s) + '\n'),
    note: (s) => process.stdout.write(c.dim(s) + '\n'),
    warn: (s) => process.stderr.write(c.red(s) + '\n'),
    ok:   (s) => process.stdout.write(c.green(s) + '\n'),
    results: { installed: [], skipped: [], failed: [], detected: 0 },
  };

  if (opts.uninstall) { await uninstall(ctx); return 0; }

  ctx.say('airprompt installer');
  ctx.note(`  ${REPO}`);
  if (opts.dryRun) ctx.note('  (dry run — nothing will be written)');
  process.stdout.write('\n');

  const want = (id) => opts.only.length === 0 || opts.only.includes(id);

  for (const prov of registry.allProviders()) {
    if (!want(prov.id)) continue;
    const provConfigDir = resolveConfigDir(opts, prov);
    const provCtx = { ...ctx, configDir: provConfigDir };
    try {
      await prov.install(provCtx);
    } catch (e) {
      ctx.warn(`  ${prov.id} install failed: ${e.message}`);
      ctx.results.failed.push([prov.id, e.message]);
    }
  }

  // Summary
  ctx.say('done');
  if (ctx.results.installed.length) {
    ctx.ok('  installed:');
    for (const a of ctx.results.installed) process.stdout.write(`    • ${a}\n`);
  }
  if (ctx.results.skipped.length) {
    process.stdout.write('  skipped:\n');
    for (const [id, why] of ctx.results.skipped) process.stdout.write(`    • ${id} — ${why}\n`);
  }
  if (ctx.results.failed.length) {
    ctx.warn('  failed:');
    for (const [id, why] of ctx.results.failed) process.stderr.write(`    • ${id} — ${why}\n`);
  }
  process.stdout.write('\n');
  const stateDir = process.env.AIRPROMPT_STATE_DIR || path.join(os.homedir(), '.airprompt', 'state');
  const certFile = path.join(stateDir, 'airprompt-cert.pem');
  const keyFile = path.join(stateDir, 'airprompt-key.pem');
  const hasTls = fs.existsSync(certFile) && fs.existsSync(keyFile);
  ctx.note('  start your IDE and AirPrompt will auto-register each session');
  ctx.note(`  mobile URL: ${hasTls ? 'https' : 'http'}://<your-lan-ip>:${opts.port}`);
  ctx.note(`  uninstall: node ${path.join(opts.targetDir || path.join(os.homedir(), '.airprompt'), 'bin', 'install.js')} --uninstall`);

  return 0;
}

main().then(code => process.exit(code || 0))
      .catch(err => { process.stderr.write((err && err.stack || String(err)) + '\n'); process.exit(1); });
