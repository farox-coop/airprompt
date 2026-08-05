// src/providers/claude.js — ClaudeProvider.
//
// All Claude-Code-specific logic extracted into one adapter.
// Implements the Provider interface defined in ./provider.js.
//
// Claude Code uses:
//   - ~/.claude/ for config (settings.json, hooks, skills, commands)
//   - Plugin system with manifest at .claude-plugin/plugin.json
//   - Hook events: SessionStart, Stop, StatusLine
//   - Command prefix: /

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { resolveInstallDir } = require('./provider');

// Lazy-loaded — only needed during install/uninstall, not hook execution
let SETTINGS, H;
function loadInstallDeps() {
  if (!SETTINGS) SETTINGS = require('../../bin/lib/settings');
  if (!H) H = require('../install-helpers');
  return { SETTINGS, H };
}

const REPO = 'diegomanuel/airprompt';

const HOOK_FILES = [
  'airprompt-activate.js',
  'airprompt-deactivate.js',
  'airprompt-statusline.sh',
];

// ── Detection ──────────────────────────────────────────────────────────────

function hasCmd(cmd) {
  try {
    const r = spawnSync('sh', ['-c', `command -v '${String(cmd).replace(/'/g, "'\\''")}'`], { stdio: 'ignore' });
    return r.status === 0;
  } catch (_) { return false; }
}

// ── Hook installer (standalone, non-plugin) ─────────────────────────────────

