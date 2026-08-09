#!/usr/bin/env node
// bin/lib/autostart.js — Manage AirPrompt auto-start hook in IDE settings.json.
//
// Usage:
//   node autostart.js on  <settings_path> <activate_script> <settings_lib>
//   node autostart.js off <settings_path> <settings_lib>
//
// Uses bin/lib/settings.js for settings read/write + hook manipulation.

'use strict';

const path = require('path');

const cmd = process.argv[2];
const settingsPath = process.argv[3];

if (!cmd || !settingsPath || (cmd !== 'on' && cmd !== 'off')) {
  process.stderr.write('Usage: node autostart.js <on|off> <settings_path> [activate_script] <settings_lib>\n');
  process.exit(1);
}

let settingsLib;
if (cmd === 'on') {
  const activateScript = process.argv[4];
  settingsLib = process.argv[5];
  if (!activateScript || !settingsLib) {
    process.stderr.write('Usage: node autostart.js on <settings_path> <activate_script> <settings_lib>\n');
    process.exit(1);
  }

  const { readSettings, writeSettings, addCommandHook } = require(settingsLib);
  const s = readSettings(settingsPath);
  if (s === null) {
    process.stderr.write('AirPrompt autostart: settings.json is corrupted — cannot modify\n');
    process.exit(1);
  }
  const added = addCommandHook(s, 'SessionStart', {
    command: 'node ' + JSON.stringify(activateScript),
    marker: 'airprompt-activate.js',
    timeout: 10000,
    statusMessage: 'Starting AirPrompt...',
  });
  if (added) {
    writeSettings(settingsPath, s);
    process.stdout.write('AirPrompt autostart: ON\n');
  } else {
    process.stdout.write('AirPrompt autostart: already ON\n');
  }
} else {
  // off
  settingsLib = process.argv[4];
  if (!settingsLib) {
    process.stderr.write('Usage: node autostart.js off <settings_path> <settings_lib>\n');
    process.exit(1);
  }

  const { readSettings, writeSettings, hasAirPromptHook, tokenizeCommand } = require(settingsLib);
  const s = readSettings(settingsPath);
  if (s === null) {
    process.stderr.write('AirPrompt autostart: settings.json is corrupted — cannot modify\n');
    process.exit(1);
  }
  if (!hasAirPromptHook(s, 'SessionStart', 'airprompt-activate.js')) {
    process.stdout.write('AirPrompt autostart: already OFF\n');
    process.exit(0);
  }

  const MANAGED = ['airprompt-activate.js', 'airprompt-deactivate.js', 'airprompt-statusline.sh'];
  if (!Array.isArray(s.hooks.SessionStart)) {
    s.hooks.SessionStart = [];
  }
  for (let ei = 0; ei < s.hooks.SessionStart.length; ei++) {
    const entry = s.hooks.SessionStart[ei];
    if (!entry || !Array.isArray(entry.hooks)) continue;
    entry.hooks = entry.hooks.filter(function (h) {
      // Preserve hooks that aren't command-type (agent hooks, etc.)
      if (!h || typeof h.command !== 'string') return true;
      const tokens = tokenizeCommand(h.command);
      return !tokens.some(function (t) {
        return MANAGED.indexOf(path.basename(t)) !== -1;
      });
    });
  }
  s.hooks.SessionStart = s.hooks.SessionStart.filter(function (entry) {
    return entry && Array.isArray(entry.hooks) && entry.hooks.length > 0;
  });
  if (s.hooks.SessionStart.length === 0) delete s.hooks.SessionStart;
  if (Object.keys(s.hooks).length === 0) delete s.hooks;
  writeSettings(settingsPath, s);
  process.stdout.write('AirPrompt autostart: OFF\n');
}
