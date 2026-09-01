// src/providers/windsurf.js — WindsurfProvider (Codeium Windsurf / Cascade).
//
// Implements the Provider interface defined in ./provider.js.
//
// Windsurf uses:
//   - ~/.codeium/windsurf/ for config
//   - ~/.codeium/windsurf/hooks.json for hooks (event → command)
//   - No session-end hook — `on-open` starts, `post_cascade_response` re-registers
//   - `/` prefix for commands; rules in .windsurf/rules/*.md, skills in .windsurf/skills/

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
const WindsurfProvider = {
  id: 'windsurf',
  label: 'Windsurf',
  mech: 'direct file copy',
  detect: 'dir:$HOME/.codeium/windsurf||macapp:Windsurf.app||dir:$CODEIUM_EDITOR_APP_ROOT',
  profile: null,

  // ── Config resolution ──────────────────────────────────────────────────

  /** @returns {string} */
  configDir() {
    return path.join(os.homedir(), '.codeium', 'windsurf');
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
    sessionStart: 'on-open',
    stop: null, // Windsurf has no session-end hook — daemon stays until off/reboot
    statusLine: null,
  },

  commandPrefix: '/',

  // ── Detection (shared — see provider.js) ───────────────────────────────

  detectMatch,

  // ── Hook I/O (adapter pattern) ─────────────────────────────────────────

  /**
   * Windsurf's hook stdin format is the least documented; parse tolerantly and
   * fall back to defaults. Accepts any of session_id / trajectory_id / cwd.
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
      sessionId: raw.session_id || raw.trajectory_id || raw.conversation_id || '',
      cwd: raw.cwd || roots[0] || process.cwd(),
      tmuxSession: raw.tmux_session || null,
      providerId: 'windsurf',
      raw,
    };
  },

  /**
   * Windsurf hooks exit 0 for success; `{}` is a valid non-blocking no-op.
   * @param {import('./provider').HookResult} output
   * @returns {string}
   */
  formatHookOutput() {
    return '{}';
  },

  /**
   * Windsurf hook entry: `{ hooks: { event: { command } } }`.
   * @param {string} event
   * @param {string} scriptPath
   * @param {number} timeout
   * @returns {object}
   */
  buildHookEntry(event, scriptPath) {
    return { hooks: { [event]: { command: scriptPath } } };
  },

  // ── Install / Uninstall ────────────────────────────────────────────────

  /**
   * @param {object} ctx
   * @returns {Promise<void>}
   */
  async install(ctx) {
    const { say, note, warn, opts, results } = ctx;
    results.detected++;
    say('→ Windsurf detected');

    const targetDir = await ensureCoreInstall(ctx, 'windsurf');
    if (!targetDir) return; // clone failed — abort
    const hooksPath = this.hooksConfigPath();
    const activate = hookCommand(targetDir, 'windsurf', 'airprompt-activate.js');

    if (opts.dryRun) {
      note(`  would wire on-open + post_cascade_response into ${hooksPath}`);
    } else {
      const hooks = readJson(hooksPath);
      if (hooks === null) {
        warn(`  ${hooksPath} unparseable — not modifying (fix manually then re-run)`);
      } else {
        hooks.hooks = hooks.hooks || {};
        if (typeof hooks.hooks !== 'object' || Array.isArray(hooks.hooks)) {
          warn(`  ${hooksPath} has a malformed "hooks" key — resetting it`);
          hooks.hooks = {};
        }

        // Windsurf hook entries are object-form ({ command }). Never clobber an
        // existing hook — only write when the slot is empty or already ours.
        let changed = false;
        const isEmpty = (v) => v && typeof v === 'object' && Object.keys(v).length === 0;
        const wireOne = (ev) => {
          const existing = hooks.hooks[ev];
          if (existing && JSON.stringify(existing).includes('airprompt')) return; // already wired
          if (existing && !isEmpty(existing)) {
            note(`  existing ${ev} hook detected — airprompt ${ev} NOT added`);
            return;
          }
          hooks.hooks[ev] = { command: activate };
          changed = true;
        };
        wireOne('on-open');
        wireOne('post_cascade_response');

        if (changed) {
          writeJson(hooksPath, hooks);
          process.stdout.write(`  hooks wired in ${hooksPath}\n`);
        } else {
          note('  hooks already wired — nothing to do');
        }
      }
    }

    // Copy skill + rule files
    copyManifestFiles(ctx, this.getSkillFiles());
    copyManifestFiles(ctx, this.getRuleFiles());

    if (!opts.dryRun) results.installed.push('windsurf');
    process.stdout.write('\n');
  },

  /**
   * @param {object} ctx
   * @returns {Promise<void>}
   */
  async uninstall(ctx) {
    const { say, note, ok, opts } = ctx;
    say('airprompt uninstall (windsurf)');
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

    // 2. Remove skill + rule files
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
    removeFiles(this.getSkillFiles());
    removeFiles(this.getRuleFiles());

    // 3. Remove the ~/bin wrapper
    const wrapper = path.join(os.homedir(), 'bin', 'airprompt-windsurf');
    if (!opts.dryRun) {
      try {
        fs.unlinkSync(wrapper);
      } catch (_) {}
    } else {
      note(`  would remove ${wrapper}`);
    }

    // 4. Remove windsurf- prefixed session dirs
    const sessionsDir = sessionsRootDir();
    if (fs.existsSync(sessionsDir)) {
      if (!opts.dryRun) {
        try {
          for (const entry of fs.readdirSync(sessionsDir)) {
            if (!entry.startsWith('windsurf-')) continue;
            const p = path.join(sessionsDir, entry);
            if (fs.statSync(p).isDirectory()) safeRmSync(p);
          }
        } catch (_) {}
      }
      note(`  removed windsurf session dirs under ${sessionsDir}`);
    }
  },

  // ── File manifests ─────────────────────────────────────────────────────

  /** @returns {{src: string, dest: string}[]} */
  getHookFiles() {
    return []; // hooks.json references the repo hook scripts directly — nothing to copy
  },

  /** @returns {{src: string, dest: string}[]} */
  getSkillFiles() {
    const installDir = resolveInstallDir();
    return [
      {
        src: path.join(installDir, 'src', 'providers', 'templates', 'windsurf', 'SKILL.md'),
        dest: path.join(this.skillsDir(), 'airprompt', 'SKILL.md'),
      },
    ];
  },

  /** @returns {{src: string, dest: string}[]} */
  getCommandFiles() {
    return []; // Windsurf uses skills/@mention rather than slash-command files
  },

  /** @returns {{src: string, dest: string}[]} */
  getRuleFiles() {
    const installDir = resolveInstallDir();
    return [
      {
        src: path.join(installDir, 'src', 'providers', 'templates', 'windsurf', 'airprompt.md'),
        dest: path.join(this.rulesDir(), 'airprompt.md'),
      },
    ];
  },
};

module.exports = WindsurfProvider;
