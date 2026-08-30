#!/usr/bin/env node
// bin/lib/autostart.js — Manage AirPrompt auto-start hook in IDE settings.json.
//
// Usage:
//   node autostart.js on  <settings_path> <activate_script> <settings_lib>
//   node autostart.js off <settings_path> <settings_lib>
//
// Uses bin/lib/settings.js for settings read/write + hook manipulation.

'use strict';

const cmd = process.argv[2];
const settingsPath = process.argv[3];

if (!cmd || !settingsPath || (cmd !== 'on' && cmd !== 'off')) {
  process.stderr.write(
    'Usage: node autostart.js <on|off> <settings_path> [activate_script] <settings_lib>\n'
  );
  process.exit(1);
}

let settingsLib;
if (cmd === 'on') {
  const activateScript = process.argv[4];
  settingsLib = process.argv[5];
  if (!activateScript || !settingsLib) {
    process.stderr.write(
      'Usage: node autostart.js on <settings_path> <activate_script> <settings_lib>\n'
    );
    process.exit(1);
  }

  const { readSettings, writeSettings, addCommandHook } = require(settingsLib);
  const s = readSettings(settingsPath);
  if (s === null) {
    process.stderr.write('AirPrompt autostart: settings.json is corrupted — cannot modify\n');
    process.exit(1);
  }
  // NOTE: marker is a stable identifier, not a path. Must match the
  // MANAGED_HOOK_BASENAMES set in bin/lib/settings.js or off won't clean it.
  const added = addCommandHook(s, 'SessionStart', {
    command: 'node ' + JSON.stringify(activateScript),
    marker: 'airprompt-activate.js',
    timeout: 10,
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

  const { readSettings, writeSettings, removeAirPromptHooks } = require(settingsLib);
  const s = readSettings(settingsPath);
  if (s === null) {
    process.stderr.write('AirPrompt autostart: settings.json is corrupted — cannot modify\n');
    process.exit(1);
  }
  const removed = removeAirPromptHooks(s);
  if (removed === 0) {
    process.stdout.write('AirPrompt autostart: already OFF\n');
    process.exit(0);
  }
  if (s.hooks && Object.keys(s.hooks).length === 0) delete s.hooks;
  writeSettings(settingsPath, s);
  process.stdout.write('AirPrompt autostart: OFF\n');
}
