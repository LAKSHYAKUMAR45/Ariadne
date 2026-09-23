import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CALLBACK_TOKEN_HEADER,
  DEFAULT_CALLBACK_TOKEN_PATH,
  MAX_CALLBACK_REQUEST_BODY_BYTES,
  createCallbackReporter,
  createOperatorServer,
  ensureCallbackToken,
  fitCallbackPayload,
  getCallbackConfig,
  getOperatorSocketPath,
  withRestrictiveUmask,
  MAX_OPERATOR_REQUEST_BODY_BYTES,
} from '../src/server.js';
import { DEFAULT_OUTPUT_TAIL_BYTES } from '../src/executor.js';
import { OperatorQueryError } from '../src/queryExecutor.js';

interface HttpResponse {
  statusCode: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

describe('createOperatorServer', () => {
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
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ariadne-operator-test-'));
    tempDirectories.push(directory);
    return directory;
  }

  async function request(socketPath: string, options: {
    method?: string;
    path?: string;
    body?: string;
  } = {}): Promise<HttpResponse> {
    const method = options.method ?? 'POST';
    const requestPath = options.path ?? '/v1/operations';
    const body = options.body ?? '';

    return await new Promise<HttpResponse>((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          method,
          path: requestPath,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
              headers: res.headers,
            });
          });
        },
      );

      req.on('error', reject);
      req.end(body);
    });
  }

  async function waitForFile(filePath: string): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await access(filePath);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    throw new Error(`Timed out waiting for ${filePath}`);
  }

  async function waitForAccepted(socketPath: string, body: string): Promise<HttpResponse> {
    let lastResponse: HttpResponse | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      lastResponse = await request(socketPath, { body });
      if (lastResponse.statusCode === 202) {
        return lastResponse;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error(`Timed out waiting for acceptance, last status was ${lastResponse?.statusCode}`);
  }

  it('requires OPERATOR_SOCKET_PATH to be an absolute path', () => {
    expect(() => getOperatorSocketPath({})).toThrowError(
      'OPERATOR_SOCKET_PATH environment variable is required',
    );

    expect(() => getOperatorSocketPath({ OPERATOR_SOCKET_PATH: 'relative.sock' })).toThrowError(
      'OPERATOR_SOCKET_PATH must be an absolute path',
    );
  });

  it('removes only a stale owned socket and chmods the replacement to 0660', async () => {
    const directory = await createTempDirectory();
    const socketPath = path.join(directory, 'operator.sock');

    await new Promise<void>((resolve, reject) => {
      const staleServer = net.createServer();
      staleServer.once('error', reject);
      staleServer.listen(socketPath, () => {
        staleServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    });

    const server = createOperatorServer({
      socketPath,
      executeOperation: async () => undefined,
    });

    await server.start();
    const socketStats = await stat(socketPath);

    expect(socketStats.isSocket()).toBe(true);
    expect(socketStats.mode & 0o777).toBe(0o660);

    await server.close();
  });

  it('fails closed when the target path is not a Unix socket', async () => {
    const directory = await createTempDirectory();
    const socketPath = path.join(directory, 'operator.sock');
    await writeFile(socketPath, 'not-a-socket', 'utf8');

    const server = createOperatorServer({
      socketPath,
      executeOperation: async () => undefined,
    });

    await expect(server.start()).rejects.toThrowError(
      'Refusing to replace existing non-socket path',
    );
  });

  it('rejects non-POST methods and oversized bodies', async () => {
    const directory = await createTempDirectory();
    const socketPath = path.join(directory, 'operator.sock');
    const server = createOperatorServer({
      socketPath,
      executeOperation: async () => undefined,
    });

    await server.start();

    const methodResponse = await request(socketPath, {
      method: 'GET',
      path: '/v1/operations',
    });
    expect(methodResponse.statusCode).toBe(405);
    expect(JSON.parse(methodResponse.body)).toEqual({ error: 'method_not_allowed' });

    const oversizedPayload = 'x'.repeat(MAX_OPERATOR_REQUEST_BODY_BYTES + 1);
    const bodyResponse = await request(socketPath, {
      body: oversizedPayload,
    });
    expect(bodyResponse.statusCode).toBe(413);
    expect(JSON.parse(bodyResponse.body)).toEqual({ error: 'request_too_large' });

    await server.close();
  });

  it('returns typed JSON query results without reserving the mutation slot', async () => {
    const directory = await createTempDirectory();
    const socketPath = path.join(directory, 'operator.sock');
    const executedOperations: string[] = [];
    let releaseQuery: (() => void) | undefined;

    const server = createOperatorServer({
      socketPath,
      executeOperation: async (operatorRequest) => {
        executedOperations.push(operatorRequest.operationId);
      },
      executeQuery: async () => {
        await new Promise<void>((resolve) => {
          releaseQuery = resolve;
        });
        return {
          type: 'host_metrics',
          value: {
            cpuPercent: 12.5,
            memoryUsedBytes: 10,
            memoryTotalBytes: 20,
            filesystemUsedBytes: 30,
            filesystemTotalBytes: 40,
          },
        };
      },
    });

    await server.start();

    const queryPromise = request(socketPath, {
      path: '/v1/queries',
      body: JSON.stringify({ type: 'host_metrics' }),
    });

    const operationResponse = await request(socketPath, {
      body: JSON.stringify({ operationId: 'op-query-parallel', type: 'backup_create' }),
    });
    expect(operationResponse.statusCode).toBe(202);
    expect(executedOperations).toEqual(['op-query-parallel']);

    releaseQuery?.();
    const queryResponse = await queryPromise;
    expect(queryResponse.statusCode).toBe(200);
    expect(JSON.parse(queryResponse.body)).toEqual({
      type: 'host_metrics',
      value: {
        cpuPercent: 12.5,
        memoryUsedBytes: 10,
        memoryTotalBytes: 20,
        filesystemUsedBytes: 30,
        filesystemTotalBytes: 40,
      },
    });

    await server.close();
  });

  it('streams backup queries with attachment headers', async () => {
    const directory = await createTempDirectory();
    const socketPath = path.join(directory, 'operator.sock');

    const server = createOperatorServer({
      socketPath,
      executeQuery: async () => ({
        type: 'backup_read',
        value: {
          filename: 'ariadne-20260923T032200Z.dump',
          sha256: 'a'.repeat(64),
          sizeBytes: 12,
          stream: Readable.from(['backup-bytes']),
        },
      }),
    });

    await server.start();

    const response = await request(socketPath, {
      path: '/v1/queries',
      body: JSON.stringify({
        type: 'backup_read',
        backupName: 'ariadne-20260923T032200Z.dump',
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('backup-bytes');
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['content-length']).toBe('12');
    expect(response.headers['x-ariadne-backup-sha256']).toBe('a'.repeat(64));
    expect(String(response.headers['content-disposition'])).toContain(
      'filename="ariadne-20260923T032200Z.dump"',
    );

    await server.close();
  });

  it('destroys the backup stream when the client aborts', async () => {
    const directory = await createTempDirectory();
    const socketPath = path.join(directory, 'operator.sock');
    let destroyed = false;

    const stream = new PassThrough({
      destroy(error, callback) {
        destroyed = true;
        callback(error);
      },
    });

    const server = createOperatorServer({
      socketPath,
      executeQuery: async () => ({
        type: 'backup_read',
        value: {
          filename: 'ariadne-20260923T032200Z.dump',
          sha256: 'b'.repeat(64),
          sizeBytes: 1024,
          stream,
        },
      }),
    });

    await server.start();

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          method: 'POST',
          path: '/v1/queries',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(
              JSON.stringify({
                type: 'backup_read',
                backupName: 'ariadne-20260923T032200Z.dump',
              }),
            ),
          },
        },
        (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
        },
      );

      req.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNRESET') {
          return;
        }
        reject(error);
      });

      req.end(
        JSON.stringify({
          type: 'backup_read',
          backupName: 'ariadne-20260923T032200Z.dump',
        }),
      );

      stream.write(Buffer.alloc(128, 'x'));
    });

    for (let attempt = 0; attempt < 50 && !destroyed; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(destroyed).toBe(true);

    await server.close();
  });

  it('returns 400 for invalid queries, 404 for unknown paths, and 503 for unavailable query dependencies', async () => {
    const directory = await createTempDirectory();
    const socketPath = path.join(directory, 'operator.sock');
    const server = createOperatorServer({
      socketPath,
      executeQuery: async () => {
        throw new OperatorQueryError('dependency_unavailable', 'unavailable');
      },
    });

    await server.start();

    const invalid = await request(socketPath, {
      path: '/v1/queries',
      body: JSON.stringify({ type: 'logs_read', source: 'sync-server', limit: 0 }),
    });
    expect(invalid.statusCode).toBe(400);
    expect(JSON.parse(invalid.body)).toEqual({ error: 'invalid_request' });

    const missing = await request(socketPath, {
      path: '/v1/not-here',
      body: JSON.stringify({}),
    });
    expect(missing.statusCode).toBe(404);
    expect(JSON.parse(missing.body)).toEqual({ error: 'not_found' });

    const unavailable = await request(socketPath, {
      path: '/v1/queries',
      body: JSON.stringify({ type: 'host_metrics' }),
    });
    expect(unavailable.statusCode).toBe(503);
    expect(JSON.parse(unavailable.body)).toEqual({ error: 'dependency_unavailable' });

    await server.close();
  });

  it('accepts one operation, returns prior acceptance for duplicates, and rejects concurrent different ids', async () => {
    const directory = await createTempDirectory();
    const socketPath = path.join(directory, 'operator.sock');
    let releaseCurrentOperation: (() => void) | undefined;

    const server = createOperatorServer({
      socketPath,
      executeOperation: async () =>
        await new Promise<void>((resolve) => {
          releaseCurrentOperation = resolve;
        }),
    });

    await server.start();

    const body = JSON.stringify({
      operationId: 'op-1',
      type: 'backup_create',
    });

    const firstResponse = await request(socketPath, { body });
    expect(firstResponse.statusCode).toBe(202);
    expect(JSON.parse(firstResponse.body)).toEqual({
      operationId: 'op-1',
      accepted: true,
    });

    const duplicateResponse = await request(socketPath, { body });
    expect(duplicateResponse.statusCode).toBe(202);
    expect(JSON.parse(duplicateResponse.body)).toEqual({
      operationId: 'op-1',
      accepted: true,
    });

    const busyResponse = await request(socketPath, {
      body: JSON.stringify({
        operationId: 'op-2',
        type: 'backup_create',
      }),
    });
    expect(busyResponse.statusCode).toBe(409);
    expect(JSON.parse(busyResponse.body)).toEqual({ error: 'operator_busy' });

    releaseCurrentOperation?.();
    await server.close();
  });

  it('passes validated requests to the executor and clears the active operation after completion', async () => {
    const directory = await createTempDirectory();
    const socketPath = path.join(directory, 'operator.sock');
    const requests: unknown[] = [];
    const eventsFile = path.join(directory, 'events.log');

    const server = createOperatorServer({
      socketPath,
      executeOperation: async (requestBody) => {
        requests.push(requestBody);
        await writeFile(
          eventsFile,
          JSON.stringify({
            operationId: (requestBody as { operationId: string }).operationId,
            success: true,
          }),
          'utf8',
        );
      },
    });

    await server.start();

    const accepted = await request(socketPath, {
      body: JSON.stringify({
        operationId: 'op-3',
        type: 'deployment_apply',
        revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    });

    expect(accepted.statusCode).toBe(202);
    expect(requests).toEqual([
      {
        operationId: 'op-3',
        type: 'deployment_apply',
        revision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    ]);

    await waitForFile(eventsFile);

    const secondAccepted = await waitForAccepted(
      socketPath,
      JSON.stringify({
        operationId: 'op-4',
        type: 'backup_create',
      }),
    );
    expect(secondAccepted.statusCode).toBe(202);

    expect(JSON.parse(await readFile(eventsFile, 'utf8'))).toMatchObject({
      operationId: 'op-4',
      success: true,
    });

    await server.close();
  });

  it('never re-executes a completed operation id while it is cached as terminal', async () => {
    const directory = await createTempDirectory();
    const socketPath = path.join(directory, 'operator.sock');
    const executed: string[] = [];

    const server = createOperatorServer({
      socketPath,
      executeOperation: async (operatorRequest) => {
        executed.push(operatorRequest.operationId);
      },
    });

    await server.start();

    const body = JSON.stringify({ operationId: 'op-terminal-1', type: 'backup_create' });
    expect((await request(socketPath, { body })).statusCode).toBe(202);

    for (let attempt = 0; attempt < 50 && executed.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(executed).toEqual(['op-terminal-1']);

    const replay = await request(socketPath, { body });
    expect(replay.statusCode).toBe(202);
    expect(JSON.parse(replay.body)).toEqual({ operationId: 'op-terminal-1', accepted: true });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(executed).toEqual(['op-terminal-1']);

    const nextOperation = await request(socketPath, {
      body: JSON.stringify({ operationId: 'op-terminal-2', type: 'backup_create' }),
    });
    expect(nextOperation.statusCode).toBe(202);

    for (let attempt = 0; attempt < 50 && executed.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(executed).toEqual(['op-terminal-1', 'op-terminal-2']);

    await server.close();
  });

  it('bounds the terminal cache by entry count and ttl', async () => {
    const directory = await createTempDirectory();
    const socketPath = path.join(directory, 'operator.sock');
    const executed: string[] = [];

    const server = createOperatorServer({
      socketPath,
      terminalCacheMaxEntries: 1,
      terminalCacheTtlMs: 40,
      executeOperation: async (operatorRequest) => {
        executed.push(operatorRequest.operationId);
      },
    });

    await server.start();

    const first = JSON.stringify({ operationId: 'op-ttl-1', type: 'backup_create' });
    const second = JSON.stringify({ operationId: 'op-ttl-2', type: 'backup_create' });

    await request(socketPath, { body: first });
    for (let attempt = 0; attempt < 50 && executed.length < 1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await waitForAccepted(socketPath, second);
    for (let attempt = 0; attempt < 50 && executed.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(executed).toEqual(['op-ttl-1', 'op-ttl-2']);

    await new Promise((resolve) => setTimeout(resolve, 60));

    await waitForAccepted(socketPath, first);
    for (let attempt = 0; attempt < 50 && executed.length < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(executed).toEqual(['op-ttl-1', 'op-ttl-2', 'op-ttl-1']);

    await server.close();
  });

  it('rejects an oversized declared body immediately without draining it', async () => {
    const directory = await createTempDirectory();
    const socketPath = path.join(directory, 'operator.sock');
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on('unhandledRejection', onUnhandled);

    const server = createOperatorServer({
      socketPath,
      executeOperation: async () => undefined,
    });

    await server.start();

    const declaredBytes = MAX_OPERATOR_REQUEST_BODY_BYTES * 64;
    let sentBytes = 0;

    const response = await new Promise<HttpResponse>((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          method: 'POST',
          path: '/v1/operations',
          headers: {
            'content-type': 'application/json',
            'content-length': declaredBytes,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        },
      );

      req.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNRESET' || error.code === 'EPIPE') {
          return;
        }
        reject(error);
      });

      const chunk = 'x'.repeat(1024);
      const timer = setInterval(() => {
        if (sentBytes >= declaredBytes || req.destroyed || req.writableEnded) {
          clearInterval(timer);
          return;
        }
        sentBytes += chunk.length;
        req.write(chunk, () => undefined);
      }, 5);
      timer.unref?.();
    });

    expect(response.statusCode).toBe(413);
    expect(JSON.parse(response.body)).toEqual({ error: 'request_too_large' });
    expect(sentBytes).toBeLessThan(declaredBytes);

    await new Promise((resolve) => setTimeout(resolve, 50));
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);

    await server.close();
  });

  it('configures explicit header and request timeouts', async () => {
    const directory = await createTempDirectory();
    const socketPath = path.join(directory, 'operator.sock');
    const server = createOperatorServer({
      socketPath,
      headersTimeoutMs: 150,
      requestTimeoutMs: 300,
      executeOperation: async () => undefined,
    });

    await server.start();

    expect(server.headersTimeoutMs).toBe(150);
    expect(server.requestTimeoutMs).toBe(300);

    const closedBeforeCompletion = await new Promise<boolean>((resolve, reject) => {
      const socket = net.createConnection({ path: socketPath });
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 3000);

      const received: Buffer[] = [];
      socket.on('connect', () => {
        socket.write('POST /v1/operations HTTP/1.1\r\nHost: operator\r\n');
      });
      socket.on('data', (chunk) => {
        received.push(Buffer.from(chunk));
      });
      socket.on('close', () => {
        clearTimeout(timer);
        resolve(Buffer.concat(received).toString('utf8').startsWith('HTTP/1.1 408'));
      });
      socket.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNRESET' || error.code === 'EPIPE') {
          return;
        }
        clearTimeout(timer);
        reject(error);
      });
    });

    expect(closedBeforeCompletion).toBe(true);

    await server.close();
  });

  it('creates the socket under a restrictive umask that is always restored', async () => {
    const directory = await createTempDirectory();
    const probePath = path.join(directory, 'probe');

    const before = process.umask();
    const observed = await withRestrictiveUmask(async () => {
      await writeFile(probePath, 'probe', 'utf8');
      return process.umask();
    });
    expect(process.umask()).toBe(before);
    expect(observed).toBe(0o177);
    expect((await stat(probePath)).mode & 0o777).toBe(0o600);

    await expect(
      withRestrictiveUmask(async () => {
        throw new Error('umask-failure');
      }),
    ).rejects.toThrowError('umask-failure');
    expect(process.umask()).toBe(before);

    const socketPath = path.join(directory, 'operator.sock');
    const server = createOperatorServer({
      socketPath,
      executeOperation: async () => undefined,
    });

    await server.start();
    expect(process.umask()).toBe(before);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o660);

    await server.close();
  });

  it('gives an injected executor the configured event sink so it can report', async () => {
    const directory = await createTempDirectory();
    const socketPath = path.join(directory, 'operator.sock');
    const reported: string[] = [];

    const server = createOperatorServer({
      socketPath,
      reporter: {
        onProgress: (event) => {
          reported.push(`progress:${event.operationId}:${event.chunk.trim()}`);
        },
        onResult: (event) => {
          reported.push(`result:${event.operationId}:${String(event.success)}`);
        },
      },
      executeOperation: async (operatorRequest, sink) => {
        await sink.onProgress?.({
          operationId: operatorRequest.operationId,
          stream: 'stdout',
          chunk: 'injected\n',
        });
        await sink.onResult?.({
          operationId: operatorRequest.operationId,
          success: true,
          output: 'injected\n',
          exitCode: 0,
          signal: null,
          truncated: false,
        });
      },
    });

    await server.start();

    const accepted = await request(socketPath, {
      body: JSON.stringify({ operationId: 'op-injected', type: 'backup_create' }),
    });
    expect(accepted.statusCode).toBe(202);

    for (let attempt = 0; attempt < 50 && reported.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(reported).toEqual([
      'progress:op-injected:injected',
      'result:op-injected:true',
    ]);

    await server.close();
  });
  it('admits exactly one of two simultaneous distinct operations', async () => {
    const directory = await createTempDirectory();
    const socketPath = path.join(directory, 'operator.sock');
    const executed: string[] = [];
    const releases: Array<() => void> = [];

    const server = createOperatorServer({
      socketPath,
      executeOperation: async (operatorRequest) => {
        executed.push(operatorRequest.operationId);
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
      },
    });

    await server.start();

    // Both requests are dispatched before either response is read, so the
    // admission decision has to be atomic across the awaited body parsing.
    const [firstResponse, secondResponse] = await Promise.all([
      request(socketPath, {
        body: JSON.stringify({ operationId: 'op-race-1', type: 'backup_create' }),
      }),
      request(socketPath, {
        body: JSON.stringify({ operationId: 'op-race-2', type: 'backup_create' }),
      }),
    ]);

    const statuses = [firstResponse.statusCode, secondResponse.statusCode].sort();
    expect(statuses).toEqual([202, 409]);

    const busyResponse = firstResponse.statusCode === 409 ? firstResponse : secondResponse;
    expect(JSON.parse(busyResponse.body)).toEqual({ error: 'operator_busy' });

    const acceptedResponse = firstResponse.statusCode === 202 ? firstResponse : secondResponse;
    const acceptedId = (JSON.parse(acceptedResponse.body) as { operationId: string }).operationId;

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(executed).toEqual([acceptedId]);

    const rejectedId = acceptedId === 'op-race-1' ? 'op-race-2' : 'op-race-1';

    // The rejected id was never reserved nor cached as terminal, so it must be
    // executable once the operator is idle again.
    releases.forEach((release) => release());
    const retry = await waitForAccepted(
      socketPath,
      JSON.stringify({ operationId: rejectedId, type: 'backup_create' }),
    );
    expect(retry.statusCode).toBe(202);

    for (let attempt = 0; attempt < 50 && executed.length < 2; attempt += 1) {
      releases.forEach((release) => release());
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(executed).toEqual([acceptedId, rejectedId]);

    releases.forEach((release) => release());
    await server.close();
  });

  it('serializes duplicate simultaneous requests into a single execution', async () => {
    const directory = await createTempDirectory();
    const socketPath = path.join(directory, 'operator.sock');
    const executed: string[] = [];
    const releases: Array<() => void> = [];

    const server = createOperatorServer({
      socketPath,
      executeOperation: async (operatorRequest) => {
        executed.push(operatorRequest.operationId);
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
      },
    });

    await server.start();

    const body = JSON.stringify({ operationId: 'op-dup-race', type: 'backup_create' });
    const responses = await Promise.all([
      request(socketPath, { body }),
      request(socketPath, { body }),
      request(socketPath, { body }),
    ]);

    for (const response of responses) {
      expect(response.statusCode).toBe(202);
      expect(JSON.parse(response.body)).toEqual({
        operationId: 'op-dup-race',
        accepted: true,
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(executed).toEqual(['op-dup-race']);

    releases.forEach((release) => release());
    await server.close();
  });

  it('never reserves an operation id for a request that fails validation', async () => {
    const directory = await createTempDirectory();
    const socketPath = path.join(directory, 'operator.sock');
    const executed: string[] = [];

    const server = createOperatorServer({
      socketPath,
      executeOperation: async (operatorRequest) => {
        executed.push(operatorRequest.operationId);
      },
    });

    await server.start();

    const invalid = await request(socketPath, {
      body: JSON.stringify({
        operationId: 'op-invalid',
        type: 'backup_create',
        unexpected: true,
      }),
    });
    expect(invalid.statusCode).toBe(400);
    expect(JSON.parse(invalid.body)).toEqual({ error: 'invalid_request' });

    const malformed = await request(socketPath, { body: '{' });
    expect(malformed.statusCode).toBe(400);
    expect(JSON.parse(malformed.body)).toEqual({ error: 'invalid_json' });

    // A failed validation must not have reserved `op-invalid`, so the same id
    // is still admissible and executable once it is sent correctly.
    const accepted = await request(socketPath, {
      body: JSON.stringify({ operationId: 'op-invalid', type: 'backup_create' }),
    });
    expect(accepted.statusCode).toBe(202);

    for (let attempt = 0; attempt < 50 && executed.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(executed).toEqual(['op-invalid']);

    await server.close();
  });
});

describe('operator callback channel', () => {
  const tempDirectories: string[] = [];
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
          }),
      ),
    );
    await Promise.all(
      tempDirectories.splice(0).map(async (directory) => {
        await rm(directory, { recursive: true, force: true });
      }),
    );
  });

  async function createTempDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ariadne-callback-test-'));
    tempDirectories.push(directory);
    return directory;
  }

  interface RecordedCallback {
    url: string;
    method: string;
    token: string | undefined;
    body: unknown;
    /** Serialized request size, which is what the size ceilings actually bound. */
    byteLength: number;
  }

  interface CallbackSink {
    baseUrl: string;
    received: RecordedCallback[];
    status: number;
    /** Per-request status override, for exercising the 413 retry path. */
    statusFor?(recorded: RecordedCallback): number;
    /** Destroys this many connections before answering, modelling a restart. */
    destroyNextRequests: number;
  }

  async function startCallbackSink(): Promise<CallbackSink> {
    const received: RecordedCallback[] = [];
    const sink: Partial<CallbackSink> & {
      received: RecordedCallback[];
      status: number;
      destroyNextRequests: number;
    } = {
      received,
      status: 200,
      destroyNextRequests: 0,
    };

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
        const recorded: RecordedCallback = {
          url: req.url ?? '',
          method: req.method ?? '',
          token: req.headers[CALLBACK_TOKEN_HEADER] as string | undefined,
          body: parsed,
          byteLength: Buffer.byteLength(text, 'utf8'),
        };
        if (sink.destroyNextRequests > 0) {
          sink.destroyNextRequests -= 1;
          req.destroy();
          res.destroy();
          return;
        }
        received.push(recorded);
        res.statusCode = sink.statusFor?.(recorded) ?? sink.status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: res.statusCode < 400 }));
      });
    });
    servers.push(server);

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    const address = server.address();
    if (typeof address === 'string' || address === null) {
      throw new Error('Callback sink did not bind a TCP port');
    }
    sink.baseUrl = `http://127.0.0.1:${address.port}/api/v1/admin/operations`;
    return sink as CallbackSink;
  }

  it('creates a 32-byte callback token readable only by the web group', async () => {
    const directory = await createTempDirectory();
    const tokenPath = path.join(directory, 'operator-callback-token');

    const token = await ensureCallbackToken(tokenPath);
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const stats = await stat(tokenPath);
    expect(stats.mode & 0o7777).toBe(0o640);

    // A second start must reuse the token the web tier already holds.
    expect(await ensureCallbackToken(tokenPath)).toBe(token);
  });

  it('refuses a token that any other account could read or write', async () => {
    const directory = await createTempDirectory();
    const tokenPath = path.join(directory, 'operator-callback-token');
    const token = 'a'.repeat(64);
    await writeFile(tokenPath, token, { mode: 0o644 });

    await expect(ensureCallbackToken(tokenPath)).rejects.toThrow(/mode/i);
    await expect(ensureCallbackToken(tokenPath)).rejects.not.toThrow(new RegExp(token));
  });

  it('refuses a token that is not 32 random bytes', async () => {
    const directory = await createTempDirectory();
    const tokenPath = path.join(directory, 'operator-callback-token');
    await writeFile(tokenPath, 'too-short', { mode: 0o640 });

    await expect(ensureCallbackToken(tokenPath)).rejects.toThrow(/32 bytes/);
  });

  it('reports a started operation once and then its result', async () => {
    const sink = await startCallbackSink();
    const reporter = createCallbackReporter({ callbackUrl: sink.baseUrl, token: 'b'.repeat(64) });

    await reporter.onProgress?.({ operationId: 'op-1', stream: 'stdout', chunk: 'working\n' });
    await reporter.onProgress?.({ operationId: 'op-1', stream: 'stdout', chunk: 'still\n' });
    await reporter.onResult?.({
      operationId: 'op-1',
      success: true,
      output: 'working\nstill\n',
      exitCode: 0,
      signal: null,
      truncated: false,
    });

    expect(sink.received.map((entry) => entry.method)).toEqual(['POST', 'POST']);
    expect(sink.received.map((entry) => entry.url)).toEqual([
      '/api/v1/admin/operations/op-1/callback',
      '/api/v1/admin/operations/op-1/callback',
    ]);
    expect(sink.received.map((entry) => entry.token)).toEqual(['b'.repeat(64), 'b'.repeat(64)]);
    expect(sink.received[0].body).toMatchObject({ operationId: 'op-1', state: 'running' });
    expect(sink.received[1].body).toMatchObject({
      operationId: 'op-1',
      state: 'succeeded',
      output: 'working\nstill\n',
    });
  });

  it('never places the callback token in the request body', async () => {
    const sink = await startCallbackSink();
    const token = 'c'.repeat(64);
    const reporter = createCallbackReporter({ callbackUrl: sink.baseUrl, token });

    await reporter.onResult?.({
      operationId: 'op-2',
      success: false,
      output: 'boom',
      exitCode: 3,
      signal: null,
      truncated: true,
    });

    expect(sink.received).toHaveLength(2);
    expect(JSON.stringify(sink.received.map((entry) => entry.body))).not.toContain(token);
    expect(sink.received.every((entry) => entry.token === token)).toBe(true);
    expect(sink.received[1].body).toMatchObject({
      operationId: 'op-2',
      state: 'failed',
      metadata: { exitCode: 3, truncated: true },
    });
  });

  it('keeps a control-character-saturated maximum tail inside the callback ceiling', async () => {
    const sink = await startCallbackSink();
    const reporter = createCallbackReporter({ callbackUrl: sink.baseUrl, token: 'f'.repeat(64) });

    // Worst case for JSON escaping: every byte of the executor's maximum tail
    // becomes a six-byte \u00xx escape on the wire.
    const output = '\u0001'.repeat(DEFAULT_OUTPUT_TAIL_BYTES);
    expect(Buffer.byteLength(JSON.stringify(output), 'utf8')).toBeGreaterThan(
      MAX_CALLBACK_REQUEST_BODY_BYTES,
    );

    await reporter.onResult?.({
      operationId: 'op-escape-worst-case',
      success: true,
      output,
      exitCode: 0,
      signal: null,
      truncated: true,
    });

    expect(sink.received).toHaveLength(2);
    const terminal = sink.received[1];
    expect(terminal.byteLength).toBeLessThanOrEqual(MAX_CALLBACK_REQUEST_BODY_BYTES);
    const body = terminal.body as { state: string; output: string; metadata: { truncated: boolean } };
    expect(body.state).toBe('succeeded');
    expect(body.metadata.truncated).toBe(true);
    expect(body.output.length).toBeGreaterThan(0);
    expect(output.endsWith(body.output)).toBe(true);
  });

  it('retries a 413 terminal report with the outcome and no output', async () => {
    const sink = await startCallbackSink();
    sink.statusFor = (recorded) => {
      const body = recorded.body as { state?: string; output?: unknown };
      return body.state !== 'running' && typeof body.output === 'string' ? 413 : 200;
    };
    const errors: Error[] = [];
    const reporter = createCallbackReporter({
      callbackUrl: sink.baseUrl,
      token: 'a'.repeat(64),
      onError: (error) => errors.push(error),
    });

    await expect(
      reporter.onResult?.({
        operationId: 'op-413-retry',
        success: false,
        output: 'x'.repeat(4096),
        exitCode: 1,
        signal: null,
        truncated: true,
      }),
    ).resolves.toBeUndefined();

    expect(sink.received.map((entry) => (entry.body as { state: string }).state)).toEqual([
      'running',
      'failed',
      'failed',
    ]);
    expect(sink.received[2].body).toMatchObject({
      state: 'failed',
      output: null,
      metadata: { exitCode: 1, truncated: true, outputDropped: true },
    });
    expect(errors.some((error) => /413/.test(error.message))).toBe(true);
  });

  it('degrades the output tail on UTF-8 boundaries, never mid-character', () => {
    const output = '😀'.repeat(512);
    const fitted = fitCallbackPayload(
      {
        operationId: 'op-fit-utf8',
        state: 'succeeded',
        message: 'Operation succeeded',
        output,
        metadata: { exitCode: 0, signal: null, truncated: false },
      },
      512,
    );

    const fittedOutput = fitted.output ?? '';
    expect(Buffer.byteLength(JSON.stringify(fitted), 'utf8')).toBeLessThanOrEqual(512);
    expect(fittedOutput.length).toBeGreaterThan(0);
    expect(fittedOutput).not.toContain('\uFFFD');
    expect(fittedOutput).toBe('😀'.repeat(fittedOutput.length / 2));
    expect(output.endsWith(fittedOutput)).toBe(true);
    expect(fitted.metadata?.truncated).toBe(true);
  });

  it('leaves a payload that already fits untouched', () => {
    const payload = {
      operationId: 'op-fit-noop',
      state: 'succeeded' as const,
      message: 'Operation succeeded',
      output: 'done\n',
      metadata: { exitCode: 0, signal: null, truncated: false },
    };

    expect(fitCallbackPayload(payload, MAX_CALLBACK_REQUEST_BODY_BYTES)).toBe(payload);
  });

  it('marks a result-only operation as started before reporting its outcome', async () => {
    const sink = await startCallbackSink();
    const reporter = createCallbackReporter({ callbackUrl: sink.baseUrl, token: 'd'.repeat(64) });

    await reporter.onResult?.({
      operationId: 'op-3',
      success: true,
      output: '',
      exitCode: 0,
      signal: null,
      truncated: false,
    });

    expect(sink.received.map((entry) => (entry.body as { state: string }).state)).toEqual([
      'running',
      'succeeded',
    ]);
  });

  it('surfaces delivery failures without throwing or leaking the token', async () => {
    const sink = await startCallbackSink();
    sink.status = 500;
    const token = 'e'.repeat(64);
    const errors: Error[] = [];
    const reporter = createCallbackReporter({
      callbackUrl: sink.baseUrl,
      token,
      maxAttempts: 2,
      retryBaseDelayMs: 0,
      onError: (error) => errors.push(error),
    });

    await expect(
      reporter.onProgress?.({ operationId: 'op-4', stream: 'stderr', chunk: 'oops\n' }),
    ).resolves.toBeUndefined();

    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) {
      expect(error.message).not.toContain(token);
    }
  });

  it('retries a dropped connection until the terminal report is delivered', async () => {
    const sink = await startCallbackSink();
    sink.destroyNextRequests = 2;
    const errors: Error[] = [];
    const reporter = createCallbackReporter({
      callbackUrl: sink.baseUrl,
      token: '1'.repeat(64),
      maxAttempts: 4,
      retryBaseDelayMs: 0,
      onError: (error) => errors.push(error),
    });

    await reporter.onResult?.({
      operationId: 'op-retry-transport',
      success: true,
      output: 'done\n',
      exitCode: 0,
      signal: null,
      truncated: false,
    });

    // Both dropped attempts were retried, and each state was ultimately
    // delivered exactly once.
    expect(sink.received.map((entry) => (entry.body as { state: string }).state)).toEqual([
      'running',
      'succeeded',
    ]);
    expect(errors.length).toBe(2);
  });

  it('retries a 5xx rejection and then reports the same terminal state once', async () => {
    const sink = await startCallbackSink();
    let terminalAttempts = 0;
    sink.statusFor = (recorded) => {
      const body = recorded.body as { state?: string };
      if (body.state === 'running') {
        return 200;
      }
      terminalAttempts += 1;
      return terminalAttempts === 1 ? 503 : 200;
    };
    const reporter = createCallbackReporter({
      callbackUrl: sink.baseUrl,
      token: '2'.repeat(64),
      maxAttempts: 4,
      retryBaseDelayMs: 0,
    });

    await reporter.onResult?.({
      operationId: 'op-retry-503',
      success: false,
      output: 'boom\n',
      exitCode: 2,
      signal: null,
      truncated: false,
    });

    expect(terminalAttempts).toBe(2);
    const terminalStates = sink.received
      .map((entry) => (entry.body as { state: string }).state)
      .filter((state) => state !== 'running');
    expect(terminalStates).toEqual(['failed', 'failed']);
  });

  it('never retries a rejection the web tier will keep refusing', async () => {
    const sink = await startCallbackSink();
    sink.status = 400;
    const errors: Error[] = [];
    const reporter = createCallbackReporter({
      callbackUrl: sink.baseUrl,
      token: '3'.repeat(64),
      maxAttempts: 5,
      retryBaseDelayMs: 0,
      onError: (error) => errors.push(error),
    });

    await reporter.onResult?.({
      operationId: 'op-no-retry-400',
      success: true,
      output: '',
      exitCode: 0,
      signal: null,
      truncated: false,
    });

    // One running attempt and one terminal attempt: neither is repeated.
    expect(sink.received).toHaveLength(2);
    expect(errors).toHaveLength(2);
  });

  it('gives up after the configured attempts without leaking the token', async () => {
    const sink = await startCallbackSink();
    sink.status = 503;
    const token = '4'.repeat(64);
    const errors: Error[] = [];
    const reporter = createCallbackReporter({
      callbackUrl: sink.baseUrl,
      token,
      maxAttempts: 3,
      retryBaseDelayMs: 0,
      onError: (error) => errors.push(error),
    });

    await expect(
      reporter.onResult?.({
        operationId: 'op-retry-exhausted',
        success: true,
        output: 'secret-free\n',
        exitCode: 0,
        signal: null,
        truncated: false,
      }),
    ).resolves.toBeUndefined();

    // Three bounded attempts for the running report and three for the result.
    expect(sink.received).toHaveLength(6);
    expect(errors).toHaveLength(6);
    for (const error of errors) {
      expect(error.message).not.toContain(token);
      expect(error.message).not.toContain(sink.baseUrl);
    }
  });

  it('applies bounded exponential backoff between attempts', async () => {
    const sink = await startCallbackSink();
    sink.status = 500;
    const delays: number[] = [];
    const reporter = createCallbackReporter({
      callbackUrl: sink.baseUrl,
      token: '5'.repeat(64),
      maxAttempts: 5,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 25,
      sleepImpl: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    await reporter.onProgress?.({ operationId: 'op-backoff', stream: 'stdout', chunk: 'x' });

    expect(delays).toEqual([10, 20, 25, 25]);
  });

  it('reports the validated backup description with a terminal result', async () => {
    const sink = await startCallbackSink();
    const reporter = createCallbackReporter({
      callbackUrl: sink.baseUrl,
      token: '6'.repeat(64),
    });

    await reporter.onResult?.({
      operationId: 'op-backup-result',
      success: true,
      output: 'published\n',
      exitCode: 0,
      signal: null,
      truncated: false,
      backup: {
        filename: 'ariadne-20260401T021500Z.dump',
        sha256: 'a'.repeat(64),
        sizeBytes: 4096,
        createdAt: '2026-04-01T02:15:00Z',
        message: 'backup published and checksummed',
      },
    });

    expect(sink.received[1].body).toMatchObject({
      state: 'succeeded',
      backup: {
        filename: 'ariadne-20260401T021500Z.dump',
        sha256: 'a'.repeat(64),
        sizeBytes: 4096,
        createdAt: '2026-04-01T02:15:00Z',
      },
    });
    // The running report carries no backup description.
    expect(sink.received[0].body).not.toHaveProperty('backup');
  });

  it('keeps the backup description when the output has to be dropped for size', async () => {
    const sink = await startCallbackSink();
    sink.statusFor = (recorded) => {
      const body = recorded.body as { state?: string; output?: unknown };
      return body.state !== 'running' && typeof body.output === 'string' ? 413 : 200;
    };
    const reporter = createCallbackReporter({
      callbackUrl: sink.baseUrl,
      token: '7'.repeat(64),
      retryBaseDelayMs: 0,
    });

    await reporter.onResult?.({
      operationId: 'op-backup-413',
      success: true,
      output: 'x'.repeat(4096),
      exitCode: 0,
      signal: null,
      truncated: true,
      backup: {
        filename: 'ariadne-20260401T021500Z.dump',
        sha256: 'b'.repeat(64),
        sizeBytes: 10,
        createdAt: '2026-04-01T02:15:00Z',
      },
    });

    const last = sink.received[sink.received.length - 1];
    expect(last.body).toMatchObject({
      state: 'succeeded',
      output: null,
      backup: { filename: 'ariadne-20260401T021500Z.dump' },
    });
  });

  it('is disabled when no callback destination is configured', () => {
    expect(getCallbackConfig({})).toBeNull();
    expect(
      getCallbackConfig({ OPERATOR_CALLBACK_URL: 'http://127.0.0.1:4300/api/v1/admin/operations' }),
    ).toMatchObject({
      callbackUrl: 'http://127.0.0.1:4300/api/v1/admin/operations',
      tokenPath: DEFAULT_CALLBACK_TOKEN_PATH,
    });
    expect(() =>
      getCallbackConfig({ OPERATOR_CALLBACK_URL: 'https://ariadne.example.com/callback' }),
    ).toThrowError(/loopback/i);
  });
});
