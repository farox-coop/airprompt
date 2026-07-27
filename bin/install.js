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
const child_process = require('child_process');
const readline = require('readline');
const crypto = require('crypto');

const SETTINGS = require('./lib/settings');

const REPO = 'diegomanuel/airprompt';
const PINNED_REF = process.env.AIRPROMPT_REF || 'main';
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${PINNED_REF}`;

const HOOK_FILES = [
  'package.json',
  'airprompt-activate.js',
  'airprompt-deactivate.js',
  'airprompt-statusline.sh',
];

const PROVIDERS = [
  { id: 'claude', label: 'Claude Code', mech: 'claude plugin install', detect: 'command:claude' },
];

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
    const knownIds = new Set(PROVIDERS.map(p => p.id));
    for (const id of opts.only) {
      if (!knownIds.has(id)) die(`error: unknown agent: ${id}\n  see 'airprompt --list' for valid ids`);
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

// ── Detection ─────────────────────────────────────────────────────────────
function hasCmd(cmd) {
  try {
    if (process.platform === 'win32') {
      const r = child_process.spawnSync('where', [cmd], { stdio: 'ignore' });
      return r.status === 0;
    }
    const r = child_process.spawnSync('sh', ['-c', `command -v ${shellEscape(cmd)}`], { stdio: 'ignore' });
    return r.status === 0;
  } catch (_) { return false; }
}

function shellEscape(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

function expandHome(p) { return p.replace(/^\$HOME/, os.homedir()).replace(/^~/, os.homedir()); }

function detectMatch(spec) {
  if (!spec) return false;
  for (const clause of spec.split('||')) {
    const c = clause.trim();
    if (!c) continue;
    const colon = c.indexOf(':');
    const kind = colon === -1 ? c : c.slice(0, colon);
    const val  = colon === -1 ? '' : expandHome(c.slice(colon + 1));
    if (kind === 'command' && hasCmd(val)) return true;
  }
  return false;
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

// ── Run helpers ────────────────────────────────────────────────────────────
const IS_WIN = process.platform === 'win32';

function spawnXplat(cmd, args, opts) {
  if (IS_WIN) {
    const quoted = args.map(a => {
      if (a === '' || /[\s"]/.test(a)) return '"' + String(a).replace(/"/g, '\\"') + '"';
      return a;
    }).join(' ');
    return child_process.spawnSync(`${cmd} ${quoted}`, [], Object.assign({ shell: true }, opts || {}));
  }
  return child_process.spawnSync(cmd, args, opts || {});
}

function runSpawn(cmd, args, opts, dry) {
  if (dry) { process.stdout.write(`  would run: ${cmd} ${args.join(' ')}\n`); return { status: 0 }; }
  process.stdout.write(`  $ ${cmd} ${args.join(' ')}\n`);
  return spawnXplat(cmd, args, Object.assign({ stdio: 'inherit' }, opts || {}));
}

function captureSpawn(cmd, args) {
  try { return spawnXplat(cmd, args, { encoding: 'utf8' }); }
  catch (_) { return { status: 1, stdout: '', stderr: '' }; }
}

function spawnOk(r) { return !!r && !r.error && r.status === 0; }

function absoluteNodePath() { return process.execPath; }

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

// Create env with TMPDIR inside configDir for same-filesystem renames
function sameFilesystemTmpEnv(configDir) {
  const tmpDir = path.join(configDir, 'tmp');
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) {}
  return Object.assign({}, process.env, { TMPDIR: tmpDir, TEMP: tmpDir, TMP: tmpDir });
}

// ── perClaudeConfigDir ─────────────────────────────────────────────────────
function claudeConfigDir(opts) {
  if (opts && opts.configDir) return opts.configDir;
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  return path.join(os.homedir(), '.claude');
}

// ── Per-provider installers ────────────────────────────────────────────────
async function installClaude(ctx) {
  const { say, note, warn, ok, opts, results, configDir } = ctx;
  results.detected++;
  say('→ Claude Code detected');

  const targetDir = opts.targetDir || path.join(os.homedir(), '.airprompt');

  // 1. Clone or verify repo at target dir
  if (!fs.existsSync(targetDir)) {
    say('  → cloning AirPrompt repo');
    if (!opts.dryRun) {
      const r = spawnXplat('git', ['clone', '--depth', '1', `https://github.com/${REPO}.git`, targetDir],
        { stdio: 'inherit' });
      if (!spawnOk(r)) {
        warn('  failed to clone repo');
        results.failed.push(['claude', 'git clone failed']);
        return;
      }
    } else {
      note(`  would clone ${REPO} → ${targetDir}`);
    }
  } else {
    note(`  ${targetDir} exists — using existing install`);
  }

  // 2. Ensure node_modules exist
  const nmDir = path.join(targetDir, 'node_modules');
  if (!fs.existsSync(nmDir) || !fs.existsSync(path.join(nmDir, 'express'))) {
    say('  → installing npm dependencies');
    if (!opts.dryRun) {
      const r = spawnXplat('npm', ['install', '--no-audit', '--no-fund', '--omit=dev'],
        { cwd: targetDir, stdio: 'inherit' });
      if (!spawnOk(r)) {
        warn('  npm install failed — daemon will not start until deps are installed');
      }
    } else {
      note('  would run: npm install in ' + targetDir);
    }
  } else {
    note('  dependencies already installed');
  }

  // 3. Claude Code plugin install (idempotent unless --force)
  let alreadyInstalled = false;
  if (!opts.force && hasCmd('claude')) {
    const r = captureSpawn('claude', ['plugin', 'list']);
    if (r.status === 0 && /airprompt/i.test(r.stdout || '')) alreadyInstalled = true;
  }
  let pluginInstallSucceeded = false;
  if (alreadyInstalled) {
    note('  airprompt plugin already installed (use --force to reinstall)');
    results.skipped.push(['claude', 'plugin already installed']);
    pluginInstallSucceeded = true;
  } else if (hasCmd('claude')) {
    say('  → installing Claude Code plugin');
    const pluginEnv = sameFilesystemTmpEnv(configDir);
    const r1 = runSpawn('claude', ['plugin', 'marketplace', 'add', REPO], { env: pluginEnv }, opts.dryRun);
    const r2 = runSpawn('claude', ['plugin', 'install', 'airprompt@airprompt'], { env: pluginEnv }, opts.dryRun);
    if (spawnOk(r1) && spawnOk(r2)) {
      results.installed.push('claude');
      pluginInstallSucceeded = true;
    } else {
      if (r1.error || r2.error) {
        warn('  claude CLI not found on PATH (or could not be spawned)');
      }
      results.failed.push(['claude', 'claude plugin install failed']);
    }
  } else {
    warn('  claude CLI not found — skipping plugin install');
    note('  hooks will be wired standalone instead');
  }

  // 4. Self-heal: prune orphaned hook entries
  {
    const settingsPath = path.join(configDir, 'settings.json');
    const settings = SETTINGS.readSettings(settingsPath);
    if (settings) {
      const pruned = SETTINGS.pruneOrphanedManagedHooks(settings, configDir);
      if (pruned > 0) {
        note(`  removed ${pruned} orphaned airprompt hook entr${pruned === 1 ? 'y' : 'ies'} from settings.json`);
        if (!opts.dryRun) {
          SETTINGS.validateHookFields(settings);
          SETTINGS.writeSettings(settingsPath, settings);
        }
      }
    }
  }

  // 5. Hook wiring decision
  let shouldWireHooks;
  if (opts.withHooks === false) {
    shouldWireHooks = false;
  } else if (opts.withHooks === true) {
    shouldWireHooks = true;
    if (pluginInstallSucceeded) {
      warn('  --with-hooks wires hooks in settings.json alongside the plugin manifest.');
      warn('  Both will fire on every event. Pass --no-hooks to keep only the plugin path.');
    }
  } else {
    shouldWireHooks = !pluginInstallSucceeded;
    if (!shouldWireHooks) {
      note('  hooks: plugin manifest handles SessionStart + Stop');
      note('  (pass --with-hooks to also wire standalone hooks in settings.json)');
      results.skipped.push(['claude-hooks', 'plugin manifest handles hooks']);
    } else {
      note('  hooks: plugin install did not succeed; falling back to standalone wiring');
    }
  }

  if (shouldWireHooks) {
    say('  → installing hooks');
    const r = await installHooks(ctx, targetDir);
    if (r === 'ok') results.installed.push('claude-hooks');
    else if (r === 'skip') results.skipped.push(['claude-hooks', 'already wired']);
    else results.failed.push(['claude-hooks', r]);
  }

  // 6. Copy skill + command files for non-plugin installs
  if (!pluginInstallSucceeded) {
    say('  → installing skill + command files');
    copyUserFiles(ctx, targetDir);
    results.installed.push('claude-skills-commands');
  }

  process.stdout.write('\n');
}

