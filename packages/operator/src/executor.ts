import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { OperatorRequest } from './protocol.js';

export const DEFAULT_EXEC_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_KILL_GRACE_MS = 10 * 1000;
export const DEFAULT_OUTPUT_TAIL_BYTES = 256 * 1024;
export const DEFAULT_EXEC_ENV = Object.freeze({
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
});

const operationCommands = {
  deployment_apply: ['/usr/local/lib/ariadne/deploy'],
  backup_create: ['/usr/local/lib/ariadne/backup'],
  backup_verify: ['/usr/local/lib/ariadne/verify-backup'],
  backup_restore: ['/usr/local/lib/ariadne/restore-backup'],
} as const;

const serviceRestartCommands = {
  'sync-server': ['/usr/local/lib/ariadne/restart-sync-server'],
  postgres: ['/usr/local/lib/ariadne/restart-postgres'],
} as const;

export interface OperatorProgressEvent {
  operationId: string;
  stream: 'stdout' | 'stderr';
  chunk: string;
}

export interface OperatorResultEvent {
  operationId: string;
  success: boolean;
  output: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  truncated: boolean;
}

export interface OperatorEventSink {
  onProgress?(event: OperatorProgressEvent): void | Promise<void>;
  onResult?(event: OperatorResultEvent): void | Promise<void>;
}

export interface OperatorExecutor {
  execute(request: OperatorRequest, reporter?: OperatorEventSink): Promise<void>;
}

export interface OperatorSpawnOptions {
  env: NodeJS.ProcessEnv;
  shell: false;
  windowsHide: true;
  stdio: ['ignore', 'pipe', 'pipe'];
}

export interface OperatorSpawnedProcess {
  stdout: Readable | null;
  stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export type SpawnImplementation = (
  file: string,
  args: readonly string[],
  options: OperatorSpawnOptions,
) => OperatorSpawnedProcess;

export interface CreateOperatorExecutorOptions {
  spawnImpl?: SpawnImplementation;
  reporter?: OperatorEventSink;
  timeoutMs?: number;
  killGraceMs?: number;
  outputTailBytes?: number;
  env?: NodeJS.ProcessEnv;
}

class OperatorExecutionError extends Error {
  readonly result: OperatorResultEvent;

  constructor(message: string, result: OperatorResultEvent) {
    super(message);
    this.name = 'OperatorExecutionError';
    this.result = result;
  }
}

/**
 * Keeps only the trailing bytes of a stream so chatty privileged commands are
 * never aborted for exceeding a buffer ceiling.
 */
class BoundedOutputTail {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private truncatedOutput = false;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer): void {
    if (this.maxBytes <= 0) {
      this.truncatedOutput = true;
      return;
    }

    this.chunks.push(chunk);
    this.bytes += chunk.length;

    while (this.bytes > this.maxBytes && this.chunks.length > 0) {
      const oldest = this.chunks[0];
      const overflow = this.bytes - this.maxBytes;
      this.truncatedOutput = true;

      if (oldest.length <= overflow) {
        this.chunks.shift();
        this.bytes -= oldest.length;
        continue;
      }

      this.chunks[0] = oldest.subarray(overflow);
      this.bytes -= overflow;
    }
  }

  get truncated(): boolean {
    return this.truncatedOutput;
  }

  toString(): string {
    return Buffer.concat(this.chunks, this.bytes).toString('utf8');
  }
}

function appendArgument(command: readonly string[], argument?: string): [string, string[]] {
  const [file, ...baseArgs] = command;
  return [file, argument ? [...baseArgs, argument] : [...baseArgs]];
}

function resolveCommand(request: OperatorRequest): [string, string[]] {
  switch (request.type) {
    case 'service_restart':
      return appendArgument(serviceRestartCommands[request.service]);
    case 'deployment_apply':
      return appendArgument(operationCommands.deployment_apply, request.revision);
    case 'backup_create':
      return appendArgument(operationCommands.backup_create);
    case 'backup_verify':
      return appendArgument(operationCommands.backup_verify, request.backupName);
    case 'backup_restore':
      return appendArgument(operationCommands.backup_restore, request.backupName);
  }
}

function defaultSpawn(
  file: string,
  args: readonly string[],
  options: OperatorSpawnOptions,
): OperatorSpawnedProcess {
  return spawn(file, [...args], options);
}

export function createOperatorExecutor(
  options: CreateOperatorExecutorOptions = {},
): OperatorExecutor {
  const spawnImpl = options.spawnImpl ?? defaultSpawn;
  const defaultReporter = options.reporter;
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const outputTailBytes = options.outputTailBytes ?? DEFAULT_OUTPUT_TAIL_BYTES;
  const env = options.env ?? DEFAULT_EXEC_ENV;

  return {
    async execute(request: OperatorRequest, reporter?: OperatorEventSink): Promise<void> {
      const sink = reporter ?? defaultReporter;
      const [file, args] = resolveCommand(request);
      const tail = new BoundedOutputTail(outputTailBytes);

      let pendingProgress: Promise<void> = Promise.resolve();
      const forwardChunk = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
        tail.append(chunk);
        if (!sink?.onProgress) {
          return;
        }

        const text = chunk.toString('utf8');
        pendingProgress = pendingProgress
          .then(async () => {
            await sink.onProgress?.({ operationId: request.operationId, stream, chunk: text });
          })
          .catch(() => undefined);
      };

      const outcome = await new Promise<{
        exitCode: number | null;
        signal: NodeJS.Signals | null;
        spawnError: Error | null;
        timedOut: boolean;
      }>((resolve) => {
        const child = spawnImpl(file, args, {
          env,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let settled = false;
        let timedOut = false;
        let killTimer: NodeJS.Timeout | undefined;

        const timeoutTimer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          killTimer = setTimeout(() => {
            child.kill('SIGKILL');
          }, killGraceMs);
          killTimer.unref?.();
        }, timeoutMs);
        timeoutTimer.unref?.();

        const settle = (outcomeValue: {
          exitCode: number | null;
          signal: NodeJS.Signals | null;
          spawnError: Error | null;
        }): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeoutTimer);
          if (killTimer) {
            clearTimeout(killTimer);
          }
          resolve({ ...outcomeValue, timedOut });
        };

        child.stdout?.on('data', (chunk: Buffer | string) => {
          forwardChunk('stdout', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        child.stderr?.on('data', (chunk: Buffer | string) => {
          forwardChunk('stderr', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        child.stdout?.on('error', () => undefined);
        child.stderr?.on('error', () => undefined);

        child.on('error', (error: Error) => {
          settle({ exitCode: null, signal: null, spawnError: error });
        });
        child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
          settle({ exitCode: code, signal, spawnError: null });
        });
      });

      await pendingProgress;

      const success =
        outcome.spawnError === null && !outcome.timedOut && outcome.exitCode === 0;
      const result: OperatorResultEvent = {
        operationId: request.operationId,
        success,
        output: tail.toString(),
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        truncated: tail.truncated,
      };

      if (sink?.onResult) {
        await sink.onResult(result);
      }

      if (success) {
        return;
      }

      if (outcome.timedOut) {
        throw new OperatorExecutionError(
          `Operator command timed out after ${timeoutMs}ms: ${file}`,
          result,
        );
      }

      if (outcome.spawnError) {
        throw new OperatorExecutionError(
          `Operator command failed to start: ${outcome.spawnError.message}`,
          result,
        );
      }

      throw new OperatorExecutionError(
        `Operator command exited with code ${String(outcome.exitCode)}: ${file}`,
        result,
      );
    },
  };
}

export { OperatorExecutionError };
