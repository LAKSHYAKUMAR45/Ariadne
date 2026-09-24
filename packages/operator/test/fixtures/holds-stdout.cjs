'use strict';

/**
 * Regression fixture for the executor timeout path.
 *
 * Spawns a detached grandchild that inherits this process' stdout and then
 * escapes the process group (`detached: true` gives it its own group, so a
 * `kill(-pgid)` aimed at this process never reaches it). The grandchild keeps
 * the stdout pipe open after this process is terminated, which is exactly the
 * shape that used to wedge an operator slot: `close` never fires because the
 * pipe still has a writer.
 *
 * The grandchild pid is printed first so the test can reap it.
 */
const { spawn } = require('node:child_process');

const grandchild = spawn(
  process.execPath,
  ['-e', 'setInterval(() => {}, 1000);'],
  { detached: true, stdio: ['ignore', 'inherit', 'ignore'] },
);
grandchild.unref();

process.stdout.write(`grandchild:${grandchild.pid}\n`);
setInterval(() => {}, 1000);
