// src/providers/codex.js — CodexProvider (OpenAI Codex CLI).
//
// Implements the Provider interface defined in ./provider.js.
//
// Codex uses:
//   - ~/.codex/ (legacy) or $CODEX_HOME or XDG ~/.config/codex for config
//   - ~/.codex/hooks.json + [features] hooks flag in ~/.codex/config.toml
//   - Hook events: SessionStart, Stop (stable since v0.124)
//   - snake_case JSON on stdin; Stop expects JSON-only output
//   - `$` prefix for skills — no custom slash commands

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

// ── Config dir resolution ──────────────────────────────────────────────────

function configDir() {
  if (process.env.CODEX_HOME) return process.env.CODEX_HOME;
  // Legacy ~/.codex takes precedence when it exists (matches Codex's own logic);
  // otherwise default to the platform config dir (XDG on Linux/macOS).
  const legacy = path.join(os.homedir(), '.codex');
  if (fs.existsSync(legacy)) return legacy;
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'codex');
  return path.join(os.homedir(), '.config', 'codex');
}

// ── config.toml feature-flag merge ─────────────────────────────────────────
// Hooks are default-on since v0.124; the flag only matters for older versions.
// Written defensively (both legacy and current names) and never fatal.

function ensureHooksFeatureFlag(tomlPath, note) {
  try {
    let content = '';
    if (fs.existsSync(tomlPath)) content = fs.readFileSync(tomlPath, 'utf8');
    if (/codex_hooks\s*=|\bhooks\s*=/.test(content)) return;

    let out;
    if (/^\[features\]\s*$/m.test(content)) {
      out = content.replace(/^\[features\]\s*$/m, '[features]\ncodex_hooks = true\nhooks = true');
    } else {
      out =
        content +
        (content && !content.endsWith('\n') ? '\n' : '') +
        '[features]\ncodex_hooks = true\nhooks = true\n';
    }
    fs.mkdirSync(path.dirname(tomlPath), { recursive: true });
    fs.writeFileSync(tomlPath, out);
    process.stdout.write(`  hooks feature enabled in ${tomlPath}\n`);
  } catch (e) {
    note(`  could not enable hooks feature flag: ${e.message} (non-fatal)`);
  }
}

// ── Provider definition ────────────────────────────────────────────────────

