import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { TaskStore } from '@ariadne/core';
import { redactCommand } from '@ariadne/core';

type SpawnFn = typeof spawn;

export interface RunExecOptions {
  spawnImpl?: SpawnFn;
}

export function formatExecCommand(command: string, args: string[]): string {
  return [command, ...args].join(' ');
}

function recordFailedCommand(store: TaskStore, taskId: string, cmdRedacted: string, exitCode: number): void {
  store.recordCommand({ taskId, cmdRedacted, exitCode });
  store.recordError({ taskId, message: `Command failed (exit ${exitCode}): ${cmdRedacted}` });
}

export function runTaskExec(
  store: TaskStore,
  taskId: string,
  command: string,
  args: string[],
  options: RunExecOptions = {},
): Promise<number> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const cmdRedacted = redactCommand(formatExecCommand(command, args));

  return new Promise<number>((resolve) => {
    let settled = false;
    const child = spawnImpl(command, args, { stdio: 'inherit' }) as ChildProcess;

    child.once('error', (err: Error) => {
      if (settled) return;
      settled = true;
      const exitCode = 1;
      console.error(err.message);
      recordFailedCommand(store, taskId, cmdRedacted, exitCode);
      resolve(exitCode);
    });

    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;

      if (code === 0) {
        store.recordCommand({ taskId, cmdRedacted, exitCode: 0 });
        resolve(0);
        return;
      }

      const exitCode = code ?? 1;
      if (code === null && signal) {
        console.error(`Command terminated by signal ${signal}: ${cmdRedacted}`);
      }
      recordFailedCommand(store, taskId, cmdRedacted, exitCode);
      resolve(exitCode);
    });
  });
}
