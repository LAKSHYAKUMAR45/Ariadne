import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createOperatorServer } from '../src/server.js';

describe('operator server lifecycle errors', () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirectories.map(async (directory) => {
        await rm(directory, { recursive: true, force: true });
      }),
    );
    tempDirectories.length = 0;
  });

  async function createTempDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ariadne-operator-lifecycle-'));
    tempDirectories.push(directory);
    return directory;
  }

  it('keeps an error handler attached after listen and reports through onError', async () => {
    const directory = await createTempDirectory();
    const socketPath = path.join(directory, 'operator.sock');
    const reported: Error[] = [];

    const server = createOperatorServer({
      socketPath,
      onError: (error) => {
        reported.push(error);
      },
    });

    await server.start();

    try {
      // Node emits `error` on the server object itself for post-listen
      // failures (for example EMFILE on accept). Without a persistent handler
      // this would be an unhandled 'error' event and would take the process
      // down with it.
      expect(server.httpServer.listenerCount('error')).toBeGreaterThan(0);

      const failure: NodeJS.ErrnoException = new Error(
        `accept failed on ${socketPath} for token a${'b'.repeat(63)}`,
      );
      failure.code = 'EMFILE';

      expect(() => server.httpServer.emit('error', failure)).not.toThrow();

      expect(reported).toHaveLength(1);
      expect(reported[0].message).toContain('EMFILE');
      expect(reported[0].message).not.toContain(socketPath);
      expect(reported[0].message).not.toContain(directory);
      expect(reported[0].message).not.toContain('b'.repeat(63));
    } finally {
      await server.close();
    }
  });

  it('reports an unknown code without leaking the underlying message', async () => {
    const directory = await createTempDirectory();
    const socketPath = path.join(directory, 'operator.sock');
    const reported: Error[] = [];

    const server = createOperatorServer({
      socketPath,
      onError: (error) => {
        reported.push(error);
      },
    });

    await server.start();

    try {
      server.httpServer.emit('error', new Error('/run/ariadne/secret-detail'));
      expect(reported).toHaveLength(1);
      expect(reported[0].message).toContain('unknown');
      expect(reported[0].message).not.toContain('/run/ariadne/secret-detail');
    } finally {
      await server.close();
    }
  });

  it('survives a post-listen error when no onError is injected', async () => {
    const directory = await createTempDirectory();
    const server = createOperatorServer({ socketPath: path.join(directory, 'operator.sock') });

    await server.start();

    try {
      expect(() => server.httpServer.emit('error', new Error('boom'))).not.toThrow();
    } finally {
      await server.close();
    }
  });

  it('still rejects start() when listen itself fails', async () => {
    const directory = await createTempDirectory();
    const reported: Error[] = [];
    const server = createOperatorServer({
      socketPath: path.join(directory, 'missing-parent', 'operator.sock'),
      onError: (error) => {
        reported.push(error);
      },
    });

    await expect(server.start()).rejects.toThrowError();
    expect(reported).toHaveLength(0);
  });
});
