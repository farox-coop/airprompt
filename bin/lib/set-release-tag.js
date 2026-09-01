#!/usr/bin/env node
// bin/lib/set-release-tag.js — Propagate a release tag across all version files.
//
// Usage: node bin/lib/set-release-tag.js vX.Y.Z   (via `make set-release-tag TAG=vX.Y.Z`)
//
// Single source of truth is the `version` file (X.Y.Z, no `v`) at the repo root.
// This script pushes the same release to every place a version lives:
//   version                → X.Y.Z
//   package.json           → X.Y.Z
//   package-lock.json      → X.Y.Z (top-level + root package entry)
//   install.sh             → VERSION="vX.Y.Z"
//   install.ps1            → $Version = "vX.Y.Z"
//   README.md              → raw.githubusercontent.com/.../vX.Y.Z/install.{sh,ps1}

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

const tag = process.argv[2];
if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  process.stderr.write('Usage: node bin/lib/set-release-tag.js vX.Y.Z\n');
  process.exit(1);
}
const ver = tag.slice(1); // X.Y.Z

function read(p) {
  return fs.readFileSync(path.join(ROOT, p), 'utf8');
}
function write(p, s) {
  fs.writeFileSync(path.join(ROOT, p), s);
  process.stdout.write(`  ${p} → ${ver}\n`);
}

// version file (root) — the Node-side source of truth (plain X.Y.Z)
write('version', `${ver}\n`);

// package.json + package-lock.json (npm semver, no `v`)
for (const p of ['package.json', 'package-lock.json']) {
  const j = JSON.parse(read(p));
  j.version = ver;
  if (p === 'package-lock.json' && j.packages && j.packages['']) j.packages[''].version = ver;
  write(p, JSON.stringify(j, null, 2) + '\n');
}

// install.sh — VERSION="vX.Y.Z"
write('install.sh', read('install.sh').replace(/^VERSION="v[0-9.]+"/m, `VERSION="${tag}"`));

// install.ps1 — $Version = "vX.Y.Z"
write('install.ps1', read('install.ps1').replace(/\$Version = "v[0-9.]+"/, `$Version = "${tag}"`));

// README.md — only bump the pinned `vX.Y.Z` example one-liners; leave `latest` alone
write(
  'README.md',
  read('README.md').replace(
    /github\.com\/farox-coop\/airprompt\/releases\/download\/v[0-9.]+/g,
    `github.com/farox-coop/airprompt/releases/download/${tag}`
  )
);

process.stdout.write(`\nRelease tag ${tag} propagated across version files.\n`);
