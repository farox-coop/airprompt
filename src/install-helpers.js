// src/install-helpers.js — Shared installer utilities.
//
// Used by both bin/install.js (orchestrator) and per-provider install()
// implementations. Pure stdlib, CommonJS, Node ≥14.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const child_process = require('child_process');

const IS_WIN = process.platform === 'win32';

// ── Detection ─────────────────────────────────────────────────────────────

function hasCmd(cmd) {
  try {
    if (IS_WIN) {
      const r = child_process.spawnSync('where', [cmd], { stdio: 'ignore' });
      return r.status === 0;
    }
    const r = child_process.spawnSync(
      'sh',
      ['-c', `command -v '${String(cmd).replace(/'/g, "'\\''")}'`],
      { stdio: 'ignore' }
    );
    return r.status === 0;
  } catch (_) {
    return false;
  }
}

// ── Path helpers ──────────────────────────────────────────────────────────

function shellEscape(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function expandHome(p) {
  return p.replace(/^\$HOME/, os.homedir()).replace(/^~/, os.homedir());
}

// ── Spawn helpers ─────────────────────────────────────────────────────────

function spawnXplat(cmd, args, opts) {
  if (IS_WIN) {
    const quoted = args
      .map((a) => {
        if (a === '' || /[\s"]/.test(a)) return '"' + String(a).replace(/"/g, '\\"') + '"';
        return a;
      })
      .join(' ');
    return child_process.spawnSync(
      `${cmd} ${quoted}`,
      [],
      Object.assign({ shell: true }, opts || {})
    );
  }
  return child_process.spawnSync(cmd, args, opts || {});
}

function runSpawn(cmd, args, opts, dry) {
  if (dry) {
    process.stdout.write(`  would run: ${cmd} ${args.join(' ')}\n`);
    return { status: 0 };
  }
  process.stdout.write(`  $ ${cmd} ${args.join(' ')}\n`);
  return spawnXplat(cmd, args, Object.assign({ stdio: 'inherit' }, opts || {}));
}

function captureSpawn(cmd, args) {
  try {
    return spawnXplat(cmd, args, { encoding: 'utf8' });
  } catch (_) {
    return { status: 1, stdout: '', stderr: '' };
  }
}

function spawnOk(r) {
  return !!r && !r.error && r.status === 0;
}

function absoluteNodePath() {
  return process.execPath;
}

// ── File helpers ──────────────────────────────────────────────────────────

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
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch (_) {}
  return Object.assign({}, process.env, { TMPDIR: tmpDir, TEMP: tmpDir, TMP: tmpDir });
}

// ── TLS cert generation ───────────────────────────────────────────────────

function generateCert(targetDir, dryRun, say, note, warn, ok) {
  const certScript = path.join(targetDir, 'bin', 'generate-cert.sh');
  if (!fs.existsSync(certScript)) {
    warn('  cert script not found — HTTPS will not be enforced');
    return false;
  }
  const stateDir =
    process.env.AIRPROMPT_STATE_DIR || path.join(os.homedir(), '.airprompt', 'state');
  const certFile = path.join(stateDir, 'airprompt-cert.pem');
  const keyFile = path.join(stateDir, 'airprompt-key.pem');
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    note('  TLS certificate already present');
    return true;
  }
  say('  → generating TLS certificate (required for HTTPS)');
  if (!dryRun) {
    const r = spawnXplat('bash', [certScript], {
      stdio: 'inherit',
      env: { ...process.env, AIRPROMPT_STATE_DIR: stateDir },
    });
    if (!spawnOk(r)) {
      warn('  cert generation failed — voice dictation needs HTTPS. Run: make cert');
      return false;
    }
    ok('  TLS certificate generated');
  } else {
    note('  would generate TLS certificate');
  }
  return true;
}

// ── jq dependency check ───────────────────────────────────────────────────

// Cross-platform "how to install" hint (brew on macOS, apt on Linux).
// `platform` is injectable so the branches are unit-testable.
function pkgInstallHint(pkgs, platform = process.platform) {
  const list = pkgs.join(' ');
  if (platform === 'darwin') return `brew install ${list}`;
  if (platform === 'win32') return `(Windows) install ${list} manually — no apt/brew`;
  return `sudo apt install ${list}`;
}

function checkJq(note, warn, ok, dryRun, nonInteractive) {
  if (hasCmd('jq')) {
    note('  jq: found');
    return true;
  }
  warn('  jq is required but not installed.');
  if (nonInteractive) {
    warn('  (non-interactive mode — skipping jq install prompt)');
    warn('  notifications may not work. Install with: ' + pkgInstallHint(['jq']));
    return false;
  }
  warn('  Please run this command in another terminal:');
  warn('    ' + pkgInstallHint(['jq']));
  warn('');
  if (dryRun) return false;
  process.stdout.write('  Press Enter after installing jq to continue...');
  child_process.spawnSync('bash', ['-c', 'read -r _'], { stdio: 'inherit' });
  if (hasCmd('jq')) {
    ok('  jq: ready');
    return true;
  }
  warn('  jq still not found — notifications may not work.');
  return false;
}

module.exports = {
  hasCmd,
  shellEscape,
  expandHome,
  spawnXplat,
  runSpawn,
  captureSpawn,
  spawnOk,
  absoluteNodePath,
  copyDirRecursive,
  sameFilesystemTmpEnv,
  generateCert,
  checkJq,
  pkgInstallHint,
};
