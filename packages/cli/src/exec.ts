import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { TaskStore } from '@ariadne-dev/core';
import { redactCommand, summarizeOutputTail, isGitCommitCommand, syncTaskGit } from '@ariadne-dev/core';

type SpawnFn = typeof spawn;

export interface RunExecOptions {
  spawnImpl?: SpawnFn;
  /** Workspace root to run a best-effort `syncTaskGit` against after a successful `git commit`. Optional so tests/callers without a repo on disk can omit it. */
  workspaceRoot?: string;
  /** Optional caller-supplied short label for `commands.summary` (e.g. "ran L4 usecase RED tests"), shown instead of the raw command line in context/resume. */
  summary?: string;
}

export function formatExecCommand(command: string, args: string[]): string {
  return [command, ...args].join(' ');
}

/** How much combined stdout+stderr to keep in memory while a command runs, so a chatty command can't grow this unbounded — only the very end of the output is ever useful for a failure excerpt anyway. */
const OUTPUT_TAIL_BUFFER_CHARS = 4000;

function appendTail(buffer: string, chunk: string): string {
  const combined = buffer + chunk;
  return combined.length > OUTPUT_TAIL_BUFFER_CHARS ? combined.slice(combined.length - OUTPUT_TAIL_BUFFER_CHARS) : combined;
}

function buildFailureMessage(cmdRedacted: string, exitCode: number, outputTail?: string): string {
  const header = `Command failed (exit ${exitCode}): ${cmdRedacted}`;
  if (!outputTail) return header;
  return `${header}\n${outputTail}`;
}

function recordFailedCommand(
  store: TaskStore,
  taskId: string,
  cmdRedacted: string,
  exitCode: number,
  summary: string | undefined,
  outputTail: string | undefined,
): void {
  store.recordCommand({ taskId, cmdRedacted, exitCode, summary });
  store.recordError({ taskId, message: buildFailureMessage(cmdRedacted, exitCode, outputTail) });
}

/**
 * Records a successful command: stores it, auto-resolves any earlier
 * unresolved "Command failed" error for this exact command (a RED→GREEN
 * rerun is no longer an open problem), and — for a `git commit` — best-effort
 * syncs new commits and the files each one touched, so `recentCommits`/
 * `recentFiles` stay populated without the caller having to remember to run
 * `ariadne git-sync` separately.
 */
function recordSuccessfulCommand(
  store: TaskStore,
  taskId: string,
  cmdRedacted: string,
  summary: string | undefined,
  workspaceRoot?: string,
): void {
  store.recordCommand({ taskId, cmdRedacted, exitCode: 0, summary });
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
    let outputTail = '';
    // Pipe (rather than inherit) stdout/stderr so we can capture a bounded
    // tail for the auto-generated failure message, while still forwarding
    // every chunk straight to this process's own stdout/stderr so `ariadne
    // exec` remains fully interactive/streaming for the user.
    const child = spawnImpl(command, args, { stdio: ['inherit', 'pipe', 'pipe'] }) as ChildProcess;
    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      outputTail = appendTail(outputTail, chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      outputTail = appendTail(outputTail, chunk.toString('utf8'));
    });

    child.once('error', (err: Error) => {
      if (settled) return;
      settled = true;
      const exitCode = 1;
      console.error(err.message);
      recordFailedCommand(store, taskId, cmdRedacted, exitCode, options.summary, summarizeOutputTail(outputTail));
      resolve(exitCode);
    });

    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;

      if (code === 0) {
        recordSuccessfulCommand(store, taskId, cmdRedacted, options.summary, options.workspaceRoot);
        resolve(0);
        return;
      }

      const exitCode = code ?? 1;
      if (code === null && signal) {
        console.error(`Command terminated by signal ${signal}: ${cmdRedacted}`);
      }
      recordFailedCommand(store, taskId, cmdRedacted, exitCode, options.summary, summarizeOutputTail(outputTail));
      resolve(exitCode);
    });
  });
}

