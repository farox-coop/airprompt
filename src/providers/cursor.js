// src/providers/cursor.js — CursorProvider (Anysphere Cursor).
//
// Implements the Provider interface defined in ./provider.js.
//
// Cursor uses:
//   - ~/.cursor/ for config
//   - ~/.cursor/hooks.json (version 1) for hooks
//   - Hook events: sessionStart, sessionEnd (camelCase), plus per-turn `stop`
//   - camelCase JSON on stdin; top-level `cwd` is often empty — use workspace_roots[0]
//   - `/` prefix for commands; rules live in .cursor/rules/*.mdc

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { detectMatch, sessionsRootDir, resolveInstallDir } = require('./provider');
const {
  ensureCoreInstall,
  hookCommand,
  readJson,
  writeJson,
  copyManifestFiles,
  hasAirPromptEntry,
  removeAirPromptHooks,
} = require('./install-common');
const { safeRmSync } = require('../utils');

/** @type {import('./provider').Provider} */
const CursorProvider = {
  id: 'cursor',
  label: 'Cursor',
  mech: 'direct file copy',
  detect: 'dir:$HOME/.cursor||macapp:Cursor.app',
  profile: null,

  // ── Config resolution ──────────────────────────────────────────────────

  /** @returns {string} */
  configDir() {
    return path.join(os.homedir(), '.cursor');
  },

  /** @returns {string} */
  sessionsDir() {
    return sessionsRootDir();
  },

  /** @returns {string} */
  hooksDir() {
    return path.join(this.configDir(), 'hooks');
  },

  /** @returns {string} */
  hooksConfigPath() {
    return path.join(this.configDir(), 'hooks.json');
  },

  /** @returns {string} */
  skillsDir() {
    return path.join(this.configDir(), 'skills');
  },

  /** @returns {string} */
  commandsDir() {
    return path.join(this.configDir(), 'commands');
  },

  /** @returns {string} */
  rulesDir() {
    return path.join(this.configDir(), 'rules');
  },

  // ── Hook system ────────────────────────────────────────────────────────

  hookEvents: {
    sessionStart: 'sessionStart',
    stop: 'sessionEnd',
    statusLine: null, // Cursor has no persistent statusline
  },

  commandPrefix: '/',

  // ── Detection (shared — see provider.js) ───────────────────────────────

  detectMatch,

  // ── Hook I/O (adapter pattern) ─────────────────────────────────────────

  /**
   * Cursor passes camelCase JSON on stdin. Top-level `cwd` is often empty —
   * fall back to workspace_roots[0].
   * @param {string} input
   * @returns {import('./provider').HookContext}
   */
  parseHookStdin(input) {
    let raw = {};
    try {
      if (input && input.trim()) raw = JSON.parse(input);
    } catch (_) {
      /* non-JSON stdin → empty object */
    }
    const roots = Array.isArray(raw.workspace_roots) ? raw.workspace_roots : [];
    return {
      sessionId: raw.session_id || raw.conversation_id || '',
      cwd: raw.cwd || roots[0] || process.cwd(),
      tmuxSession: raw.tmux_session || null,
      providerId: 'cursor',
      raw,
    };
  },

  /**
   * Cursor session hooks are fire-and-forget; `{}` is a valid non-blocking no-op.
   * @param {import('./provider').HookResult} output
   * @returns {string}
   */
  formatHookOutput() {
    return '{}';
  },

  /**
   * Cursor hook entry: `{ version: 1, hooks: { event: [{ command, timeout }] } }`.
   * @param {string} event
   * @param {string} scriptPath
   * @param {number} timeout
   * @returns {object}
   */
  buildHookEntry(event, scriptPath, timeout) {
    return { version: 1, hooks: { [event]: [{ command: scriptPath, timeout }] } };
  },

  // ── Install / Uninstall ────────────────────────────────────────────────

  /**
   * @param {object} ctx
   * @returns {Promise<void>}
   */
  async install(ctx) {
    const { say, note, warn, opts, results } = ctx;
    results.detected++;
    say('→ Cursor detected');

    const targetDir = await ensureCoreInstall(ctx, 'cursor');
    if (!targetDir) return; // clone failed — abort
    const hooksPath = this.hooksConfigPath();
    const activate = hookCommand(targetDir, 'cursor', 'airprompt-activate.js');
    const deactivate = hookCommand(targetDir, 'cursor', 'airprompt-deactivate.js');

    if (opts.dryRun) {
      note(`  would wire sessionStart + sessionEnd into ${hooksPath}`);
    } else {
      const hooks = readJson(hooksPath);
      if (hooks === null) {
        warn(`  ${hooksPath} unparseable — not modifying (fix manually then re-run)`);
      } else {
        hooks.version = hooks.version || 1;
        hooks.hooks = hooks.hooks || {};
        if (typeof hooks.hooks !== 'object' || Array.isArray(hooks.hooks)) {
          warn(`  ${hooksPath} has a malformed "hooks" key — resetting it`);
          hooks.hooks = {};
        }

        let changed = false;
        const wire = (ev, entry) => {
          if (hooks.hooks[ev] === undefined) hooks.hooks[ev] = [];
          if (!Array.isArray(hooks.hooks[ev])) {
            note(`  existing ${ev} hook is not array-form — airprompt NOT added`);
            return;
          }
          if (!hasAirPromptEntry(hooks.hooks[ev])) {
            hooks.hooks[ev].push(entry);
            changed = true;
          }
        };

        wire('sessionStart', { command: activate, timeout: 30 });
        wire('sessionEnd', { command: deactivate, timeout: 30 });

        if (changed) {
          writeJson(hooksPath, hooks);
          process.stdout.write(`  hooks wired in ${hooksPath}\n`);
        } else {
          note('  hooks already wired — nothing to do');
        }
      }
    }

    // Copy command + rule files
    copyManifestFiles(ctx, this.getCommandFiles());
    copyManifestFiles(ctx, this.getRuleFiles());

    if (!opts.dryRun) results.installed.push('cursor');
    process.stdout.write('\n');
  },

  /**
   * @param {object} ctx
   * @returns {Promise<void>}
   */
  async uninstall(ctx) {
    const { say, note, ok, opts } = ctx;
    say('airprompt uninstall (cursor)');
    if (opts.dryRun) note('  (dry run — nothing will be removed)');

    // 1. Remove hook entries from hooks.json
    const hooksPath = this.hooksConfigPath();
    if (!opts.dryRun) {
      const removed = removeAirPromptHooks(hooksPath);
      if (removed > 0)
        ok(
          `  removed ${removed} airprompt hook entr${removed === 1 ? 'y' : 'ies'} from hooks.json`
        );
    } else {
      note(`  would remove airprompt entries from ${hooksPath}`);
    }

    // 2. Remove command + rule files
    const removeFiles = (files) => {
      for (const { dest } of files || []) {
        if (opts.dryRun) {
          note(`  would remove ${dest}`);
          continue;
        }
        try {
          fs.unlinkSync(dest);
        } catch (_) {}
      }
    };
    removeFiles(this.getCommandFiles());
    removeFiles(this.getRuleFiles());

    // 3. Remove the ~/bin wrapper
    const wrapper = path.join(os.homedir(), 'bin', 'airprompt-cursor');
    if (!opts.dryRun) {
      try {
        fs.unlinkSync(wrapper);
      } catch (_) {}
    } else {
      note(`  would remove ${wrapper}`);
    }

    // 4. Remove cursor- prefixed session dirs
    const sessionsDir = sessionsRootDir();
    if (fs.existsSync(sessionsDir)) {
      if (!opts.dryRun) {
        try {
          for (const entry of fs.readdirSync(sessionsDir)) {
            if (!entry.startsWith('cursor-')) continue;
            const p = path.join(sessionsDir, entry);
            if (fs.statSync(p).isDirectory()) safeRmSync(p);
          }
        } catch (_) {}
      }
      note(`  removed cursor session dirs under ${sessionsDir}`);
    }
  },

  // ── File manifests ─────────────────────────────────────────────────────

  /** @returns {{src: string, dest: string}[]} */
  getHookFiles() {
    return []; // hooks.json references the repo hook scripts directly — nothing to copy
  },

  /** @returns {{src: string, dest: string}[]} */
  getSkillFiles() {
    return []; // rules + commands suffice for v1
  },

  /** @returns {{src: string, dest: string}[]} */
  getCommandFiles() {
    const installDir = resolveInstallDir();
    return [
      {
        src: path.join(installDir, 'src', 'providers', 'templates', 'cursor', 'airprompt.md'),
        dest: path.join(this.commandsDir(), 'airprompt.md'),
      },
    ];
  },

  /** @returns {{src: string, dest: string}[]} */
  getRuleFiles() {
    const installDir = resolveInstallDir();
    return [
      {
        src: path.join(installDir, 'src', 'providers', 'templates', 'cursor', 'airprompt.mdc'),
        dest: path.join(this.rulesDir(), 'airprompt.mdc'),
      },
    ];
  },
};

module.exports = CursorProvider;
