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
const { spawnSync } = require('child_process');

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
 * Sanitize a tmux session name for use as a directory component. The raw name
 * can contain ':' / '/' (tmux window syntax, paths), which would escape the
 * marker root if used verbatim. Marker dirs are keyed on the tmux name because
 * the shell scripts only ever know the tmux name — but see uploadsSessionDir(),
 * which is keyed on the already-validated sessionId and needs none of this.
 * @param {string} sessionName - tmux session name (unsanitized)
 * @returns {string}
 */
function sanitizeSessionName(sessionName) {
  const raw = String(sessionName || '');
  return raw.replace(/[^a-zA-Z0-9_.-]/g, '') || (raw ? 'unknown' : '');
}

/**
 * Per-session marker directory.
 * @param {string} providerId - e.g. 'claude', 'codex'
 * @param {string} sessionName - tmux session name (unsanitized)
 * @returns {string} ~/.airprompt/sessions/{providerId}-{sanitizedSessionName}/
 */
function sessionDir(providerId, sessionName) {
  return path.join(sessionsRootDir(), `${providerId}-${sanitizeSessionName(sessionName)}`);
}

/**
 * Root for files uploaded from the web UI. Separate from sessions/ so uploads
 * never mix with the marker files (mirror/active) that sessionToJSON and the
 * activate/deactivate hooks read.
 * @returns {string} ~/.airprompt/uploads/
 */
function uploadsRootDir() {
  if (process.env.AIRPROMPT_UPLOADS_DIR) return process.env.AIRPROMPT_UPLOADS_DIR;
  return path.join(os.homedir(), '.airprompt', 'uploads');
}

/**
 * Per-session uploads directory, keyed on the sessionId.
 *
 * The sessionId is already constrained to [A-Za-z0-9_-]{1,64} at registration
 * (server.js) and on disk recovery, so it is a safe path component as-is —
 * sanitizing it would only invent collisions between distinct sessions. The
 * provider prefix stays for readable `ls` output and to keep the dir named like
 * its marker counterpart.
 * @param {string} providerId - e.g. 'claude', 'codex'
 * @param {string} sessionId - daemon session id (validated, not a tmux name)
 * @returns {string} ~/.airprompt/uploads/{providerId}-{sessionId}/
 */
function uploadsSessionDir(providerId, sessionId) {
  return path.join(uploadsRootDir(), `${providerId}-${sessionId}`);
}

// ── Shared detection ──────────────────────────────────────────────────────

/**
 * True if `cmd` is on PATH.
 * @param {string} cmd
 * @returns {boolean}
 */
function hasCmd(cmd) {
  try {
    const r = spawnSync('sh', ['-c', `command -v '${String(cmd).replace(/'/g, "'\\''")}'`], {
      stdio: 'ignore',
    });
    return r.status === 0;
  } catch (_) {
    return false;
  }
}

/**
 * Expand `$VAR` (from process.env) and a leading `~` in a probe value.
 * Unset env vars are left literal (they will not resolve to an existing path).
 * @param {string} val
 * @returns {string}
 */
function expandProbe(val) {
  let out = String(val).replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, name) =>
    process.env[name] != null ? process.env[name] : m
  );
  if (out.startsWith('~')) out = os.homedir() + out.slice(1);
  return out;
}

/**
 * True if a macOS app bundle exists at `/Applications/<name>` or `~/Applications/<name>`.
 * @param {string} name
 * @returns {boolean}
 */
function macAppExists(name) {
  if (!name) return false;
  const candidates = [
    path.join('/Applications', name),
    path.join(os.homedir(), 'Applications', name),
  ];
  return candidates.some((p) => fs.existsSync(p));
}

/**
 * True if a VS Code extension matching `<id>-*` is installed in `~/.vscode/extensions/`.
 * @param {string} id - e.g. `openai.codex`
 * @returns {boolean}
 */
function vscodeExtExists(id) {
  if (!id) return false;
  const extDir = path.join(os.homedir(), '.vscode', 'extensions');
  try {
    if (!fs.existsSync(extDir)) return false;
    return fs.readdirSync(extDir).some((entry) => entry === id || entry.startsWith(id + '-'));
  } catch (_) {
    return false;
  }
}

/**
 * Shared provider detection. Evaluates a `||`-separated list of probes:
 *   command:<binary>   dir:<path>   macapp:<App.app>   vscode-ext:<publisher.id>
 * `$VAR` and `~` are expanded before checking. Returns true on the first match.
 * @param {string} spec
 * @returns {boolean}
 */
function detectMatch(spec) {
  if (!spec) return false;
  for (const clause of String(spec).split('||')) {
    const c = clause.trim();
    if (!c) continue;
    const colon = c.indexOf(':');
    const kind = colon === -1 ? c : c.slice(0, colon);
    const val = colon === -1 ? '' : expandProbe(c.slice(colon + 1).trim());
    if (kind === 'command' && hasCmd(val)) return true;
    if (kind === 'dir' && fs.existsSync(val)) return true;
    if (kind === 'macapp' && macAppExists(val)) return true;
    if (kind === 'vscode-ext' && vscodeExtExists(val)) return true;
  }
  return false;
}

module.exports = {
  resolveInstallDir,
  sessionsRootDir,
  stateDir,
  sessionDir,
  sanitizeSessionName,
  uploadsRootDir,
  uploadsSessionDir,
  hasCmd,
  detectMatch,
};
