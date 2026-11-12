// node-pty 1.1.x publishes macOS prebuilds with spawn-helper mode 0644
// (microsoft/node-pty#850), so pty.spawn() fails with posix_spawnp and the web
// terminal renders blank. npm does not restore the bit, and both the installer
// ("dependencies already installed") and `airprompt update` skip npm on an
// existing tree, so this runs from postinstall AND daemon startup.
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_NODE_PTY = path.join(__dirname, '..', 'node_modules', 'node-pty');

/**
 * Restore the executable bit on every node-pty spawn-helper found.
 * Best effort: never throws, so a read-only install cannot fail npm install.
 * @param {{nodePtyDir?: string, stderr?: NodeJS.WritableStream}} [opts]
 * @returns {number} number of helpers fixed
 */
function fixNodePtyPerms({ nodePtyDir = DEFAULT_NODE_PTY, stderr = process.stderr } = {}) {
  const dirs = [path.join(nodePtyDir, 'build', 'Release'), path.join(nodePtyDir, 'build', 'Debug')];
  const prebuilds = path.join(nodePtyDir, 'prebuilds');
  try {
    for (const entry of fs.readdirSync(prebuilds)) dirs.push(path.join(prebuilds, entry));
  } catch (e) {
    // ENOENT is the normal Linux/source-build and Windows layout.
    if (e.code !== 'ENOENT') stderr.write(`airprompt: cannot scan ${prebuilds}: ${e.message}\n`);
  }

  let fixed = 0;
  for (const dir of dirs) {
    const helper = path.join(dir, 'spawn-helper');
    if (!fs.existsSync(helper)) continue;
    try {
      const mode = fs.statSync(helper).mode & 0o777;
      if ((mode & 0o111) !== 0o111) {
        fs.chmodSync(helper, mode | 0o111);
        fixed++;
      }
    } catch (e) {
      stderr.write(
        `airprompt: could not chmod ${helper}: ${e.message}\n` +
          `  fix: sudo chmod +x '${helper}'\n`
      );
    }
  }
  return fixed;
}

module.exports = { fixNodePtyPerms };