// ── Hook installer ─────────────────────────────────────────────────────────
async function installHooks(ctx, targetDir) {
  const { note, warn, opts, configDir } = ctx;
  const hooksDir = path.join(configDir, 'hooks');
  const settingsPath = path.join(configDir, 'settings.json');
  const sourceDir = path.join(targetDir, 'src', 'hooks');

  if (opts.dryRun) {
    note(`  would mkdir -p ${hooksDir}`);
    for (const f of HOOK_FILES) note(`  would install ${path.join(hooksDir, f)}`);
    note(`  would merge SessionStart + Stop + statusline into ${settingsPath}`);
    return 'ok';
  }

  fs.mkdirSync(hooksDir, { recursive: true });

  for (const f of HOOK_FILES) {
    const dest = path.join(hooksDir, f);
    if (fs.existsSync(path.join(sourceDir, f))) {
      fs.copyFileSync(path.join(sourceDir, f), dest);
    } else {
      return `source hook not found: ${f}`;
    }
    process.stdout.write(`  installed: ${dest}\n`);
  }

  try { fs.chmodSync(path.join(hooksDir, 'airprompt-statusline.sh'), 0o755); } catch (_) {}

  let settings = SETTINGS.readSettings(settingsPath);
  if (settings === null) {
    warn('  settings.json unparseable; will not touch it. Edit manually then re-run.');
    return 'settings.json unparseable';
  }

  const bak = settingsPath + '.bak';
  if (fs.existsSync(settingsPath) && !fs.existsSync(bak)) {
    try { fs.copyFileSync(settingsPath, bak); } catch (_) {}
  }

  const node = absoluteNodePath();
  const activate = path.join(hooksDir, 'airprompt-activate.js');
  const deactivate = path.join(hooksDir, 'airprompt-deactivate.js');
  const statusline = path.join(hooksDir, 'airprompt-statusline.sh');

  SETTINGS.rewriteLegacyManagedHookCommands(settings, node);

  SETTINGS.addCommandHook(settings, 'SessionStart', {
    command: `"${node}" "${activate}"`,
    marker: 'airprompt-activate',
    timeout: 10,
    statusMessage: 'Registering AirPrompt session...',
  });

  SETTINGS.addCommandHook(settings, 'Stop', {
    command: `"${node}" "${deactivate}"`,
    marker: 'airprompt-deactivate',
    timeout: 5,
    statusMessage: 'Unregistering AirPrompt session...',
  });

  if (!settings.statusLine) {
    settings.statusLine = { type: 'command', command: `bash "${statusline}"` };
    process.stdout.write('  statusline badge configured.\n');
  } else {
    const existing = typeof settings.statusLine === 'string'
      ? settings.statusLine
      : (settings.statusLine.command || '');
    if (existing.includes(statusline) || existing.includes('airprompt-statusline')) {
      process.stdout.write('  statusline badge already configured.\n');
    } else {
      process.stdout.write('  NOTE: existing statusline detected — airprompt badge NOT added.\n');
    }
  }

  SETTINGS.validateHookFields(settings);
  SETTINGS.writeSettings(settingsPath, settings);
  process.stdout.write(`  hooks wired in ${settingsPath}\n`);
  return 'ok';
}

