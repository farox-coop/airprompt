// src/providers/provider.js — Provider adapter interface + shared types.
//
// Each IDE/CLI implements this contract. Base code never references IDE names
// directly — it calls provider.method().
//
// Pure JSDoc types + shared utilities. No runtime interface enforcement.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Shared types (JSDoc) ───────────────────────────────────────────────────

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   mech: string,
 *   detect: string,
 *   profile: string|null,
 *
 *   configDir(): string,
 *   sessionsDir(): string,
 *   hooksDir(): string,
 *   hooksConfigPath(): string,
 *   skillsDir(): string,
 *   commandsDir(): string,
 *   rulesDir(): string | null,
 *
 *   hookEvents: { sessionStart: string|null, stop: string|null, statusLine: string|null },
 *   commandPrefix: string,
 *
 *   detectMatch(spec: string): boolean,
 *
 *   parseHookStdin(input: string): HookContext,
 *   formatHookOutput(output: HookResult): string,
 *
 *   buildHookEntry(event: string, scriptPath: string, timeout: number): object,
 *   buildStatusLineEntry?(scriptPath: string): object | null,
 *
 *   install(ctx: InstallContext): Promise<void>,
 *   uninstall(ctx: InstallContext): Promise<void>,
 *
 *   getHookFiles(): {src: string, dest: string}[],
 *   getSkillFiles(): {src: string, dest: string}[],
 *   getCommandFiles(): {src: string, dest: string}[],
 *   getRuleFiles(): {src: string, dest: string}[],
 * }} Provider
 */

/**
 * @typedef {{
 *   sessionId: string,
 *   cwd: string,
 *   tmuxSession: string | null,
 *   providerId: string,
 *   raw: object,
 * }} HookContext
 */

/**
 * @typedef {{
 *   status: 'ok' | 'error',
 *   message: string,
 *   url: string | null,
 *   sessionId: string | null,
 * }} HookResult
 */

/**
 * @typedef {{
 *   dryRun: boolean,
 *   force: boolean,
 *   targetDir: string,
 *   port: number,
 *   configDir: string | null,
 *   provider: Provider,
 * }} InstallContext
 */

// ── Shared path utilities ──────────────────────────────────────────────────

/**
 * Resolve install dir from AIRPROMPT_INSTALL_DIR env var or fallback to ~/.airprompt.
 * @returns {string}
 */
function resolveInstallDir() {
  // AIRPROMPT_INSTALL_DIR → CLAUDE_PLUGIN_ROOT (Claude plugin path) → ~/.airprompt → dev checkout
  if (process.env.AIRPROMPT_INSTALL_DIR) return process.env.AIRPROMPT_INSTALL_DIR;
  if (process.env.CLAUDE_PLUGIN_ROOT) return process.env.CLAUDE_PLUGIN_ROOT;
  const airpromptDir = path.join(os.homedir(), '.airprompt');
  if (fs.existsSync(path.join(airpromptDir, 'server.js'))) return airpromptDir;
  return path.join(os.homedir(), 'projects', 'airprompt');
}

/**
 * Root directory for all per-session marker files.
 * @returns {string} ~/.airprompt/sessions/
 */
function sessionsRootDir() {
  if (process.env.AIRPROMPT_SESSIONS_DIR) return process.env.AIRPROMPT_SESSIONS_DIR;
  return path.join(os.homedir(), '.airprompt', 'sessions');
}

/**
 * State directory for daemon data (certs, daemon.json, project-names.json).
 * Separate from install dir so reinstall doesn't destroy user data.
 * @returns {string} ~/.airprompt/state/
 */
function stateDir() {
  return process.env.AIRPROMPT_STATE_DIR || path.join(os.homedir(), '.airprompt', 'state');
}

/**
 * Per-session marker directory.
 * @param {string} providerId - e.g. 'claude', 'codex'
 * @param {string} sessionName - tmux session name (unsanitized)
 * @returns {string} ~/.airprompt/sessions/{providerId}-{sanitizedSessionName}/
 */
function sessionDir(providerId, sessionName) {
  const safe = String(sessionName || '').replace(/[^a-zA-Z0-9_.-]/g, '');
  return path.join(sessionsRootDir(), `${providerId}-${safe}`);
}

module.exports = {
  resolveInstallDir,
  sessionsRootDir,
  stateDir,
  sessionDir,
};
