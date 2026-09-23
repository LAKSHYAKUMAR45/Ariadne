import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { OperatorRequest } from './protocol.js';

export const DEFAULT_EXEC_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_KILL_GRACE_MS = 10 * 1000;
export const DEFAULT_OUTPUT_TAIL_BYTES = 256 * 1024;
/**
 * How long the executor waits after the direct child has exited for its stdio
 * pipes to close. A descendant that inherited stdout keeps the pipe open, so
 * `close` may never fire; after this window the execution settles from `exit`
 * alone and the pipes are torn down, which is what keeps a wedged descendant
 * from holding the operator's single execution slot forever.
 */
export const DEFAULT_DRAIN_GRACE_MS = 5 * 1000;

/** Process groups (and therefore negative-pid signalling) are POSIX-only. */
export const PROCESS_GROUPS_SUPPORTED = process.platform !== 'win32';
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
  /**
   * POSIX only. The child leads its own process group so the timeout path can
   * signal every descendant with one `kill(-pid)` instead of orphaning
   * grandchildren that still hold the stdout pipe.
   */
  detached: boolean;
}

export interface OperatorSpawnedProcess {
  readonly pid?: number | undefined;
  stdout: Readable | null;
  stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export type SpawnImplementation = (
  file: string,
  args: readonly string[],
  options: OperatorSpawnOptions,
) => OperatorSpawnedProcess;

/** Injection point for `process.kill`, which vitest cannot safely stub. */
export type KillImplementation = (pid: number, signal: NodeJS.Signals) => void;

export interface CreateOperatorExecutorOptions {
  spawnImpl?: SpawnImplementation;
  killImpl?: KillImplementation;
  reporter?: OperatorEventSink;
  timeoutMs?: number;
  killGraceMs?: number;
  drainGraceMs?: number;
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
    const buffer = Buffer.concat(this.chunks, this.bytes);
    return dropLeadingContinuationBytes(buffer).toString('utf8');
  }
}

/**
 * Byte-bounded truncation can land in the middle of a multi-byte sequence, and
 * decoding the resulting leading fragment would produce U+FFFD replacement
 * characters at the head of every truncated result. Dropping the orphaned
 * continuation bytes (`10xxxxxx`) instead yields text that is whole from its
 * first character on. At most three bytes can ever be discarded.
 */
function dropLeadingContinuationBytes(buffer: Buffer): Buffer {
  let offset = 0;
  while (offset < buffer.length && offset < 3 && (buffer[offset] & 0xc0) === 0x80) {
    offset += 1;
  }
  return offset === 0 ? buffer : buffer.subarray(offset);
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

/**
 * The restore script refuses to run unless the confirmation variable names the
 * backup being restored. It is derived here from the already-validated
 * basename, so confirmation always comes from the operator service rather than
 * from anything a client can spell.
 */
function resolveEnv(request: OperatorRequest, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (request.type !== 'backup_restore') {
    return base;
  }
  return { ...base, ARIADNE_RESTORE_CONFIRM: request.backupName };
}

function defaultSpawn(
  file: string,
  args: readonly string[],
  options: OperatorSpawnOptions,
): OperatorSpawnedProcess {
  return spawn(file, [...args], options);
}

function defaultKill(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

/**
 * Signals the child's entire process group when the platform supports it, so a
 * grandchild that outlived its parent (and may still be holding the inherited
 * stdout pipe) is terminated too. Falls back to signalling the direct child
 * when there is no usable pid or the group signal cannot be delivered.
 */
function terminateProcessTree(
  child: OperatorSpawnedProcess,
  signal: NodeJS.Signals,
  killImpl: KillImplementation,
): void {
  const pid = child.pid;

  if (PROCESS_GROUPS_SUPPORTED && typeof pid === 'number' && pid > 0) {
    try {
      killImpl(-pid, signal);
      return;
    } catch {
      // The group is already gone, or this process cannot signal it; fall
      // through to the direct handle rather than leaving the child running.
    }
  }

  try {
    child.kill(signal);
  } catch {
    // Nothing further can be done; the settlement timers still fire.
  }
}

export function createOperatorExecutor(
  options: CreateOperatorExecutorOptions = {},
): OperatorExecutor {
  const spawnImpl = options.spawnImpl ?? defaultSpawn;
  const killImpl = options.killImpl ?? defaultKill;
  const defaultReporter = options.reporter;
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const drainGraceMs = options.drainGraceMs ?? DEFAULT_DRAIN_GRACE_MS;
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
          env: resolveEnv(request, env),
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: PROCESS_GROUPS_SUPPORTED,
        });

        let settled = false;
        let timedOut = false;
        let killTimer: NodeJS.Timeout | undefined;
        let drainTimer: NodeJS.Timeout | undefined;
        let forceSettleTimer: NodeJS.Timeout | undefined;

        // The timeout and kill timers are unref'd because they only bound a
        // process that is already keeping the loop alive. The drain and
        // force-settle timers are deliberately *not*: they are the mechanism
        // that releases the execution slot, so they must survive an otherwise
        // idle loop.
        const unrefTimer = (timer: NodeJS.Timeout | undefined): void => {
          timer?.unref?.();
        };

        const timeoutTimer = setTimeout(() => {
          timedOut = true;
          terminateProcessTree(child, 'SIGTERM', killImpl);
          killTimer = setTimeout(() => {
            terminateProcessTree(child, 'SIGKILL', killImpl);
            // Last resort: a SIGKILLed group can still leave an escaped
            // descendant holding the pipes, so the execution is settled from
            // the timeout path alone rather than waiting on `exit`/`close`.
            forceSettleTimer = setTimeout(() => {
              settle({ exitCode: null, signal: 'SIGKILL', spawnError: null });
            }, drainGraceMs);
          }, killGraceMs);
          unrefTimer(killTimer);
        }, timeoutMs);
        unrefTimer(timeoutTimer);

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
          if (drainTimer) {
            clearTimeout(drainTimer);
          }
          if (forceSettleTimer) {
            clearTimeout(forceSettleTimer);
          }
          // Releases this process' read ends so a surviving descendant cannot
          // keep the executor attached to a finished operation.
          child.stdout?.destroy();
          child.stderr?.destroy();
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
        // `close` is preferred because it guarantees the pipes are drained, but
        // it only fires once every writer is gone. `exit` always fires, so it
        // starts a bounded drain window after which the result is reported with
        // whatever output arrived.
        child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
          if (settled || drainTimer) {
            return;
          }
          drainTimer = setTimeout(() => {
            settle({ exitCode: code, signal, spawnError: null });
          }, drainGraceMs);
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