// ── User skill + command files (non-plugin fallback) ───────────────────────
function copyUserFiles(ctx, targetDir) {
  const { note, opts, configDir } = ctx;
  const commandsDir = path.join(configDir, 'commands');
  const skillsDir = path.join(configDir, 'skills');

  if (opts.dryRun) {
    note(`  would install ${path.join(commandsDir, 'airprompt.md')}`);
    note(`  would install ${path.join(skillsDir, 'airprompt.md')}`);
    return;
  }

  fs.mkdirSync(commandsDir, { recursive: true });
  fs.mkdirSync(skillsDir, { recursive: true });

  // Command
  const cmdSrc = path.join(targetDir, '.claude', 'commands', 'airprompt.md');
  const cmdDest = path.join(commandsDir, 'airprompt.md');
  if (fs.existsSync(cmdSrc)) {
    fs.copyFileSync(cmdSrc, cmdDest);
    process.stdout.write(`  installed: ${cmdDest}\n`);
  }

  // Skill
  const skillSrc = path.join(targetDir, '.claude', 'skills', 'airprompt.md');
  const skillDest = path.join(skillsDir, 'airprompt.md');
  if (fs.existsSync(skillSrc)) {
    fs.copyFileSync(skillSrc, skillDest);
    process.stdout.write(`  installed: ${skillDest}\n`);
  }
}