/** @type {import('./provider').Provider} */
const CodexProvider = {
  id: 'codex',
  label: 'Codex CLI',
  mech: 'direct file copy',
  detect: 'command:codex||dir:$HOME/.codex||dir:$CODEX_HOME||macapp:ChatGPT.app',
  profile: null,

  // ── Config resolution ──────────────────────────────────────────────────

  configDir,

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

  /** @returns {string|null} */
  rulesDir() {
    return null;
  },

  // ── Hook system ────────────────────────────────────────────────────────

  hookEvents: {
    sessionStart: 'SessionStart',
    stop: 'Stop',
    statusLine: null, // Codex has no persistent statusline (ephemeral Notification only)
  },

  commandPrefix: '$',

  // ── Detection (shared — see provider.js) ───────────────────────────────

  detectMatch,

  // ── Hook I/O (adapter pattern) ─────────────────────────────────────────

  /**
   * Codex passes hook context as snake_case JSON on stdin.
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
    return {
      sessionId: raw.session_id || '',
      cwd: raw.cwd || process.cwd(),
      tmuxSession: raw.tmux_session || null,
      providerId: 'codex',
      raw,
    };
  },

  /**
   * Codex Stop expects JSON-only output; `{}` is a no-op. Errors surface as a
   * system message. Never emit `decision: block` (that means "continue").
   * @param {import('./provider').HookResult} output
   * @returns {string}
   */
  formatHookOutput(output) {
    if (output && output.status === 'error') {
      return JSON.stringify({ systemMessage: output.message || 'airprompt error' });
    }
    return '{}';
  },

  /**
   * Codex hook entry: `{ hooks: { Event: [{ matcher, hooks: [{...}] }] } }`.
   * @param {string} event
   * @param {string} scriptPath
   * @param {number} timeout
   * @returns {object}
   */
  buildHookEntry(event, scriptPath, timeout) {
    const entry = { hooks: [{ type: 'command', command: scriptPath, timeout }] };
    if (event === 'SessionStart') entry.matcher = 'startup|resume|clear';
    return { hooks: { [event]: [entry] } };
  },

  // ── Install / Uninstall ────────────────────────────────────────────────

  /**
   * @param {object} ctx
   * @returns {Promise<void>}
   */
  async install(ctx) {
    const { say, note, warn, opts, results } = ctx;
    results.detected++;
    say('→ Codex CLI detected');

    const targetDir = await ensureCoreInstall(ctx, 'codex');
    if (!targetDir) return; // clone failed — abort
    const cd = this.configDir();

    // 1. Enable the hooks feature flag (defensive, non-fatal)
    const tomlPath = path.join(cd, 'config.toml');
    if (opts.dryRun) {
      note(`  would enable [features] hooks in ${tomlPath}`);
    } else {
      ensureHooksFeatureFlag(tomlPath, note);
    }

    // 2. Wire SessionStart + Stop into hooks.json
    const hooksPath = path.join(cd, 'hooks.json');
    const activate = hookCommand(targetDir, 'codex', 'airprompt-activate.js');
    const deactivate = hookCommand(targetDir, 'codex', 'airprompt-deactivate.js');
    if (opts.dryRun) {
      note(`  would wire SessionStart + Stop into ${hooksPath}`);
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

        wire('SessionStart', {
          matcher: 'startup|resume|clear',
          hooks: [{ type: 'command', command: activate, timeout: 30 }],
        });
        wire('Stop', { hooks: [{ type: 'command', command: deactivate, timeout: 30 }] });

        if (changed) {
          writeJson(hooksPath, hooks);
          process.stdout.write(`  hooks wired in ${hooksPath}\n`);
        } else {
          note('  hooks already wired — nothing to do');
        }
      }
    }

    // 3. Copy the $airprompt skill
    copyManifestFiles(ctx, this.getSkillFiles());

    if (!opts.dryRun) results.installed.push('codex');
    process.stdout.write('\n');
  },

  /**
   * @param {object} ctx
   * @returns {Promise<void>}
   */
  async uninstall(ctx) {
    const { say, note, ok, opts } = ctx;
    say('airprompt uninstall (codex)');
    if (opts.dryRun) note('  (dry run — nothing will be removed)');

    const cd = this.configDir();

    // 1. Remove hook entries from hooks.json
    const hooksPath = path.join(cd, 'hooks.json');
    if (!opts.dryRun) {
      const removed = removeAirPromptHooks(hooksPath);
      if (removed > 0)
        ok(
          `  removed ${removed} airprompt hook entr${removed === 1 ? 'y' : 'ies'} from hooks.json`
        );
    } else {
      note(`  would remove airprompt entries from ${hooksPath}`);
    }

    // 2. Remove the $airprompt skill (not under a safeRmSync guard root — unlink directly)
    const skillFile = path.join(this.skillsDir(), 'airprompt', 'SKILL.md');
    const skillDir = path.join(this.skillsDir(), 'airprompt');
    if (!opts.dryRun) {
      try {
        fs.unlinkSync(skillFile);
      } catch (_) {}
      try {
        fs.rmdirSync(skillDir);
      } catch (_) {}
    } else {
      note(`  would remove ${skillDir}`);
    }

    // 3. Remove the ~/bin wrapper
    const wrapper = path.join(os.homedir(), 'bin', 'airprompt-codex');
    if (!opts.dryRun) {
      try {
        fs.unlinkSync(wrapper);
      } catch (_) {}
    } else {
      note(`  would remove ${wrapper}`);
    }

    // 4. Remove codex- prefixed session dirs
    const sessionsDir = sessionsRootDir();
    if (fs.existsSync(sessionsDir)) {
      if (!opts.dryRun) {
        try {
          for (const entry of fs.readdirSync(sessionsDir)) {
            if (!entry.startsWith('codex-')) continue;
            const p = path.join(sessionsDir, entry);
            if (fs.statSync(p).isDirectory()) safeRmSync(p);
          }
        } catch (_) {}
      }
      note(`  removed codex session dirs under ${sessionsDir}`);
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
    const skillsDir = this.skillsDir();
    return [
      {
        src: path.join(installDir, 'src', 'providers', 'templates', 'codex', 'SKILL.md'),
        dest: path.join(skillsDir, 'airprompt', 'SKILL.md'),
      },
    ];
  },

  /** @returns {{src: string, dest: string}[]} */
  getCommandFiles() {
    return []; // Codex has no custom slash commands
  },

  /** @returns {{src: string, dest: string}[]} */
  getRuleFiles() {
    return [];
  },
};

module.exports = CodexProvider;