async function installHooks(ctx, targetDir) {
  const { SETTINGS, H } = loadInstallDeps();
  const { note, warn, opts } = ctx;
  const configDir = ctx.configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
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
    const src = path.join(sourceDir, f);
    if (!fs.existsSync(src)) {
      return `source hook not found: ${f}`;
    }

    // For .js hooks: rewrite relative require() paths to absolute install-dir paths.
    // Plugin installs use ${CLAUDE_PLUGIN_ROOT} → relative paths work (full src/ tree).
    // Standalone installs copy hooks to ~/.claude/hooks/ → need absolute paths.
    if (f.endsWith('.js')) {
      let content = fs.readFileSync(src, 'utf8');
      // Rewrite: require('../providers/X') → require('/abs/path/src/providers/X')
      content = content.replace(
        /require\((['"])(\.\.\/providers\/[^'"]+)\1\)/g,
        (m, q, p) => `require(${JSON.stringify(targetDir + '/src/providers/' + p.replace('../providers/', ''))})`
      );
      // Rewrite: require('./core/X') → require('/abs/path/src/hooks/core/X')
      content = content.replace(
        /require\((['"])(\.\/core\/[^'"]+)\1\)/g,
        (m, q, p) => `require(${JSON.stringify(targetDir + '/src/hooks/core/' + p.replace('./core/', ''))})`
      );
      fs.writeFileSync(dest, content);
    } else {
      fs.copyFileSync(src, dest);
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

  const node = H.absoluteNodePath();
  const activate = path.join(hooksDir, 'airprompt-activate.js');
  const deactivate = path.join(hooksDir, 'airprompt-deactivate.js');
  const statusline = path.join(hooksDir, 'airprompt-statusline.sh');

  SETTINGS.rewriteManagedHookCommands(settings, node);

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

// ── User command files (non-plugin fallback) ─────────────────────────────────

function copyUserFiles(ctx, targetDir) {
  const { note, opts } = ctx;
  const configDir = ctx.configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const commandsDir = path.join(configDir, 'commands');

  if (opts.dryRun) {
    note(`  would install ${path.join(commandsDir, 'airprompt.md')}`);
    note(`  would install ${path.join(commandsDir, 'airprompt.toml')}`);
    return;
  }

  fs.mkdirSync(commandsDir, { recursive: true });

  const cmdSrcMd = path.join(targetDir, 'commands', 'airprompt.md');
  const cmdSrcToml = path.join(targetDir, 'commands', 'airprompt.toml');
  if (fs.existsSync(cmdSrcMd)) {
    fs.copyFileSync(cmdSrcMd, path.join(commandsDir, 'airprompt.md'));
    process.stdout.write(`  installed: ${path.join(commandsDir, 'airprompt.md')}\n`);
  }
  if (fs.existsSync(cmdSrcToml)) {
    fs.copyFileSync(cmdSrcToml, path.join(commandsDir, 'airprompt.toml'));
    process.stdout.write(`  installed: ${path.join(commandsDir, 'airprompt.toml')}\n`);
  }
}

// ── Provider definition ────────────────────────────────────────────────────

/** @type {import('./provider').Provider} */
const ClaudeProvider = {
  id: 'claude',
  label: 'Claude Code',
  mech: 'claude plugin install',
  detect: 'command:claude',
  profile: null, // Claude uses native plugin installs, not skills.sh profiles

  // ── Config resolution ──────────────────────────────────────────────────

  /** @returns {string} */
  configDir() {
    if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
    return path.join(os.homedir(), '.claude');
  },

  /** @returns {string} */
  sessionsDir() {
    const { sessionsRootDir } = require('./provider');
    return sessionsRootDir();
  },

  /** @returns {string} */
  hooksDir() {
    return path.join(this.configDir(), 'hooks');
  },

  /** @returns {string} */
  hooksConfigPath() {
    return path.join(this.configDir(), 'settings.json');
  },

  /** @returns {string} */
  skillsDir() {
    return path.join(this.configDir(), 'skills');
  },

  /** @returns {string} */
  commandsDir() {
    return path.join(this.configDir(), 'commands');
  },

  /** @returns {string|null} */
  rulesDir() {
    return null; // Claude doesn't use .cursor/rules/ pattern
  },

  // ── Hook system ────────────────────────────────────────────────────────

  hookEvents: {
    sessionStart: 'SessionStart',
    stop: 'Stop',
    statusLine: 'StatusLine',
  },

  commandPrefix: '/',

  // ── Detection ──────────────────────────────────────────────────────────

  /**
   * Resolve ||-separated detection probes.
   * Supported kinds: command:, dir:, macapp:, vscode-ext:
   * @param {string} spec
   * @returns {boolean}
   */
  detectMatch(spec) {
    if (!spec) return false;
    for (const clause of spec.split('||')) {
      const c = clause.trim();
      if (!c) continue;
      const colon = c.indexOf(':');
      const kind = colon === -1 ? c : c.slice(0, colon);
      const val = colon === -1 ? '' : c.slice(colon + 1).replace(/^\$HOME/, os.homedir()).replace(/^~/, os.homedir());
      if (kind === 'command' && hasCmd(val)) return true;
      if (kind === 'dir' && fs.existsSync(val)) return true;
    }
    return false;
  },

  // ── Hook I/O (adapter pattern) ─────────────────────────────────────────

  /**
   * Parse Claude Code hook stdin JSON → normalized HookContext.
   * Claude passes hook context as JSON on stdin.
   * @param {string} input - raw stdin string
   * @returns {import('./provider').HookContext}
   */
  parseHookStdin(input) {
    let raw = {};
    try {
      if (input && input.trim()) raw = JSON.parse(input);
    } catch (_) { /* non-JSON stdin → use empty object */ }

    return {
      sessionId: raw.session_id || '',
      cwd: raw.cwd || process.cwd(),
      tmuxSession: raw.tmux_session || null,
      providerId: 'claude',
      raw,
    };
  },

  /**
   * Format HookResult → Claude Code stdout.
   * Claude reads hook stdout as JSON.
   * @param {import('./provider').HookResult} output
   * @returns {string}
   */
  formatHookOutput(output) {
    return JSON.stringify(output);
  },

  // ── Settings/hook wiring ───────────────────────────────────────────────

  /**
   * Build a Claude Code hook entry for settings.json.
   * Claude format: { hooks: [{ type: 'command', command: '...', timeout: N }] }
   * @param {string} event - hook event name (SessionStart, Stop)
   * @param {string} scriptPath - absolute path to hook script
   * @param {number} timeout - timeout in seconds
   * @returns {object}
   */
  buildHookEntry(event, scriptPath, timeout) {
    return {
      hooks: [{
        type: 'command',
        command: scriptPath,
        timeout,
      }],
    };
  },

  /**
   * Build a Claude Code statusLine entry.
   * Claude uses a top-level "statusLine" key (not inside hooks).
   * @param {string} scriptPath - absolute path to statusline script
   * @returns {{ type: string, command: string }}
   */
  buildStatusLineEntry(scriptPath) {
    return { type: 'command', command: `bash "${scriptPath}"` };
  },

  // ── Install / Uninstall ────────────────────────────────────────────────

  /**
   * Install AirPrompt for Claude Code.
   * Orchestrates: clone → npm install → cert → symlinks → plugin install → hooks → skills/commands.
   * @param {object} ctx — InstallContext + output helpers + results tracker
   * @returns {Promise<void>}
   */
  async install(ctx) {
    const { SETTINGS, H } = loadInstallDeps();
    const { say, note, warn, ok, opts, results } = ctx;
    const configDir = ctx.configDir || this.configDir();
    results.detected++;
    say('→ Claude Code detected');

    const targetDir = opts.targetDir || path.join(os.homedir(), '.airprompt');

    // 1. Clone or verify repo at target dir
    if (!fs.existsSync(targetDir)) {
      say('  → cloning AirPrompt repo');
      if (!opts.dryRun) {
        const r = H.spawnXplat('git', ['clone', '--depth', '1', `https://github.com/${REPO}.git`, targetDir],
          { stdio: 'inherit' });
        if (!H.spawnOk(r)) {
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
        const r = H.spawnXplat('npm', ['install', '--no-audit', '--no-fund', '--omit=dev'],
          { cwd: targetDir, stdio: 'inherit' });
        if (!H.spawnOk(r)) {
          warn('  npm install failed — daemon will not start until deps are installed');
          results.failed.push(['claude', 'npm install failed']);
        }
      } else {
        note('  would run: npm install in ' + targetDir);
      }
    } else {
      note('  dependencies already installed');
    }

    // 2b. Check jq
    H.checkJq(note, warn, ok, opts.dryRun, opts.nonInteractive);

    // 2c. Enforce HTTPS — generate TLS certificate
    if (!H.generateCert(targetDir, opts.dryRun, say, note, warn, ok)) {
      warn('  HTTPS not available — voice dictation and notifications may not work');
    }

    // 3. Create symlinks + provider wrappers in ~/bin/
    {
      const homeBin = path.join(os.homedir(), 'bin');
      const launchTarget = path.join(targetDir, 'bin', 'airprompt-launch');

      // ~/bin/ symlinks
      const entries = [
        { name: 'airprompt', target: path.join(targetDir, 'bin', 'airprompt') },
      ];

      if (!opts.dryRun) {
        try {
          fs.mkdirSync(homeBin, { recursive: true });
          for (const { name, target } of entries) {
            const linkPath = path.join(homeBin, name);
            try { fs.unlinkSync(linkPath); } catch (_) {}
            fs.symlinkSync(target, linkPath);
            process.stdout.write(`  symlink: ${linkPath} → ${target}\n`);
          }

          // airprompt-launch symlink (idempotent across providers)
          const launchLink = path.join(homeBin, 'airprompt-launch');
          if (!fs.existsSync(launchLink)) {
            fs.symlinkSync(launchTarget, launchLink);
            process.stdout.write(`  symlink: ${launchLink} → ${launchTarget}\n`);
          }

          // airprompt-{provider} wrapper script
          const wrapperPath = path.join(homeBin, `airprompt-${this.id}`);
          if (!fs.existsSync(wrapperPath)) {
            const wrapperContent = `#!/bin/bash\nexec airprompt-launch --provider ${this.id} "$@"\n`;
            fs.writeFileSync(wrapperPath, wrapperContent, { mode: 0o755 });
            process.stdout.write(`  wrapper: ${wrapperPath}\n`);
          }
        } catch (e) {
          note(`  could not create symlinks/wrappers: ${e.message} (non-fatal)`);
        }
      } else {
        for (const { name, target } of entries) {
          note(`  would symlink ${path.join(homeBin, name)} → ${target}`);
        }
        note(`  would symlink ${path.join(homeBin, 'airprompt-launch')} → ${launchTarget}`);
        note(`  would create ${path.join(homeBin, `airprompt-${this.id}`)} wrapper`);
      }
    }

    // 4. Claude Code plugin install (idempotent unless --force)
    let alreadyInstalled = false;
    if (!opts.force && hasCmd('claude')) {
      const r = H.captureSpawn('claude', ['plugin', 'list']);
      if (r.status === 0 && /airprompt/i.test(r.stdout || '')) alreadyInstalled = true;
    }
    let pluginInstallSucceeded = false;
    if (alreadyInstalled) {
      note('  airprompt plugin already installed (use --force to reinstall)');
      results.skipped.push(['claude', 'plugin already installed']);
      pluginInstallSucceeded = true;
    } else if (hasCmd('claude')) {
      say('  → installing Claude Code plugin');
      const pluginEnv = H.sameFilesystemTmpEnv(configDir);
      const r1 = H.runSpawn('claude', ['plugin', 'marketplace', 'add', REPO], { env: pluginEnv }, opts.dryRun);
      const r2 = H.runSpawn('claude', ['plugin', 'install', 'airprompt@airprompt'], { env: pluginEnv }, opts.dryRun);
      if (H.spawnOk(r1) && H.spawnOk(r2)) {
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

    // 5. Self-heal: prune orphaned hook entries
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

    // 6. Hook wiring decision
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

    // 7. Copy command files for non-plugin installs
    if (!pluginInstallSucceeded) {
      say('  → installing command files');
      copyUserFiles(ctx, targetDir);
      results.installed.push('claude-commands');
    }

    process.stdout.write('\n');
  },

  /**
   * Uninstall AirPrompt from Claude Code.
   * @param {object} ctx — InstallContext + output helpers
   * @returns {Promise<void>}
   */
  async uninstall(ctx) {
    const { SETTINGS, H } = loadInstallDeps();
    const { say, note, warn, ok, opts } = ctx;
    const configDir = ctx.configDir || this.configDir();
    say('airprompt uninstall');

    if (opts.dryRun) note('  (dry run — nothing will be removed)');

    // 1. Stop daemon
    const pidFile = process.env.AIRPROMPT_PID_FILE || '/tmp/airprompt-server.pid';
    if (fs.existsSync(pidFile)) {
      if (opts.dryRun) {
        note(`  would stop daemon (PID file: ${pidFile})`);
      } else {
        try {
          const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
          process.kill(pid, 'SIGTERM');
          note('  stopped daemon');
        } catch (_) { /* already dead */ }
        try { fs.unlinkSync(pidFile); } catch (_) {}
      }
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

    // 4. Remove ~/bin/ symlinks + all provider wrappers
    {
      const homeBin = path.join(os.homedir(), 'bin');
      // Core symlinks + wrappers
      const entries = ['airprompt', 'airprompt-launch'];
      // All known provider wrappers — comprehensive list covers any that
      // may have been generated by install or airprompt-launch self-bootstrap.
      const wrapperProviders = ['claude', 'codex', 'cursor', 'windsurf'];
      for (const prov of wrapperProviders) {
        entries.push(`airprompt-${prov}`);
      }

      for (const name of entries) {
        const linkPath = path.join(homeBin, name);
        if (!fs.existsSync(linkPath)) continue;
        if (!opts.dryRun) { try { fs.unlinkSync(linkPath); } catch (_) {} }
        note(`  removed ${linkPath}`);
      }
    }

    // 5. Remove command files (mirrors copyUserFiles)
    {
      const commandsDir = path.join(configDir, 'commands');
      for (const f of ['airprompt.md', 'airprompt.toml']) {
        const dest = path.join(commandsDir, f);
        if (fs.existsSync(dest)) {
          if (!opts.dryRun) { try { fs.unlinkSync(dest); } catch (_) {} }
          note(`  removed ${dest}`);
        }
      }
    }

    // 6. Claude Code plugin uninstall
    if (hasCmd('claude')) {
      const probe = H.captureSpawn('claude', ['plugin', 'list']);
      if (probe.status === 0 && /airprompt/i.test(probe.stdout || '')) {
        const r = H.runSpawn('claude', ['plugin', 'uninstall', 'airprompt@airprompt'], null, opts.dryRun);
        if (H.spawnOk(r)) ok('  removed claude plugin');
      } else {
        note('  claude plugin not installed — skipping');
      }
    }

    // 7. Remove per-session directories (~/.airprompt/sessions/)
    const sessionsDir = path.join(os.homedir(), '.airprompt', 'sessions');
    if (fs.existsSync(sessionsDir)) {
      if (!opts.dryRun) {
        try {
          for (const entry of fs.readdirSync(sessionsDir)) {
            const p = path.join(sessionsDir, entry);
            if (fs.statSync(p).isDirectory()) {
              fs.rmSync(p, { recursive: true, force: true });
            }
          }
          fs.rmdirSync(sessionsDir);
        } catch (_) {}
      }
      note(`  removed ${sessionsDir}`);
    }

    // 9. Remove install dir contents (~/.airprompt/) — keep state/ (user data)
    const targetDir = opts.targetDir || path.join(os.homedir(), '.airprompt');
    if (fs.existsSync(targetDir)) {
      if (!opts.dryRun) {
        try {
          for (const entry of fs.readdirSync(targetDir)) {
            if (entry === 'state') continue;  // preserve user data
            fs.rmSync(path.join(targetDir, entry), { recursive: true, force: true });
          }
        } catch (_) {}
      }
      note(`  removed ${targetDir} (state/ kept)`);
    }
  },

  // ── File manifests ─────────────────────────────────────────────────────

  /** @returns {{src: string, dest: string}[]} */
  getHookFiles() {
    const installDir = resolveInstallDir();
    const hooksDir = this.hooksDir();
    const srcDir = path.join(installDir, 'src', 'hooks');
    return [
      { src: path.join(srcDir, 'airprompt-activate.js'), dest: path.join(hooksDir, 'airprompt-activate.js') },
      { src: path.join(srcDir, 'airprompt-deactivate.js'), dest: path.join(hooksDir, 'airprompt-deactivate.js') },
      { src: path.join(srcDir, 'airprompt-statusline.sh'), dest: path.join(hooksDir, 'airprompt-statusline.sh') },
    ];
  },

  /** @returns {{src: string, dest: string}[]} */
  getSkillFiles() {
    // Claude ships skill functionality via plugin manifest + commands.
    // No standalone skill files to copy to ~/.claude/skills/.
    return [];
  },

  /** @returns {{src: string, dest: string}[]} */
  getCommandFiles() {
    const installDir = resolveInstallDir();
    const commandsDir = this.commandsDir();
    return [
      { src: path.join(installDir, 'commands', 'airprompt.md'), dest: path.join(commandsDir, 'airprompt.md') },
      { src: path.join(installDir, 'commands', 'airprompt.toml'), dest: path.join(commandsDir, 'airprompt.toml') },
    ];
  },

  /** @returns {{src: string, dest: string}[]} */
  getRuleFiles() {
    return []; // Claude doesn't use rule .md files
  },
};

module.exports = ClaudeProvider;
