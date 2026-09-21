import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXEC_ENV,
  DEFAULT_EXEC_TIMEOUT_MS,
  DEFAULT_OUTPUT_TAIL_BYTES,
  createOperatorExecutor,
  type OperatorEventSink,
  type OperatorSpawnedProcess,
} from '../src/executor.js';
import { parseOperatorRequest, type OperatorRequest } from '../src/protocol.js';

describe('parseOperatorRequest', () => {
  it('accepts the exact strict discriminated union', () => {
    const requests: OperatorRequest[] = [
      {
        operationId: 'op-service-restart',
        type: 'service_restart',
        service: 'sync-server',
      },
      {
        operationId: 'op-deployment-apply',
        type: 'deployment_apply',
        revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      {
        operationId: 'op-backup-create',
        type: 'backup_create',
      },
      {
        operationId: 'op-backup-verify',
        type: 'backup_verify',
        backupName: 'backup-2026-09-21.dump',
      },
      {
        operationId: 'op-backup-restore',
        type: 'backup_restore',
        backupName: 'backup-2026-09-21.dump',
      },
    ];

    for (const request of requests) {
      expect(parseOperatorRequest(request)).toEqual(request);
    }
  });

  it('rejects unknown fields and invalid operation variants', () => {
    expect(() =>
      parseOperatorRequest({
        operationId: 'op-invalid-service',
        type: 'service_restart',
        service: 'redis',
      }),
    ).toThrowError();

    expect(() =>
      parseOperatorRequest({
        operationId: 'op-invalid-revision',
        type: 'deployment_apply',
        revision: 'ABCDEF',
      }),
    ).toThrowError();

    expect(() =>
      parseOperatorRequest({
        operationId: 'op-invalid-backup-name',
        type: 'backup_verify',
        backupName: '../backup.dump',
      }),
    ).toThrowError();

    expect(() =>
      parseOperatorRequest({
        operationId: 'op-extra-field',
        type: 'backup_create',
        ignored: true,
      }),
    ).toThrowError();

    expect(() =>
      parseOperatorRequest({
        operationId: 'op-unknown-type',
        type: 'shell_exec',
      }),
    ).toThrowError();
  });
});


class FakeChildProcess extends EventEmitter implements OperatorSpawnedProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killSignals: Array<NodeJS.Signals | undefined> = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.killSignals.push(signal);
    return true;
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, signal);
  }
}

