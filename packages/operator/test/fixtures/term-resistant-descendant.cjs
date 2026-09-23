'use strict';

/**
 * Regression fixture for the timeout escalation path.
 *
 * Spawns a descendant that stays in this process' group (so a `kill(-pgid)`
 * reaches it), inherits stdout, and ignores SIGTERM. This process, by
 * contrast, exits promptly on SIGTERM. That ordering is what used to defeat
 * the escalation: the direct child was gone well before the kill grace
 * elapsed, the drain window settled the execution, and clearing the kill timer
 * left the descendant running with root privileges after the slot had been
 * released.
 *
 * The descendant pid is printed first so the test can observe and reap it.
 */
const { spawn } = require('node:child_process');

const descendant = spawn(
  process.execPath,
  ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
  { detached: false, stdio: ['ignore', 'inherit', 'ignore'] },
);
descendant.unref();

process.stdout.write(`descendant:${descendant.pid}\n`);

process.on('SIGTERM', () => {
  process.exit(0);
});

setInterval(() => {}, 1000);
