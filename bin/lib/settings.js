// airprompt — JSONC-tolerant settings.json read/write + defensive hook validation.
//
// Adapted from caveman's bin/lib/settings.js. Reused by bin/install.js.
//
// Public API:
//   readSettings(path)             → object, {}, or null on hard parse failure
//   writeSettings(path, obj)       → atomic write with newline
//   stripJsonComments(src)         → string with // and /* */ stripped (string-aware)
//   validateHookFields(settings)   → mutates: drops malformed hook entries
//   hasAirPromptHook(settings, ev) → idempotency probe
//   addCommandHook(settings, ev, opts) → no-op if substring marker already present
//   removeAirPromptHooks(settings) → uninstall helper
//
// Pure stdlib, CommonJS, Node ≥14.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ── stripJsonComments ──────────────────────────────────────────────────────
// Hand-rolled state machine. Tracks string state + backslash escape so a
// comment-looking sequence inside a quoted string is left alone. Removes
// trailing commas in a final pass — JSONC tolerates those, JSON.parse does not.
function stripJsonComments(src) {
  if (typeof src !== 'string') return src;
  let out = '';
  let i = 0;
  const n = src.length;
  let inString = false;
  let stringChar = '';
  let inLine = false;
  let inBlock = false;
  while (i < n) {
    const c = src[i];
    const next = i + 1 < n ? src[i + 1] : '';
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      i++; continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; i += 2; continue; }
      i++; continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') { if (i + 1 < n) { out += src[i + 1]; i += 2; continue; } }
      if (c === stringChar) { inString = false; }
      i++; continue;
    }
    if (c === '"' || c === "'") { inString = true; stringChar = c; out += c; i++; continue; }
    if (c === '/' && next === '/') { inLine = true; i += 2; continue; }
    if (c === '/' && next === '*') { inBlock = true; i += 2; continue; }
    out += c; i++;
  }
  return stripTrailingCommas(out);
}

// ── stripTrailingCommas ────────────────────────────────────────────────────
function stripTrailingCommas(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let inString = false;
  let stringChar = '';
  while (i < n) {
    const c = src[i];
    if (inString) {
      out += c;
      if (c === '\\') { if (i + 1 < n) { out += src[i + 1]; i += 2; continue; } }
      if (c === stringChar) inString = false;
      i++; continue;
    }
    if (c === '"' || c === "'") { inString = true; stringChar = c; out += c; i++; continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < n && /\s/.test(src[j])) j++;
      if (j < n && (src[j] === '}' || src[j] === ']')) { i++; continue; }
    }
    out += c; i++;
  }
  return out;
}

// ── readSettings ───────────────────────────────────────────────────────────
function readSettings(p) {
  if (!fs.existsSync(p)) return {};
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); }
  catch (e) {
    process.stderr.write(`airprompt: cannot read ${p}: ${e.message}\n`);
    return null;
  }
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch (_) { /* fall through to JSONC */ }
  try { return JSON.parse(stripJsonComments(raw)); }
  catch (e) {
    process.stderr.write(`airprompt: warning — ${p} is not valid JSON or JSONC: ${e.message}\n`);
    return null;
  }
}

// ── writeSettings ──────────────────────────────────────────────────────────
// Atomic write: temp file + rename. mode 0600 (settings often contains tokens).
function writeSettings(p, obj) {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(p)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, p);
}

