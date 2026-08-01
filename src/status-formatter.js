#!/usr/bin/env node
// status-formatter.js — Format AirPrompt session JSON for human output.
// Reads daemon JSON from stdin, writes formatted text to stdout.
'use strict';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let data;
  try { data = JSON.parse(raw); } catch (_) {
    process.stdout.write('  (daemon returned unparseable JSON)\n');
    process.exit(1);
  }

  if (!Array.isArray(data) || data.length === 0) {
    process.stdout.write('Sessions:  (none registered)\n\nRegister with: /airprompt on\n');
    process.exit(0);
  }

  process.stdout.write('Sessions:\n\n');

  for (const s of data) {
    const sid      = s.id              || '?';
    const name     = s.name            || '(unnamed)';
    const cwd      = s.cwd             || '?';
    const created  = s.createdAt       || '?';
    const tmux     = s.tmuxSession     || '?';
    const mirror   = s.isMirror        || false;
    const active   = s.isActive        || false;
    const alive    = s.tmuxAlive       || false;
    const clients  = s.attachedClients || 0;
    const lastAct  = s.lastActivity    || null;

    // Human-friendly timestamps
    let createdStr = String(created);
    try {
      const d = new Date(created);
      if (!isNaN(d.getTime())) {
        createdStr = d.getFullYear() + '-' +
          String(d.getMonth() + 1).padStart(2, '0') + '-' +
          String(d.getDate()).padStart(2, '0') + ' ' +
          String(d.getHours()).padStart(2, '0') + ':' +
          String(d.getMinutes()).padStart(2, '0') + ':' +
          String(d.getSeconds()).padStart(2, '0');
      }
    } catch (_) {}

    let idleStr = '?';
    if (lastAct) {
      try {
        const idleS = (Date.now() - lastAct) / 1000;
        if (idleS < 60)        idleStr = String(Math.floor(idleS)) + 's ago';
        else if (idleS < 3600) idleStr = String(Math.floor(idleS / 60)) + 'm ago';
        else                   idleStr = String(Math.floor(idleS / 3600)) + 'h ago';
      } catch (_) { idleStr = String(lastAct); }
    }

    const stype    = mirror ? 'MIRROR  ' : 'REAL    ';
    const liveness = alive  ? 'ALIVE'    : 'DEAD';
    const badgeStr = active ? 'YES'      : 'no';
    const clientStr = String(clients);

    process.stdout.write(
      '  \x1b[1;36m' + name + '\x1b[0m  (' + stype + ')\n' +
      '    ID:           ' + sid + '\n' +
      '    Directory:    ' + cwd + '\n' +
      '    Tmux session: ' + tmux + '\n' +
      '    Tmux alive:   ' + liveness + '  |  Clients attached: ' + clientStr + '  |  Statusline badge: ' + badgeStr + '\n' +
      '    Created:      ' + createdStr + '  |  Last activity: ' + idleStr + '\n' +
      '\n'
    );
  }
});
