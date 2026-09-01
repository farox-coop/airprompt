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

const { resolveInstallDir, hasCmd, detectMatch, sessionsRootDir } = require('./provider');
const { ensureCoreInstall } = require('./install-common');
const { safeRmSync } = require('../utils');

// Lazy-loaded — only needed during install/uninstall, not hook execution
let SETTINGS, H;
function loadInstallDeps() {
  if (!SETTINGS) SETTINGS = require('../../bin/lib/settings');
  if (!H) H = require('../install-helpers');
  return { SETTINGS, H };
}

const REPO = 'farox-coop/airprompt';

const HOOK_FILES = ['airprompt-activate.js', 'airprompt-deactivate.js', 'airprompt-statusline.sh'];

// ── Hook installer (standalone, non-plugin) ─────────────────────────────────

async function installHooks(ctx, targetDir) {
  const { SETTINGS, H } = loadInstallDeps();
  const { note, warn, opts } = ctx;
  const configDir =
    ctx.configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const hooksDir = path.join(configDir, 'hooks');
  const settingsPath = path.join(configDir, 'settings.json');
  const sourceDir = path.join(targetDir, 'src', 'hooks');

  if (opts.dryRun) {
    note(`  would mkdir -p ${hooksDir}`);
    for (const f of HOOK_FILES) note(`  would install ${path.join(hooksDir, f)}`);
    note(`  would merge SessionStart + Stop into ${settingsPath}`);
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
        (m, q, p) =>
          `require(${JSON.stringify(targetDir + '/src/providers/' + p.replace('../providers/', ''))})`
      );
      // Rewrite: require('./core/X') → require('/abs/path/src/hooks/core/X')
      content = content.replace(
        /require\((['"])(\.\/core\/[^'"]+)\1\)/g,
        (m, q, p) =>
          `require(${JSON.stringify(targetDir + '/src/hooks/core/' + p.replace('./core/', ''))})`
      );
      fs.writeFileSync(dest, content);
    } else {
      fs.copyFileSync(src, dest);
    }
    process.stdout.write(`  installed: ${dest}\n`);
  }

  try {
    fs.chmodSync(path.join(hooksDir, 'airprompt-statusline.sh'), 0o755);
  } catch (_) {}

  let settings = SETTINGS.readSettings(settingsPath);
  if (settings === null) {
    warn('  settings.json unparseable; will not touch it. Edit manually then re-run.');
    return 'settings.json unparseable';
  }

  const bak = settingsPath + '.bak';
  if (fs.existsSync(settingsPath) && !fs.existsSync(bak)) {
    try {
      fs.copyFileSync(settingsPath, bak);
    } catch (_) {}
  }

  const node = H.absoluteNodePath();
  const activate = path.join(hooksDir, 'airprompt-activate.js');
  const deactivate = path.join(hooksDir, 'airprompt-deactivate.js');

  const rewritten = SETTINGS.rewriteManagedHookCommands(settings, node);

  const addedStart = SETTINGS.addCommandHook(settings, 'SessionStart', {
    command: `"${node}" "${activate}"`,
    marker: 'airprompt-activate',
    timeout: 10,
    statusMessage: 'Registering AirPrompt session...',
  });

  const addedStop = SETTINGS.addCommandHook(settings, 'Stop', {
    command: `"${node}" "${deactivate}"`,
    marker: 'airprompt-deactivate',
    timeout: 5,
    statusMessage: 'Unregistering AirPrompt session...',
  });

  SETTINGS.validateHookFields(settings);
  if (rewritten > 0 || addedStart || addedStop) {
    SETTINGS.writeSettings(settingsPath, settings);
    process.stdout.write(`  hooks wired in ${settingsPath}\n`);
  } else {
    process.stdout.write('  hooks already wired — nothing to do\n');
  }
  return 'ok';
}

// ── Statusline badge (always wired — plugin manifests cannot declare statusLine) ──

async function installStatusline(ctx, targetDir) {
  const { SETTINGS } = loadInstallDeps();
  const { note, warn, opts } = ctx;
  const configDir =
    ctx.configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const hooksDir = path.join(configDir, 'hooks');
  const settingsPath = path.join(configDir, 'settings.json');
  const src = path.join(targetDir, 'src', 'hooks', 'airprompt-statusline.sh');
  const dest = path.join(hooksDir, 'airprompt-statusline.sh');

  if (opts.dryRun) {
    note(`  would install ${dest} + wire statusLine into ${settingsPath}`);
    return 'ok';
  }

  if (!fs.existsSync(src)) return 'source hook not found: airprompt-statusline.sh';

  const settings = SETTINGS.readSettings(settingsPath);
  if (settings === null) {
    warn('  settings.json unparseable; statusline not wired. Edit manually then re-run.');
    return 'settings.json unparseable';
  }

  // Never clobber an existing statusline — a user may have their own, or a
  // prior install already wired the badge. Report, don't rewrite.
  if (settings.statusLine !== undefined) {
    const existing =
      typeof settings.statusLine === 'string'
        ? settings.statusLine
        : settings.statusLine && typeof settings.statusLine.command === 'string'
          ? settings.statusLine.command
          : '';
    if (existing.includes('airprompt-statusline')) {
      process.stdout.write('  statusline badge already configured.\n');
    } else {
      process.stdout.write('  NOTE: existing statusline detected — airprompt badge NOT added.\n');
    }
    return 'skip';
  }

  fs.mkdirSync(hooksDir, { recursive: true });
  fs.copyFileSync(src, dest);
  try {
    fs.chmodSync(dest, 0o755);
  } catch (_) {}
  process.stdout.write(`  installed: ${dest}\n`);

  const bak = settingsPath + '.bak';
  if (fs.existsSync(settingsPath) && !fs.existsSync(bak)) {
    try {
      fs.copyFileSync(settingsPath, bak);
    } catch (_) {}
  }

  settings.statusLine = { type: 'command', command: `bash "${dest}"` };
  SETTINGS.writeSettings(settingsPath, settings);
  process.stdout.write('  statusline badge configured.\n');
  return 'ok';
}

// ── User command files (non-plugin fallback) ─────────────────────────────────

function copyUserFiles(ctx, targetDir) {
  const { note, opts } = ctx;
  const configDir =
    ctx.configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
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
  detect: 'command:claude||dir:$HOME/.claude||vscode-ext:anthropic.claude-code',
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

  // ── Detection (shared — see provider.js) ────────────────────────────────

  detectMatch,

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
    } catch (_) {
      /* non-JSON stdin → use empty object */
    }

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
      hooks: [
        {
          type: 'command',
          command: scriptPath,
          timeout,
        },
      ],
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

    const targetDir = await ensureCoreInstall(ctx, this.id);
    if (!targetDir) return; // clone failed — abort

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
      const r1 = H.runSpawn(
        'claude',
        ['plugin', 'marketplace', 'add', REPO],
        { env: pluginEnv },
        opts.dryRun
      );
      const r2 = H.runSpawn(
        'claude',
        ['plugin', 'install', 'airprompt@airprompt'],
        { env: pluginEnv },
        opts.dryRun
      );
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
          note(
            `  removed ${pruned} orphaned airprompt hook entr${pruned === 1 ? 'y' : 'ies'} from settings.json`
          );
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

    // 6b. Statusline badge — the plugin manifest cannot declare statusLine
    // (Claude Code limitation), so wire it directly in settings.json on every
    // install. Skipped only under --no-hooks, which opts out of settings.json edits.
    if (opts.withHooks !== false) {
      const r = await installStatusline(ctx, targetDir);
      if (r === 'ok') results.installed.push('claude-statusline');
      else if (r === 'skip')
        results.skipped.push(['claude-statusline', 'statusline already configured or preserved']);
      else results.failed.push(['claude-statusline', r]);
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
    // Scoped uninstall (--only claude) must not destroy the shared install that
    // other providers' hooks reference — full teardown only when unscoped.
    const isFullUninstall = !opts.only || opts.only.length === 0;
    say('airprompt uninstall');

    if (opts.dryRun) note('  (dry run — nothing will be removed)');

    // 1. Stop daemon — full uninstall only; a scoped --only uninstall must not
    // kill the shared daemon that other providers' sessions depend on.
    if (isFullUninstall) {
      const pidFile = process.env.AIRPROMPT_PID_FILE || '/tmp/airprompt-server.pid';
      if (fs.existsSync(pidFile)) {
        if (opts.dryRun) {
          note(`  would stop daemon (PID file: ${pidFile})`);
        } else {
          try {
            const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
            process.kill(pid, 'SIGTERM');
            note('  stopped daemon');
          } catch (_) {
            /* already dead */
          }
          try {
            fs.unlinkSync(pidFile);
          } catch (_) {}
        }
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
          const cmd =
            typeof settings.statusLine === 'string'
              ? settings.statusLine
              : settings.statusLine.command || '';
          if (cmd.includes('airprompt-statusline')) delete settings.statusLine;
        }
        SETTINGS.validateHookFields(settings);
        if (!opts.dryRun) SETTINGS.writeSettings(settingsPath, settings);
        ok(
          `  removed ${removed} airprompt hook entr${removed === 1 ? 'y' : 'ies'} from settings.json`
        );
      }
    }

    // 3. Delete hook files
    if (fs.existsSync(hooksDir)) {
      for (const f of HOOK_FILES) {
        const p = path.join(hooksDir, f);
        if (!fs.existsSync(p)) continue;
        if (!opts.dryRun) {
          try {
            fs.unlinkSync(p);
          } catch (_) {}
        }
        note(`  removed ${p}`);
      }
    }

    // 4. Remove ~/bin/ symlinks + provider wrappers
    {
      const homeBin = path.join(os.homedir(), 'bin');
      // Full uninstall removes the shared entrypoints + all provider wrappers;
      // scoped uninstall (--only claude) removes only the claude wrapper.
      const entries = isFullUninstall
        ? [
            'airprompt',
            'airprompt-launch',
            'airprompt-claude',
            'airprompt-codex',
            'airprompt-cursor',
            'airprompt-windsurf',
          ]
        : ['airprompt-claude'];

      for (const name of entries) {
        const linkPath = path.join(homeBin, name);
        if (!fs.existsSync(linkPath)) continue;
        if (!opts.dryRun) {
          try {
            fs.unlinkSync(linkPath);
          } catch (_) {}
        }
        note(`  removed ${linkPath}`);
      }
    }

    // 5. Remove command files (mirrors copyUserFiles)
    {
      const commandsDir = path.join(configDir, 'commands');
      for (const f of ['airprompt.md', 'airprompt.toml']) {
        const dest = path.join(commandsDir, f);
        if (fs.existsSync(dest)) {
          if (!opts.dryRun) {
            try {
              fs.unlinkSync(dest);
            } catch (_) {}
          }
          note(`  removed ${dest}`);
        }
      }
    }

    // 6. Claude Code plugin uninstall
    if (hasCmd('claude')) {
      const probe = H.captureSpawn('claude', ['plugin', 'list']);
      if (probe.status === 0 && /airprompt/i.test(probe.stdout || '')) {
        const r = H.runSpawn(
          'claude',
          ['plugin', 'uninstall', 'airprompt@airprompt'],
          null,
          opts.dryRun
        );
        if (H.spawnOk(r)) ok('  removed claude plugin');
      } else {
        note('  claude plugin not installed — skipping');
      }
    }

    // 7. Remove per-session directories (~/.airprompt/sessions/)
    const sessionsDir = sessionsRootDir();
    if (fs.existsSync(sessionsDir)) {
      if (!opts.dryRun) {
        try {
          for (const entry of fs.readdirSync(sessionsDir)) {
            // Only remove claude- prefixed session dirs — other providers live here too
            if (!entry.startsWith('claude-')) continue;
            const p = path.join(sessionsDir, entry);
            if (fs.statSync(p).isDirectory()) safeRmSync(p);
          }
          fs.rmdirSync(sessionsDir);
        } catch (_) {}
      }
      note(`  removed ${sessionsDir}`);
    }

    // 9. Remove install dir contents (~/.airprompt/) — keep state/ (user data).
    // Full uninstall only — a scoped --only uninstall must not nuke the shared
    // install that other providers' hook commands reference.
    if (isFullUninstall) {
      const targetDir = opts.targetDir || path.join(os.homedir(), '.airprompt');
      if (fs.existsSync(targetDir)) {
        if (!opts.dryRun) {
          try {
            for (const entry of fs.readdirSync(targetDir)) {
              if (entry === 'state') continue; // preserve user data
              safeRmSync(path.join(targetDir, entry));
            }
          } catch (_) {}
        }
        note(`  removed ${targetDir} (state/ kept)`);
      }
    }
  },

  // ── File manifests ─────────────────────────────────────────────────────

  /** @returns {{src: string, dest: string}[]} */
  getHookFiles() {
    const installDir = resolveInstallDir();
    const hooksDir = this.hooksDir();
    const srcDir = path.join(installDir, 'src', 'hooks');
    return [
      {
        src: path.join(srcDir, 'airprompt-activate.js'),
        dest: path.join(hooksDir, 'airprompt-activate.js'),
      },
      {
        src: path.join(srcDir, 'airprompt-deactivate.js'),
        dest: path.join(hooksDir, 'airprompt-deactivate.js'),
      },
      {
        src: path.join(srcDir, 'airprompt-statusline.sh'),
        dest: path.join(hooksDir, 'airprompt-statusline.sh'),
      },
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
      {
        src: path.join(installDir, 'commands', 'airprompt.md'),
        dest: path.join(commandsDir, 'airprompt.md'),
      },
      {
        src: path.join(installDir, 'commands', 'airprompt.toml'),
        dest: path.join(commandsDir, 'airprompt.toml'),
      },
    ];
  },

  /** @returns {{src: string, dest: string}[]} */
  getRuleFiles() {
    return []; // Claude doesn't use rule .md files
  },
};

module.exports = ClaudeProvider;