// ── Uninstall ──────────────────────────────────────────────────────────────
function uninstall(ctx) {
  const { say, note, warn, ok, opts, configDir } = ctx;
  say('airprompt uninstall');

  if (opts.dryRun) note('  (dry run — nothing will be removed)');

  // 1. Stop daemon
  const pidFile = '/tmp/airprompt-server.pid';
  if (fs.existsSync(pidFile)) {
    try {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      process.kill(pid, 'SIGTERM');
      note('  stopped daemon');
    } catch (_) { /* already dead */ }
    if (!opts.dryRun) { try { fs.unlinkSync(pidFile); } catch (_) {} }
  }

  // 2. Remove hooks from settings.json
  const hooksDir = path.join(configDir, 'hooks');
  const settingsPath = path.join(configDir, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    const settings = SETTINGS.readSettings(settingsPath);
    if (settings) {
      const removed = SETTINGS.removeAirPromptHooks(settings);
      if (settings.statusLine) {
        const cmd = typeof settings.statusLine === 'string' ? settings.statusLine : (settings.statusLine.command || '');
        if (cmd.includes('airprompt-statusline')) delete settings.statusLine;
      }
      SETTINGS.validateHookFields(settings);
      if (!opts.dryRun) SETTINGS.writeSettings(settingsPath, settings);
      ok(`  removed ${removed} airprompt hook entr${removed === 1 ? 'y' : 'ies'} from settings.json`);
    }
  }

  // 3. Delete hook files
  if (fs.existsSync(hooksDir)) {
    for (const f of HOOK_FILES) {
      const p = path.join(hooksDir, f);
      if (!fs.existsSync(p)) continue;
      if (!opts.dryRun) { try { fs.unlinkSync(p); } catch (_) {} }
      note(`  removed ${p}`);
    }
  }

  // 4. Remove skill + command files
  for (const type of ['commands', 'skills']) {
    const dest = path.join(configDir, type, 'airprompt.md');
    if (fs.existsSync(dest)) {
      if (!opts.dryRun) { try { fs.unlinkSync(dest); } catch (_) {} }
      note(`  removed ${dest}`);
    }
  }

  // 5. Claude Code plugin uninstall
  if (hasCmd('claude')) {
    const probe = captureSpawn('claude', ['plugin', 'list']);
    if (probe.status === 0 && /airprompt/i.test(probe.stdout || '')) {
      const r = runSpawn('claude', ['plugin', 'uninstall', 'airprompt@airprompt'], null, opts.dryRun);
      if (spawnOk(r)) ok('  removed claude plugin');
    } else {
      note('  claude plugin not installed — skipping');
    }
  }

  // 6. Remove marker files
  for (const f of ['.airprompt-active', '.airprompt-url', '.airprompt-session', '.airprompt-tmux-active', '.airprompt-tmux-session']) {
    const p = path.join(configDir, f);
    if (fs.existsSync(p)) {
      if (!opts.dryRun) { try { fs.unlinkSync(p); } catch (_) {} }
      note(`  removed ${p}`);
    }
  }

  // 7. Target dir removal prompt
  const targetDir = opts.targetDir || path.join(os.homedir(), '.airprompt');
  if (fs.existsSync(targetDir)) {
    note(`  airprompt install dir at ${targetDir} left in place.`);
    note(`  Remove manually: rm -rf ${targetDir}`);
  }
}

// ── Help ───────────────────────────────────────────────────────────────────
function printHelp() {
  process.stdout.write(`airprompt installer — one command to set up remote Claude Code access.

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
  --config-dir <path>   Claude Code config dir. Default: \$CLAUDE_CONFIG_DIR or ~/.claude.
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
  for (const p of PROVIDERS) {
    process.stdout.write(`  ${pad(p.id, 10)} ${pad(p.label, 18)} ${p.mech}\n`);
  }
  process.stdout.write('\n');
}

function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const c = makeChalk(opts.noColor);
  if (opts.help) { printHelp(); return 0; }

  checkNodeVersion();

  const configDir = claudeConfigDir(opts);
  const repoRoot = detectRepoRoot();

  const ctx = {
    opts, configDir, repoRoot,
    say:  (s) => process.stdout.write(c.orange(s) + '\n'),
    note: (s) => process.stdout.write(c.dim(s) + '\n'),
    warn: (s) => process.stderr.write(c.red(s) + '\n'),
    ok:   (s) => process.stdout.write(c.green(s) + '\n'),
    results: { installed: [], skipped: [], failed: [], detected: 0 },
  };

  if (opts.uninstall) { uninstall(ctx); return 0; }

  ctx.say('airprompt installer');
  ctx.note(`  ${REPO}`);
  if (opts.dryRun) ctx.note('  (dry run — nothing will be written)');
  process.stdout.write('\n');

  const want = (id) => opts.only.length === 0 || opts.only.includes(id);

  for (const prov of PROVIDERS) {
    if (!want(prov.id)) continue;
    if (prov.id === 'claude') { await installClaude(ctx); continue; }
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
  ctx.note('  start Claude Code and AirPrompt will auto-register each session');
  ctx.note(`  mobile URL: http://<your-lan-ip>:${opts.port}`);
  ctx.note(`  uninstall: node ${path.join(opts.targetDir || path.join(os.homedir(), '.airprompt'), 'bin', 'install.js')} --uninstall`);

  return 0;
}

main().then(code => process.exit(code || 0))
      .catch(err => { process.stderr.write((err && err.stack || String(err)) + '\n'); process.exit(1); });
