import {
  execFile,
  type ExecFileException,
  type ExecFileOptionsWithStringEncoding,
} from 'node:child_process';
import type { Readable } from 'node:stream';
import type { OperatorRequest } from './protocol.js';

export const DEFAULT_EXEC_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_EXEC_MAX_BUFFER_BYTES = 256 * 1024;
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
}

export interface OperatorEventSink {
  onProgress?(event: OperatorProgressEvent): void | Promise<void>;
  onResult?(event: OperatorResultEvent): void | Promise<void>;
}

export interface OperatorExecutor {
  execute(request: OperatorRequest): Promise<void>;
}

type ExecFileCallback = (
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
) => void;

type ExecFileReturn = {
  stdout?: Readable | null;
  stderr?: Readable | null;
};

export type ExecFileImplementation = (
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: ExecFileCallback,
) => ExecFileReturn;

export interface CreateOperatorExecutorOptions {
  execFileImpl?: ExecFileImplementation;
  reporter?: OperatorEventSink;
  timeoutMs?: number;
  maxBufferBytes?: number;
  env?: NodeJS.ProcessEnv;
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

async function emitProgress(
  reporter: OperatorEventSink | undefined,
  operationId: string,
  stream: 'stdout' | 'stderr',
  chunk: Buffer | string,
): Promise<void> {
  if (!reporter?.onProgress) {
    return;
  }

  await reporter.onProgress({
    operationId,
    stream,
    chunk: typeof chunk === 'string' ? chunk : chunk.toString('utf8'),
  });
}

function attachProgressListeners(
  child: ExecFileReturn,
  request: OperatorRequest,
  reporter: OperatorEventSink | undefined,
): void {
  child.stdout?.on('data', (chunk) => {
    void emitProgress(reporter, request.operationId, 'stdout', chunk);
  });
  child.stderr?.on('data', (chunk) => {
    void emitProgress(reporter, request.operationId, 'stderr', chunk);
  });
}

function createFailure(error: ExecFileException, output: string): OperatorResultEvent {
  return {
    operationId: '',
    success: false,
    output,
    exitCode: typeof error.code === 'number' ? error.code : null,
    signal: error.signal ?? null,
  };
}

export function createOperatorExecutor(
  options: CreateOperatorExecutorOptions = {},
): OperatorExecutor {
  const execFileImpl = options.execFileImpl ?? execFile;
  const reporter = options.reporter;
  const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_EXEC_MAX_BUFFER_BYTES;
  const env = options.env ?? DEFAULT_EXEC_ENV;

  return {
    async execute(request: OperatorRequest): Promise<void> {
      const [file, args] = resolveCommand(request);

      const result = await new Promise<OperatorResultEvent>((resolve, reject) => {
        const child = execFileImpl(
          file,
          args,
          {
            encoding: 'utf8',
            env,
            maxBuffer: maxBufferBytes,
            shell: false,
            timeout: timeoutMs,
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            const output = `${stdout}${stderr}`;
            if (error) {
              const failure = createFailure(error, output);
              failure.operationId = request.operationId;
              reject(Object.assign(error, { operatorResult: failure }));
              return;
            }

            resolve({
              operationId: request.operationId,
              success: true,
              output,
              exitCode: 0,
              signal: null,
            });
          },
        );
        attachProgressListeners(child, request, reporter);
      }).catch(async (error: unknown) => {
        const operatorResult =
          error instanceof Error && 'operatorResult' in error
            ? (error.operatorResult as OperatorResultEvent)
            : {
                operationId: request.operationId,
                success: false,
                output: '',
                exitCode: null,
                signal: null,
              };

        if (reporter?.onResult) {
          await reporter.onResult(operatorResult);
        }
        throw error;
      });

      if (reporter?.onResult) {
        await reporter.onResult(result);
      }
    },
  };
}
