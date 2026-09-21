import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXEC_ENV,
  DEFAULT_EXEC_MAX_BUFFER_BYTES,
  DEFAULT_EXEC_TIMEOUT_MS,
  createOperatorExecutor,
  type OperatorEventSink,
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
      execFileImpl(file, args, options, callback) {
        expect(file).toBe('/usr/local/lib/ariadne/deploy');
        expect(args).toEqual(['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
        expect(options.timeout).toBe(DEFAULT_EXEC_TIMEOUT_MS);
        expect(options.maxBuffer).toBe(DEFAULT_EXEC_MAX_BUFFER_BYTES);
        expect(options.env).toEqual(DEFAULT_EXEC_ENV);
        expect(options.shell).toBe(false);

        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const child = {
          stdout,
          stderr,
        };

        process.nextTick(() => {
          stdout.write('deploy started\n');
          stderr.write('warn\n');
          stdout.end();
          stderr.end();
          callback(null, 'deploy started\ncomplete\n', 'warn\n');
        });

        return child as never;
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
      { kind: 'success', value: 'deploy started\ncomplete\nwarn\n' },
    ]);
  });

  it('maps service restarts and backup operations without shell strings', async () => {
    const invocations: Array<{ file: string; args: readonly string[] }> = [];
    const executor = createOperatorExecutor({
      execFileImpl(file, args, _options, callback) {
        invocations.push({ file, args });
        process.nextTick(() => callback(null, '', ''));
        return { stdout: new PassThrough(), stderr: new PassThrough() } as never;
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
});