describe('createOperatorExecutor', () => {
  it('uses fixed command mappings, bounded exec options, and reporter hooks', async () => {
    const events: Array<{ kind: string; value: string }> = [];
    const sink: OperatorEventSink = {
      async onProgress(event) {
        events.push({ kind: event.stream, value: event.chunk });
      },
      async onResult(event) {
        events.push({ kind: event.success ? 'success' : 'failure', value: event.output });
      },
    };

    const executor = createOperatorExecutor({
      reporter: sink,
      spawnImpl(file, args, options) {
        expect(file).toBe('/usr/local/lib/ariadne/deploy');
        expect(args).toEqual(['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
        expect(options.env).toEqual(DEFAULT_EXEC_ENV);
        expect(options.shell).toBe(false);
        expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);

        const child = new FakeChildProcess();
        process.nextTick(() => {
          child.stdout.write('deploy started\n');
          child.stderr.write('warn\n');
          setTimeout(() => {
            child.stdout.write('complete\n');
            child.finish(0);
          }, 5);
        });

        return child;
      },
    });

    await executor.execute({
      operationId: 'op-deployment-apply',
      type: 'deployment_apply',
      revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });

    expect(events).toEqual([
      { kind: 'stdout', value: 'deploy started\n' },
      { kind: 'stderr', value: 'warn\n' },
      { kind: 'stdout', value: 'complete\n' },
      { kind: 'success', value: 'deploy started\nwarn\ncomplete\n' },
    ]);
  });

  it('maps service restarts and backup operations without shell strings', async () => {
    const invocations: Array<{ file: string; args: readonly string[] }> = [];
    const executor = createOperatorExecutor({
      spawnImpl(file, args) {
        invocations.push({ file, args });
        const child = new FakeChildProcess();
        process.nextTick(() => child.finish(0));
        return child;
      },
    });

    await executor.execute({
      operationId: 'op-restart-postgres',
      type: 'service_restart',
      service: 'postgres',
    });

    await executor.execute({
      operationId: 'op-backup-verify',
      type: 'backup_verify',
      backupName: 'backup-2026-09-21.dump',
    });

    await executor.execute({
      operationId: 'op-backup-restore',
      type: 'backup_restore',
      backupName: 'backup-2026-09-21.dump',
    });

    expect(invocations).toEqual([
      { file: '/usr/local/lib/ariadne/restart-postgres', args: [] },
      {
        file: '/usr/local/lib/ariadne/verify-backup',
        args: ['backup-2026-09-21.dump'],
      },
      {
        file: '/usr/local/lib/ariadne/restore-backup',
        args: ['backup-2026-09-21.dump'],
      },
    ]);
  });

  it('streams chatty output beyond 256 KiB without aborting the operation', async () => {
    const line = `${'y'.repeat(1023)}\n`;
    const lineCount = 400;
    const totalBytes = line.length * lineCount;
    expect(totalBytes).toBeGreaterThan(DEFAULT_OUTPUT_TAIL_BYTES);

    let progressBytes = 0;
    let result: { success: boolean; output: string; truncated: boolean } | undefined;

    const executor = createOperatorExecutor({
      reporter: {
        onProgress(event) {
          progressBytes += Buffer.byteLength(event.chunk);
        },
        onResult(event) {
          result = {
            success: event.success,
            output: event.output,
            truncated: event.truncated,
          };
        },
      },
      spawnImpl() {
        const child = new FakeChildProcess();
        process.nextTick(() => {
          for (let index = 0; index < lineCount; index += 1) {
            child.stdout.write(line);
          }
          child.finish(0);
        });
        return child;
      },
    });

    await expect(
      executor.execute({ operationId: 'op-chatty', type: 'backup_create' }),
    ).resolves.toBeUndefined();

    expect(progressBytes).toBe(totalBytes);
    expect(result?.success).toBe(true);
    expect(result?.truncated).toBe(true);
    expect(Buffer.byteLength(result?.output ?? '')).toBeLessThanOrEqual(DEFAULT_OUTPUT_TAIL_BYTES);
    expect(result?.output.endsWith(line)).toBe(true);
  });

  it('terminates the process on timeout and reports a failed result', async () => {
    let spawned: FakeChildProcess | undefined;
    let result: { success: boolean; signal: NodeJS.Signals | null } | undefined;

    const executor = createOperatorExecutor({
      timeoutMs: 20,
      killGraceMs: 10,
      reporter: {
        onResult(event) {
          result = { success: event.success, signal: event.signal };
        },
      },
      spawnImpl() {
        spawned = new FakeChildProcess();
        return spawned;
      },
    });

    const execution = executor.execute({ operationId: 'op-timeout', type: 'backup_create' });

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(spawned?.killSignals).toContain('SIGTERM');
    expect(spawned?.killSignals).toContain('SIGKILL');

    spawned?.finish(null, 'SIGKILL');

    await expect(execution).rejects.toThrowError(/timed out/i);
    expect(result?.success).toBe(false);
    expect(result?.signal).toBe('SIGKILL');
    expect(DEFAULT_EXEC_TIMEOUT_MS).toBe(15 * 60 * 1000);
  });

  it('reports to a per-execution reporter passed by the caller', async () => {
    const executor = createOperatorExecutor({
      spawnImpl() {
        const child = new FakeChildProcess();
        process.nextTick(() => {
          child.stdout.write('ok\n');
          child.finish(0);
        });
        return child;
      },
    });

    const events: string[] = [];
    await executor.execute(
      { operationId: 'op-scoped-reporter', type: 'backup_create' },
      {
        onProgress: (event) => {
          events.push(`progress:${event.chunk.trim()}`);
        },
        onResult: (event) => {
          events.push(`result:${String(event.success)}`);
        },
      },
    );

    expect(events).toEqual(['progress:ok', 'result:true']);
  });
});
