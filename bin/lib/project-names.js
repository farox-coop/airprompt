#!/usr/bin/env node
// bin/lib/project-names.js — Manage cwd→name mappings in project-names.json.
//
// Usage:
//   node project-names.js set    <file> <cwd> <name>   — save mapping
//   node project-names.js clear  <file> <cwd>           — remove mapping
//   node project-names.js get    <file> <cwd>           — print name for cwd (empty if none)
//
// Creates the file if it doesn't exist. Merges with existing entries.

'use strict';

const fs = require('fs');

const cmd = process.argv[2];
const file = process.argv[3];
const cwd = process.argv[4];
const name = process.argv[5] || '';

if (!cmd || !file || !cwd) {
  process.stderr.write('Usage: node project-names.js <set|clear|get> <file> <cwd> [name]\n');
  process.exit(1);
}

let map = {};
try {
  if (fs.existsSync(file)) {
    map = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof map !== 'object' || map === null || Array.isArray(map)) map = {};
  }
} catch (_) {
  map = {};
}

switch (cmd) {
  case 'set':
    map[cwd] = name;
    fs.mkdirSync(require('path').dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(map, null, 2));
    break;
  case 'clear':
    delete map[cwd];
    fs.mkdirSync(require('path').dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(map, null, 2));
    break;
  case 'get':
    process.stdout.write((map[cwd] || '') + '\n');
    break;
  default:
    process.stderr.write('Unknown command: ' + cmd + '\n');
    process.exit(1);
}
