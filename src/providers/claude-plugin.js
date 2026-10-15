// src/providers/claude-plugin.js — Claude Code plugin record handling.
//
// Claude Code pins each installed plugin to a directory in its marketplace
// cache (`~/.claude/plugins/installed_plugins.json` → `installPath`). That
// directory can disappear — cache churn on update, a pruned cache, a manual
// `rm -rf` — and the record survives it. The symptoms:
//
//   - `/plugin` shows `Plugin "airprompt" not cached at <path>`
//   - `claude plugin update` acts on a record with no files behind it
//   - a naive "is it installed?" probe answers yes, so re-running the installer
//     used to leave the broken record in place forever
//
// `claude plugin list --json` reports the recorded `installPath`, so health is
// a plain existsSync. Repair is `claude plugin update <id>`; a fresh install
// goes through `plugin install <name> --marketplace <owner>/<repo>`, which
// resolves the plugin by name and does not depend on the marketplace's local
// name — that name is frozen when the marketplace is added and goes stale the
// moment the repo moves (as it did when this project re-homed to farox-coop).
//
// Pure logic here; the spawn helpers are injected so this is unit-testable.

'use strict';

const fs = require('fs');

const PLUGIN_NAME = 'airprompt';

const LIST_ARGS = ['plugin', 'list', '--json'];

function installArgs(repo) {
  return ['plugin', 'install', PLUGIN_NAME, '--marketplace', repo];
}

// Pre-`--marketplace` CLIs resolve the plugin as <name>@<marketplace-name>.
// Only correct when the marketplace was added under its own repo name, so it
// is a fallback, never the first attempt.
function legacyId() {
  return `${PLUGIN_NAME}@${PLUGIN_NAME}`;
}

function legacyInstallArgs() {
  return ['plugin', 'install', legacyId()];
}

function repairArgs(id) {
  return ['plugin', 'update', id];
}

function parseList(stdout) {
  try {
    const data = JSON.parse(stdout);
    return Array.isArray(data) ? data : [];
  } catch (_) {
    return [];
  }
}

// Entries look like { id: 'airprompt@airprompt', installPath, … }.
// The marketplace half is whatever the marketplace was named when added.
function findRecord(records) {
  if (!Array.isArray(records)) return null;
  return (
    records.find((r) => r && typeof r.id === 'string' && r.id.split('@')[0] === PLUGIN_NAME) || null
  );
}

// 'ok'          — record present, cache dir on disk
// 'missing-dir' — record present, cache dir gone (the /plugin error)
// 'not-installed'
// 'unknown'     — installed, but this CLI cannot report its path (no --json)
function recordHealth(record, existsSync = fs.existsSync) {
  if (!record) return 'not-installed';
  if (typeof record.installPath !== 'string' || !record.installPath) return 'missing-dir';
  return existsSync(record.installPath) ? 'ok' : 'missing-dir';
}

// What the installer should do about the plugin, given the probe result.
// 'skip' — present and healthy (or unverifiable) and not forced
// 'repair' — the record is there but its cache dir is gone, or --force asks for
//            a refetch: `plugin update` re-checks out, where `plugin install`
//            on an already-installed plugin is a no-op that still exits 0
// 'install'
function planPluginAction(record, health, force) {
  if (health === 'missing-dir') return 'repair';
  if (health === 'not-installed') return 'install';
  if (force) return record ? 'repair' : 'install';
  return 'skip';
}

// Probe the local `claude` CLI. `H` is src/install-helpers; `env` is the
// environment the installer resolved (it carries the target config dir), so
// the probe and the mutation that follows it read the same config.
function probePlugin(H, env) {
  const opts = env ? { env } : undefined;
  const json = H.captureSpawn('claude', LIST_ARGS, opts);
  if (json.status === 0) {
    const record = findRecord(parseList(json.stdout));
    return { record, health: recordHealth(record) };
  }
  const text = H.captureSpawn('claude', ['plugin', 'list'], opts);
  const seen = text.status === 0 && /airprompt/i.test(text.stdout || '');
  return { record: null, health: seen ? 'unknown' : 'not-installed' };
}

// Install from scratch. `install --marketplace <repo>` adds the marketplace
// itself when needed, so the explicit `marketplace add` is only for CLIs that
// predate the flag.
function installPlugin(H, repo, pluginEnv, dryRun) {
  H.runSpawn('claude', ['plugin', 'marketplace', 'add', repo], { env: pluginEnv }, dryRun);
  for (const args of [installArgs(repo), legacyInstallArgs()]) {
    const r = H.runSpawn('claude', args, { env: pluginEnv }, dryRun);
    if (dryRun || H.spawnOk(r)) return { ok: true, args };
  }
  return { ok: false };
}

// Point a stale record back at a cache dir that exists.
function repairPlugin(H, id, pluginEnv, dryRun) {
  const r = H.runSpawn('claude', repairArgs(id), { env: pluginEnv }, dryRun);
  if (dryRun) return { ok: true, args: repairArgs(id) };
  if (!H.spawnOk(r)) return { ok: false };
  const after = probePlugin(H, pluginEnv);
  return { ok: after.health === 'ok', health: after.health };
}

module.exports = {
  PLUGIN_NAME,
  LIST_ARGS,
  installArgs,
  legacyId,
  legacyInstallArgs,
  repairArgs,
  parseList,
  findRecord,
  recordHealth,
  planPluginAction,
  probePlugin,
  installPlugin,
  repairPlugin,
};
