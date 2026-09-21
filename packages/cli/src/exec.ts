import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { TaskStore } from '@ariadne-dev/core';
import { redactCommand, isGitCommitCommand, syncTaskGit } from '@ariadne-dev/core';

type SpawnFn = typeof spawn;

export interface RunExecOptions {
  spawnImpl?: SpawnFn;
  /** Workspace root to run a best-effort `syncTaskGit` against after a successful `git commit`. Optional so tests/callers without a repo on disk can omit it. */
  workspaceRoot?: string;
}

export function formatExecCommand(command: string, args: string[]): string {
  return [command, ...args].join(' ');
}

function recordFailedCommand(store: TaskStore, taskId: string, cmdRedacted: string, exitCode: number): void {
  store.recordCommand({ taskId, cmdRedacted, exitCode });
  store.recordError({ taskId, message: `Command failed (exit ${exitCode}): ${cmdRedacted}` });
}

/**
 * Records a successful command: stores it, auto-resolves any earlier
 * unresolved "Command failed" error for this exact command (a RED→GREEN
 * rerun is no longer an open problem), and — for a `git commit` — best-effort
 * syncs new commits and the files each one touched, so `recentCommits`/
 * `recentFiles` stay populated without the caller having to remember to run
 * `ariadne git-sync` separately.
 */
function recordSuccessfulCommand(store: TaskStore, taskId: string, cmdRedacted: string, workspaceRoot?: string): void {
  store.recordCommand({ taskId, cmdRedacted, exitCode: 0 });
  store.autoResolveMatchingCommandErrors(taskId, cmdRedacted);
  if (workspaceRoot && isGitCommitCommand(cmdRedacted)) {
    try {
      syncTaskGit(store, taskId, workspaceRoot);
    } catch {
      // Best-effort: not a git repo, git unavailable, etc.
    }
  }
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
        recordSuccessfulCommand(store, taskId, cmdRedacted, options.workspaceRoot);
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
