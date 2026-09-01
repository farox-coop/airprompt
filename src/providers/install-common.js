// src/providers/install-common.js — Shared install preamble.
//
// Every provider's install() needs the same foundation: clone/verify the repo,
// npm install, jq check, TLS cert, and ~/bin symlinks + provider wrapper.
// Extracted here so the provider adapters don't duplicate it.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const H = require('../install-helpers');
const { stripJsonComments } = require('../../bin/lib/settings');
const { VERSION } = require('../version');

const REPO = 'farox-coop/airprompt';

/**
 * Shared install preamble: clone → npm install → jq → cert → symlinks.
 * Idempotent — each step short-circuits when already satisfied.
 *
 * @param {object} ctx - InstallContext + { say, note, warn, ok, opts, results }
 * @param {string} providerId - e.g. 'claude', 'codex' (used for the ~/bin wrapper + failure labels)
 * @returns {string|null} targetDir, or null when the repo clone failed (caller must abort)
 */
async function ensureCoreInstall(ctx, providerId) {
  const { say, note, warn, ok, opts, results } = ctx;
  const targetDir = opts.targetDir || path.join(os.homedir(), '.airprompt');
  // Make resolveInstallDir() (used by the per-provider file manifests) agree with
  // the actual clone target — otherwise a custom --target-dir copies templates
  // from the wrong location.
  process.env.AIRPROMPT_INSTALL_DIR = targetDir;

  // 1. Clone or verify repo at target dir
  if (!fs.existsSync(targetDir)) {
    say('  → cloning AirPrompt repo');
    if (!opts.dryRun) {
      const r = H.spawnXplat(
        'git',
        [
          'clone',
          '--depth',
          '1',
          '--branch',
          `v${VERSION}`,
          `https://github.com/${REPO}.git`,
          targetDir,
        ],
        { stdio: 'inherit' }
      );
      if (!H.spawnOk(r)) {
        warn(`  failed to clone repo (tag v${VERSION} not found? no network?)`);
        results.failed.push([providerId, 'git clone failed']);
        return null;
      }
    } else {
      note(`  would clone ${REPO} → ${targetDir}`);
    }
  } else {
    note(`  ${targetDir} exists — using existing install`);
  }

  // 2. Ensure node_modules exist. `express` alone is not a reliable sentinel —
  // an upgraded install still has express but lacks the newer deps (@xterm/*),
  // so also require them to force npm install on the upgrade path.
  const nmDir = path.join(targetDir, 'node_modules');
  if (
    !fs.existsSync(nmDir) ||
    !fs.existsSync(path.join(nmDir, 'express')) ||
    !fs.existsSync(path.join(nmDir, '@xterm', 'xterm')) ||
    !fs.existsSync(path.join(nmDir, '@xterm', 'addon-fit'))
  ) {
    say('  → installing npm dependencies');
    if (!opts.dryRun) {
      const r = H.spawnXplat('npm', ['install', '--no-audit', '--no-fund', '--omit=dev'], {
        cwd: targetDir,
        stdio: 'inherit',
      });
      if (!H.spawnOk(r)) {
        warn('  npm install failed — daemon will not start until deps are installed');
        results.failed.push([providerId, 'npm install failed']);
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

  // 3. Create symlinks + provider wrapper in ~/bin/
  {
    const homeBin = path.join(os.homedir(), 'bin');
    const launchTarget = path.join(targetDir, 'bin', 'airprompt-launch');
    const entries = [{ name: 'airprompt', target: path.join(targetDir, 'bin', 'airprompt') }];

    if (!opts.dryRun) {
      try {
        fs.mkdirSync(homeBin, { recursive: true });
        for (const { name, target } of entries) {
          const linkPath = path.join(homeBin, name);
          try {
            fs.unlinkSync(linkPath);
          } catch (_) {}
          fs.symlinkSync(target, linkPath);
          process.stdout.write(`  symlink: ${linkPath} → ${target}\n`);
        }

        const launchLink = path.join(homeBin, 'airprompt-launch');
        if (!fs.existsSync(launchLink)) {
          fs.symlinkSync(launchTarget, launchLink);
          process.stdout.write(`  symlink: ${launchLink} → ${launchTarget}\n`);
        }

        const wrapperPath = path.join(homeBin, `airprompt-${providerId}`);
        if (!fs.existsSync(wrapperPath)) {
          const wrapperContent = `#!/bin/bash\nexec airprompt-launch --provider ${providerId} "$@"\n`;
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
      note(`  would create ${path.join(homeBin, `airprompt-${providerId}`)} wrapper`);
    }
  }

  return targetDir;
}

/**
 * Build a shell-safe hook command that invokes a repo hook script with the
 * absolute node path (survives GUI apps' minimal PATH) and the provider id.
 * @param {string} targetDir
 * @param {string} providerId
 * @param {string} scriptName - e.g. 'airprompt-activate.js'
 * @returns {string}
 */
function hookCommand(targetDir, providerId, scriptName) {
  const node = H.absoluteNodePath();
  const script = path.join(targetDir, 'src', 'hooks', scriptName);
  return `"${node}" "${script}" ${providerId}`;
}

/**
 * Read a JSON file (JSONC-tolerant — // and /* *&#47; comments are stripped).
 * Returns `{}` when missing/empty, `null` when unparseable or not an object
 * (callers must NOT overwrite the file in that case).
 * @param {string} file
 * @returns {object|null}
 */
function readJson(file) {
  try {
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return {};
    let v;
    try {
      v = JSON.parse(raw);
    } catch (_) {
      v = JSON.parse(stripJsonComments(raw));
    }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    return v;
  } catch (_) {
    return null; // unparseable — caller must NOT overwrite
  }
}

/**
 * Atomic JSON write (temp + rename) with 2-space indent.
 * @param {string} file
 * @param {object} obj
 */
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/**
 * Copy `{src, dest}` file pairs from a manifest, honoring dry-run.
 * Non-fatal: a missing source is noted, not thrown.
 * @param {object} ctx
 * @param {{src: string, dest: string}[]} files
 */
function copyManifestFiles(ctx, files) {
  const { note, opts } = ctx;
  for (const { src, dest } of files || []) {
    if (opts.dryRun) {
      note(`  would install ${dest}`);
      continue;
    }
    try {
      if (!fs.existsSync(src)) {
        note(`  source not found: ${src} (skipping)`);
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      process.stdout.write(`  installed: ${dest}\n`);
    } catch (e) {
      note(`  could not install ${dest}: ${e.message} (non-fatal)`);
    }
  }
}

/**
 * True if any entry in a hook list already references AirPrompt (idempotency probe).
 * @param {object[]} entries
 * @returns {boolean}
 */
function hasAirPromptEntry(entries) {
  return Array.isArray(entries) && entries.some((e) => JSON.stringify(e).includes('airprompt'));
}

/**
 * Remove AirPrompt entries from a hooks.json file, returning the count removed.
 * Handles both array-form entries (`Event: [{hooks:[...]}]`, `Event: [{command}]`)
 * and object-form entries (`Event: {command}`). Only writes back when something
 * changed; never touches a corrupt/unparseable file.
 * @param {string} hooksPath
 * @returns {number}
 */
function removeAirPromptHooks(hooksPath) {
  const hooks = readJson(hooksPath);
  if (hooks === null) return 0; // corrupt — never touch the file
  let removed = 0;
  if (hooks && typeof hooks.hooks === 'object') {
    for (const ev of Object.keys(hooks.hooks)) {
      const entry = hooks.hooks[ev];
      if (Array.isArray(entry)) {
        const before = entry.length;
        hooks.hooks[ev] = entry.filter((e) => !JSON.stringify(e).includes('airprompt'));
        removed += before - hooks.hooks[ev].length;
        if (hooks.hooks[ev].length === 0) delete hooks.hooks[ev];
      } else if (entry && typeof entry === 'object') {
        if (JSON.stringify(entry).includes('airprompt')) {
          delete hooks.hooks[ev];
          removed++;
        }
      }
    }
    if (hooks.hooks && Object.keys(hooks.hooks).length === 0) delete hooks.hooks;
  }
  if (removed > 0) writeJson(hooksPath, hooks);
  return removed;
}

module.exports = {
  ensureCoreInstall,
  hookCommand,
  readJson,
  writeJson,
  copyManifestFiles,
  hasAirPromptEntry,
  removeAirPromptHooks,
  REPO,
};