// ── validateHookFields ────────────────────────────────────────────────────
function validateHookFields(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  if (!settings.hooks || typeof settings.hooks !== 'object') return settings;
  for (const ev of Object.keys(settings.hooks)) {
    const arr = settings.hooks[ev];
    if (!Array.isArray(arr)) { delete settings.hooks[ev]; continue; }
    settings.hooks[ev] = arr.filter(entry => {
      if (!entry || typeof entry !== 'object') return false;
      if (!Array.isArray(entry.hooks)) return false;
      entry.hooks = entry.hooks.filter(h => {
        if (!h || typeof h !== 'object') return false;
        if (h.type === 'command') return typeof h.command === 'string' && h.command.length > 0;
        if (h.type === 'agent')   return typeof h.prompt === 'string' && h.prompt.length > 0;
        return false;
      });
      return entry.hooks.length > 0;
    });
    if (settings.hooks[ev].length === 0) delete settings.hooks[ev];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return settings;
}

// ── Idempotency probe ──────────────────────────────────────────────────────
function hasAirPromptHook(settings, event, marker = 'airprompt') {
  const arr = settings && settings.hooks && settings.hooks[event];
  if (!Array.isArray(arr)) return false;
  return arr.some(e =>
    e && Array.isArray(e.hooks) &&
    e.hooks.some(h => h && typeof h.command === 'string' && h.command.includes(marker))
  );
}

// ── addCommandHook ────────────────────────────────────────────────────────
function addCommandHook(settings, event, opts) {
  if (!settings.hooks) settings.hooks = {};
  if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
  const marker = opts.marker || opts.command;
  if (hasAirPromptHook(settings, event, marker)) return false;
  const hook = { type: 'command', command: opts.command };
  if (typeof opts.timeout === 'number') hook.timeout = opts.timeout;
  if (typeof opts.statusMessage === 'string') hook.statusMessage = opts.statusMessage;
  settings.hooks[event].push({ hooks: [hook] });
  return true;
}

// ── Managed hook scripts ──────────────────────────────────────────────────
const MANAGED_HOOK_BASENAMES = new Set([
  'airprompt-activate.js',
  'airprompt-deactivate.js',
  'airprompt-statusline.sh',
]);

function tokenizeCommand(command) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(command)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function referencesManagedScript(command) {
  try {
    for (const tok of tokenizeCommand(command)) {
      if (tok && typeof tok === 'string' && MANAGED_HOOK_BASENAMES.has(path.basename(tok))) return true;
    }
  } catch (_) { /* malformed command — treat as not ours */ }
  return false;
}

// ── removeAirPromptHooks ──────────────────────────────────────────────────
function removeAirPromptHooks(settings) {
  if (!settings || !settings.hooks) return 0;
  validateHookFields(settings);
  if (!settings.hooks) return 0;
  let removed = 0;
  for (const ev of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[ev])) { delete settings.hooks[ev]; continue; }
    const before = settings.hooks[ev].length;
    settings.hooks[ev] = settings.hooks[ev].filter(entry => {
      if (!entry || !Array.isArray(entry.hooks)) return true;
      return !entry.hooks.some(h => h && typeof h.command === 'string' && referencesManagedScript(h.command));
    });
    removed += before - settings.hooks[ev].length;
    if (settings.hooks[ev].length === 0) delete settings.hooks[ev];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return removed;
}

// ── rewriteLegacyManagedHookCommands ──────────────────────────────────────
function rewriteLegacyManagedHookCommands(settings, absoluteNode) {
  if (!settings || !settings.hooks || !absoluteNode) return 0;
  let rewritten = 0;
  const reBare = /^node\s+("([^"]+)"|'([^']+)'|(\S+))\s*$/;
  for (const ev of Object.keys(settings.hooks)) {
    for (const entry of settings.hooks[ev]) {
      if (!entry || !Array.isArray(entry.hooks)) continue;
      for (const h of entry.hooks) {
        if (!h || typeof h.command !== 'string') continue;
        const m = reBare.exec(h.command);
        if (!m) continue;
        const scriptPath = m[2] || m[3] || m[4];
        const basename = path.basename(scriptPath);
        if (!MANAGED_HOOK_BASENAMES.has(basename)) continue;
        h.command = `"${absoluteNode}" "${scriptPath}"`;
        rewritten++;
      }
    }
  }
  return rewritten;
}

// ── pruneOrphanedManagedHooks ─────────────────────────────────────────────
function pruneOrphanedManagedHooks(settings, configDir) {
  if (!settings || typeof settings !== 'object') return 0;
  const baseDir = configDir || claudeConfigDir();
  let removed = 0;

  const targetMissing = (command) => {
    try {
      for (const tok of tokenizeCommand(command)) {
        if (!tok || typeof tok !== 'string') continue;
        if (!MANAGED_HOOK_BASENAMES.has(path.basename(tok))) continue;
        const scriptPath = path.isAbsolute(tok) ? tok : path.join(baseDir, tok);
        return !fs.existsSync(scriptPath);
      }
    } catch (_) { /* silent-fail */ }
    return false;
  };

  if (settings.hooks && typeof settings.hooks === 'object') {
    validateHookFields(settings);
  }
  if (settings.hooks && typeof settings.hooks === 'object') {
    for (const ev of Object.keys(settings.hooks)) {
      if (!Array.isArray(settings.hooks[ev])) { delete settings.hooks[ev]; continue; }
      const before = settings.hooks[ev].length;
      settings.hooks[ev] = settings.hooks[ev].filter(entry => {
        if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) return true;
        return !entry.hooks.some(h => h && typeof h.command === 'string' && targetMissing(h.command));
      });
      removed += before - settings.hooks[ev].length;
      if (settings.hooks[ev].length === 0) delete settings.hooks[ev];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }

  if (settings.statusLine && typeof settings.statusLine.command === 'string'
      && targetMissing(settings.statusLine.command)) {
    delete settings.statusLine;
    removed++;
  }

  return removed;
}

// ── claudeConfigDir ───────────────────────────────────────────────────────
function claudeConfigDir() {
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  return path.join(os.homedir(), '.claude');
}

module.exports = {
  stripJsonComments,
  readSettings,
  writeSettings,
  validateHookFields,
  hasAirPromptHook,
  addCommandHook,
  removeAirPromptHooks,
  rewriteLegacyManagedHookCommands,
  pruneOrphanedManagedHooks,
  claudeConfigDir,
  tokenizeCommand,
  MANAGED_HOOK_BASENAMES,
};
