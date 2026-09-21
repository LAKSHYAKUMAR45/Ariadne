import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createOperatorServer,
  getOperatorSocketPath,
  withRestrictiveUmask,
  MAX_OPERATOR_REQUEST_BODY_BYTES,
} from '../src/server.js';

interface HttpResponse {
  statusCode: number;
  body: string;
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
