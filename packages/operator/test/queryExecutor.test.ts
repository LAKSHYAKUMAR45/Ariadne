import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  createOperatorQueryExecutor,
  DEFAULT_QUERY_ENV,
  OperatorQueryError,
  type QueryFileSystem,
} from '../src/queryExecutor.js';
import { decodeOperatorLogCursor } from '../src/queryProtocol.js';

class FakeChildProcess extends EventEmitter {
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

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function createMemoryFileSystem(seed: {
  files?: Record<string, string>;
  statSizes?: Record<string, number>;
  statfs?: Record<string, { bsize: number; blocks: number; bfree: number }>;
} = {}): QueryFileSystem {
  const files = new Map(Object.entries(seed.files ?? {}));
  const statSizes = new Map(Object.entries(seed.statSizes ?? {}));
  const statfs = new Map(Object.entries(seed.statfs ?? {}));
  const reads = new Map<string, number>();

  return {
    async readFile(filePath: string): Promise<string> {
      const count = reads.get(filePath) ?? 0;
      reads.set(filePath, count + 1);

      const sequenced = files.get(`${filePath}#${count}`);
      if (sequenced !== undefined) {
        return sequenced;
      }

      const value = files.get(filePath);
      if (value === undefined) {
        const error = new Error(`ENOENT: ${filePath}`) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return value;
    },
    async stat(filePath: string): Promise<{ isFile(): boolean; size: number }> {
      const size = statSizes.get(filePath);
      if (size === undefined) {
        const error = new Error(`ENOENT: ${filePath}`) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return {
        isFile: () => true,
        size,
      };
    },
    async statfs(filePath: string): Promise<{ bsize: number; blocks: number; bfree: number }> {
      const value = statfs.get(filePath);
      if (!value) {
        const error = new Error(`ENOENT: ${filePath}`) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return value;
    },
    createReadStream(filePath: string): NodeJS.ReadableStream {
      const value = files.get(filePath);
      if (value === undefined) {
        throw new Error(`missing file: ${filePath}`);
      }
      return Readable.from(Buffer.from(value, 'utf8'));
    },
  };
}

describe('createOperatorQueryExecutor', () => {
  it('reads /proc metrics and filesystem totals from fixed paths', async () => {
    const fileSystem = createMemoryFileSystem({
      files: {
        '/proc/stat': 'cpu  200 0 100 700 0 0 0 0 0 0\n',
        '/proc/meminfo': 'MemTotal:       2048 kB\nMemAvailable:   1024 kB\n',
      },
      statfs: {
        '/': { bsize: 4096, blocks: 100, bfree: 25 },
      },
    });

    const executor = createOperatorQueryExecutor({ fileSystem });
    const result = await executor.execute({ type: 'host_metrics' });

    expect(result).toEqual({
      type: 'host_metrics',
      value: {
        cpuPercent: 30,
        memoryUsedBytes: 1024 * 1024,
        memoryTotalBytes: 2048 * 1024,
        filesystemUsedBytes: 75 * 4096,
        filesystemTotalBytes: 100 * 4096,
      },
    });
  });

  it('runs fixed status and systemctl commands for service status', async () => {
    const invocations: Array<{ file: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const executor = createOperatorQueryExecutor({
      fileSystem: createMemoryFileSystem(),
      spawnImpl(file, args, options) {
        invocations.push({ file, args, env: options.env });
        const child = new FakeChildProcess();
        process.nextTick(() => {
          if (file === '/usr/local/lib/ariadne/status') {
            child.stdout.write(
              JSON.stringify({
                services: [
                  { name: 'sync-server', state: 'running' },
                  { name: 'operator', state: 'stopped' },
                  { name: 'postgres', state: 'failed', detail: 'compose-exit' },
                ],
              }),
            );
          } else {
            child.stdout.write('active\nrunning\nsuccess\n');
          }
          child.finish(0);
        });
        return child;
      },
    });

    const result = await executor.execute({ type: 'service_status' });

    expect(result).toEqual({
      type: 'service_status',
      value: {
        services: [
          { name: 'sync-server', state: 'running' },
          { name: 'operator', state: 'running' },
          { name: 'postgres', state: 'failed', detail: 'compose-exit' },
        ],
      },
    });
    expect(invocations).toEqual([
      {
        file: '/usr/local/lib/ariadne/status',
        args: [],
        env: DEFAULT_QUERY_ENV,
      },
      {
        file: '/usr/bin/systemctl',
        args: ['show', '--property=ActiveState,SubState,Result', '--value', 'ariadne-operator.service'],
        env: DEFAULT_QUERY_ENV,
      },
    ]);
  });

  it('reads deployment status from the tracked fixed script', async () => {
    const executor = createOperatorQueryExecutor({
      fileSystem: createMemoryFileSystem(),
      spawnImpl(file, args, options) {
        expect(file).toBe('/usr/local/lib/ariadne/deployment-status');
        expect(args).toEqual([]);
        expect(options.env).toEqual(DEFAULT_QUERY_ENV);

        const child = new FakeChildProcess();
        process.nextTick(() => {
          child.stdout.write(
            JSON.stringify({
              currentRevision: 'a'.repeat(40),
              rollbackRevision: 'b'.repeat(40),
              schemaVersion: 10,
              candidates: [
                {
                  revision: 'c'.repeat(40),
                  committedAt: '2026-09-23T09:00:00Z',
                  subject: 'feat: ready',
                },
              ],
            }),
          );
          child.finish(0);
        });
        return child;
      },
    });

    const result = await executor.execute({ type: 'deployment_status' });
    expect(result).toEqual({
      type: 'deployment_status',
      value: {
        currentRevision: 'a'.repeat(40),
        rollbackRevision: 'b'.repeat(40),
        schemaVersion: 10,
        candidates: [
          {
            revision: 'c'.repeat(40),
            committedAt: '2026-09-23T09:00:00Z',
            subject: 'feat: ready',
          },
        ],
      },
    });
  });

  it('maps fixed journal sources, strips ANSI, redacts secrets, truncates lines, and emits opaque cursors', async () => {
    const executor = createOperatorQueryExecutor({
      fileSystem: createMemoryFileSystem(),
      maxLogLineBytes: 64,
      spawnImpl(file, args, options) {
        expect(file).toBe('/usr/bin/journalctl');
        expect(args).toEqual([
          '--no-pager',
          '--output',
          'json',
          '--utc',
          '--unit',
          'ariadne-backup.service',
        ]);
        expect(options.shell).toBe(false);

        const child = new FakeChildProcess();
        process.nextTick(() => {
          child.stdout.write(
            `${JSON.stringify({
              __REALTIME_TIMESTAMP: '1727086800000000',
              PRIORITY: '3',
              MESSAGE:
                '\u001b[31mAuthorization: Bearer super-secret-token /etc/ariadne/sync-server.env\u001b[0m',
            })}\n`,
          );
          child.stdout.write(
            `${JSON.stringify({
              __REALTIME_TIMESTAMP: '1727086800000000',
              PRIORITY: '6',
              MESSAGE: `line ${'x'.repeat(200)}`,
            })}\n`,
          );
          child.finish(0);
        });
        return child;
      },
    });

    const result = await executor.execute({ type: 'logs_read', source: 'backup', limit: 2 });
    expect(result.type).toBe('logs_read');
    expect(result.value.entries).toEqual([
      {
        sequence: 0,
        timestamp: '2024-09-23T10:20:00.000Z',
        severity: 'error',
        message: 'Authorization: [REDACTED] [REDACTED]',
        redacted: true,
      },
      {
        sequence: 1,
        timestamp: '2024-09-23T10:20:00.000Z',
        severity: 'info',
        message: `line ${'x'.repeat(59)}`,
        redacted: false,
      },
    ]);
    expect(result.value.nextCursor).toBeTruthy();
    expect(decodeOperatorLogCursor(result.value.nextCursor ?? '')).toEqual({
      timestamp: '2024-09-23T10:20:00.000Z',
      sequence: 1,
    });
  });

  it('caps log responses by bytes and filters by severity and cursor', async () => {
    const cursor = Buffer.from(
      JSON.stringify({ timestamp: '2024-09-23T10:20:00.000Z', sequence: 0 }),
      'utf8',
    ).toString('base64url');

    const executor = createOperatorQueryExecutor({
      fileSystem: createMemoryFileSystem(),
      maxLogResponseBytes: 260,
      spawnImpl() {
        const child = new FakeChildProcess();
        process.nextTick(() => {
          child.stdout.write(
            `${JSON.stringify({
              __REALTIME_TIMESTAMP: '1727086800000000',
              PRIORITY: '4',
              MESSAGE: 'skip me',
            })}\n`,
          );
          child.stdout.write(
            `${JSON.stringify({
              __REALTIME_TIMESTAMP: '1727086800000000',
              PRIORITY: '4',
              MESSAGE: 'keep first',
            })}\n`,
          );
          child.stdout.write(
            `${JSON.stringify({
              __REALTIME_TIMESTAMP: '1727086860000000',
              PRIORITY: '4',
              MESSAGE: 'keep second but cap stops here',
            })}\n`,
          );
          child.finish(0);
        });
        return child;
      },
    });

    const result = await executor.execute({
      type: 'logs_read',
      source: 'operator',
      cursor,
      limit: 10,
      severity: 'warning',
    });

    expect(result.type).toBe('logs_read');
    expect(result.value.entries).toEqual([
      {
        sequence: 1,
        timestamp: '2024-09-23T10:20:00.000Z',
        severity: 'warning',
        message: 'keep first',
        redacted: false,
      },
    ]);
    expect(decodeOperatorLogCursor(result.value.nextCursor ?? '')).toEqual({
      timestamp: '2024-09-23T10:20:00.000Z',
      sequence: 1,
    });
  });

  it('treats offset-based since and cursor instants as equal to normalized journal timestamps', async () => {
    const executor = createOperatorQueryExecutor({
      fileSystem: createMemoryFileSystem(),
      spawnImpl() {
        const child = new FakeChildProcess();
        process.nextTick(() => {
          child.stdout.write(
            `${JSON.stringify({
              __REALTIME_TIMESTAMP: '1727086815000000',
              PRIORITY: '6',
              MESSAGE: 'before-offset-since',
            })}\n`,
          );
          child.stdout.write(
            `${JSON.stringify({
              __REALTIME_TIMESTAMP: '1727086845000000',
              PRIORITY: '6',
              MESSAGE: 'after-offset-since',
            })}\n`,
          );
          child.stdout.write(
            `${JSON.stringify({
              __REALTIME_TIMESTAMP: '1727086860000000',
              PRIORITY: '6',
              MESSAGE: 'same-instant-cursor-sequence-0',
            })}\n`,
          );
          child.stdout.write(
            `${JSON.stringify({
              __REALTIME_TIMESTAMP: '1727086860000000',
              PRIORITY: '6',
              MESSAGE: 'same-instant-cursor-sequence-1',
            })}\n`,
          );
          child.stdout.write(
            `${JSON.stringify({
              __REALTIME_TIMESTAMP: '1727086920000000',
              PRIORITY: '6',
              MESSAGE: 'after-offset-cursor',
            })}\n`,
          );
          child.finish(0);
        });
        return child;
      },
    });

    const result = await executor.execute({
      type: 'logs_read',
      source: 'operator',
      limit: 10,
      since: '2024-09-23T12:20:30+02:00',
      cursor: Buffer.from(
        JSON.stringify({ timestamp: '2024-09-23T12:21:00+02:00', sequence: 0 }),
        'utf8',
      ).toString('base64url'),
    });

    expect(result.type).toBe('logs_read');
    expect(result.value.entries).toEqual([
      {
        sequence: 1,
        timestamp: '2024-09-23T10:21:00.000Z',
        severity: 'info',
        message: 'same-instant-cursor-sequence-1',
        redacted: false,
      },
      {
        sequence: 0,
        timestamp: '2024-09-23T10:22:00.000Z',
        severity: 'info',
        message: 'after-offset-cursor',
        redacted: false,
      },
    ]);
  });

  it('passes a normalized journalctl lower bound derived from since and cursor', async () => {
    const invocations: Array<readonly string[]> = [];
    const executor = createOperatorQueryExecutor({
      fileSystem: createMemoryFileSystem(),
      spawnImpl(_file, args) {
        invocations.push(args);
        const child = new FakeChildProcess();
        process.nextTick(() => child.finish(0));
        return child;
      },
    });

    await executor.execute({
      type: 'logs_read',
      source: 'deployment',
      limit: 100,
      since: '2024-09-23T12:20:00+02:00',
      cursor: Buffer.from(
        JSON.stringify({ timestamp: '2024-09-23T12:21:00+02:00', sequence: 3 }),
        'utf8',
      ).toString('base64url'),
    });

    expect(invocations).toEqual([
      [
        '--no-pager',
        '--output',
        'json',
        '--utc',
        '--unit',
        'ariadne-operator.service',
        '--identifier',
        'ariadne-deploy',
        '--since',
        '2024-09-23T10:21:00.000Z',
      ],
    ]);
  });

  it('verifies backup metadata and returns a readable stream without exposing its path', async () => {
    const dumpPath = '/var/backups/ariadne/ariadne-20260923T032200Z.dump';
    const dumpContents = 'backup-bytes';
    const sha256 = digest(dumpContents);
    const fileSystem = createMemoryFileSystem({
      files: {
        [dumpPath]: dumpContents,
        '/var/backups/ariadne/ariadne-20260923T032200Z.sha256': `${sha256}  ariadne-20260923T032200Z.dump\n`,
        '/var/backups/ariadne/ariadne-20260923T032200Z.json': JSON.stringify({
          basename: 'ariadne-20260923T032200Z.dump',
          timestamp: '20260923T032200Z',
          database: 'ariadne_sync',
          image: 'sha256:1234',
          schemaVersion: '0010_admin_console.sql',
          dumpBytes: Buffer.byteLength(dumpContents, 'utf8'),
          sha256,
          activeKeyId: 'primary',
          keyIds: ['primary'],
          format: 'custom',
        }),
      },
      statSizes: {
        [dumpPath]: Buffer.byteLength(dumpContents, 'utf8'),
      },
    });

    const executor = createOperatorQueryExecutor({ fileSystem });
    const result = await executor.execute({
      type: 'backup_read',
      backupName: 'ariadne-20260923T032200Z.dump',
    });

    expect(result.type).toBe('backup_read');
    expect(result.value.filename).toBe('ariadne-20260923T032200Z.dump');
    expect(result.value.sha256).toBe(sha256);
    expect(result.value.sizeBytes).toBe(Buffer.byteLength(dumpContents, 'utf8'));
    expect('path' in result.value).toBe(false);
    await expect(readableToString(result.value.stream)).resolves.toBe(dumpContents);
  });

  it('throws typed dependency errors for timeout, failed commands, malformed JSON, and unavailable sources', async () => {
    const timeoutExecutor = createOperatorQueryExecutor({
      fileSystem: createMemoryFileSystem(),
      timeoutMs: 10,
      spawnImpl() {
        return new FakeChildProcess();
      },
    });
    await expect(timeoutExecutor.execute({ type: 'service_status' })).rejects.toMatchObject({
      code: 'command_timeout',
    } satisfies Partial<OperatorQueryError>);

    const failedExecutor = createOperatorQueryExecutor({
      fileSystem: createMemoryFileSystem(),
      spawnImpl() {
        const child = new FakeChildProcess();
        process.nextTick(() => {
          child.stderr.write('/etc/ariadne/compose.env\n');
          child.finish(1);
        });
        return child;
      },
    });
    await expect(failedExecutor.execute({ type: 'deployment_status' })).rejects.toMatchObject({
      code: 'command_failed',
    } satisfies Partial<OperatorQueryError>);
    await failedExecutor.execute({ type: 'deployment_status' }).catch((error: unknown) => {
      expect(error).toBeInstanceOf(OperatorQueryError);
      expect((error as Error).message).not.toContain('/etc/ariadne/compose.env');
    });

    const malformedExecutor = createOperatorQueryExecutor({
      fileSystem: createMemoryFileSystem(),
      spawnImpl() {
        const child = new FakeChildProcess();
        process.nextTick(() => {
          child.stdout.write('{bad json');
          child.finish(0);
        });
        return child;
      },
    });
    await expect(malformedExecutor.execute({ type: 'service_status' })).rejects.toMatchObject({
      code: 'invalid_result',
    } satisfies Partial<OperatorQueryError>);

    const unavailableExecutor = createOperatorQueryExecutor({
      fileSystem: createMemoryFileSystem(),
      spawnImpl() {
        const error = new Error('missing binary') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      },
    });
    await expect(unavailableExecutor.execute({ type: 'service_status' })).rejects.toMatchObject({
      code: 'dependency_unavailable',
    } satisfies Partial<OperatorQueryError>);
  });
});

async function readableToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
