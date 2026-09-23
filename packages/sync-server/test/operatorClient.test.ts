import { mkdtemp, rm } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { PassThrough, Readable } from 'node:stream';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OPERATOR_REQUEST_PATH,
  OperatorClientError,
  classifyOperatorTransportError,
  createOperatorClient,
  type OperatorSubmitRequest,
} from '../src/operatorClient.js';
import { createOperatorQueryClient, OPERATOR_QUERY_PATH } from '../src/operatorQueryClient.js';

interface RecordedRequest {
  method: string;
  url: string;
  contentType: string | undefined;
  body: string;
}

interface FakeOperator {
  socketPath: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

type FakeHandler = (recorded: RecordedRequest, res: ServerResponse) => void;

function jsonResponse(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

describe('operatorClient', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop()!;
      await cleanup();
    }
  });

  async function makeSocketDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'ariadne-operator-client-'));
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    return dir;
  }

  async function startFakeOperator(handler: FakeHandler): Promise<FakeOperator> {
    const dir = await makeSocketDir();
    const socketPath = path.join(dir, 'operator.sock');
    const requests: RecordedRequest[] = [];

    const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const recorded: RecordedRequest = {
          method: req.method ?? '',
          url: req.url ?? '',
          contentType: req.headers['content-type'],
          body: Buffer.concat(chunks).toString('utf8'),
        };
        requests.push(recorded);
        handler(recorded, res);
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });

    const fake: FakeOperator = {
      socketPath,
      requests,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    };
    cleanups.push(() => fake.close());
    return fake;
  }

  const restartRequest: OperatorSubmitRequest = {
    operationId: 'op-restart-1',
    type: 'service_restart',
    service: 'sync-server',
  };

  it('submits the strict operator request shape and returns the acceptance', async () => {
    const operator = await startFakeOperator((recorded, res) => {
      const parsed = JSON.parse(recorded.body) as { operationId: string };
      jsonResponse(res, 202, { operationId: parsed.operationId, accepted: true });
    });

    const client = createOperatorClient({ socketPath: operator.socketPath });
    const accepted = await client.submit(restartRequest);

    expect(accepted).toEqual({ operationId: 'op-restart-1', accepted: true });
    expect(operator.requests).toHaveLength(1);
    expect(operator.requests[0].method).toBe('POST');
    expect(operator.requests[0].url).toBe(OPERATOR_REQUEST_PATH);
    expect(operator.requests[0].contentType).toContain('application/json');
    // Wire shape must stay byte-for-byte compatible with the operator schema.
    expect(JSON.parse(operator.requests[0].body)).toEqual({
      operationId: 'op-restart-1',
      type: 'service_restart',
      service: 'sync-server',
    });
  });

  it('submits deployment and backup requests using the operator field names', async () => {
    const operator = await startFakeOperator((recorded, res) => {
      const parsed = JSON.parse(recorded.body) as { operationId: string };
      jsonResponse(res, 202, { operationId: parsed.operationId, accepted: true });
    });
    const client = createOperatorClient({ socketPath: operator.socketPath });

    await client.submit({
      operationId: 'op-deploy-1',
      type: 'deployment_apply',
      revision: 'a'.repeat(40),
    });
    await client.submit({
      operationId: 'op-backup-1',
      type: 'backup_create',
    });
    await client.submit({
      operationId: 'op-verify-1',
      type: 'backup_verify',
      backupName: 'ariadne-2026-09-21.dump',
    });

    expect(operator.requests.map((recorded) => JSON.parse(recorded.body))).toEqual([
      { operationId: 'op-deploy-1', type: 'deployment_apply', revision: 'a'.repeat(40) },
      { operationId: 'op-backup-1', type: 'backup_create' },
      {
        operationId: 'op-verify-1',
        type: 'backup_verify',
        backupName: 'ariadne-2026-09-21.dump',
      },
    ]);
  });

  it('treats a duplicate delivery replayed by the operator as the same acceptance', async () => {
    const operator = await startFakeOperator((recorded, res) => {
      const parsed = JSON.parse(recorded.body) as { operationId: string };
      jsonResponse(res, 202, { operationId: parsed.operationId, accepted: true });
    });
    const client = createOperatorClient({ socketPath: operator.socketPath });

    const first = await client.submit(restartRequest);
    const second = await client.submit(restartRequest);

    expect(second).toEqual(first);
    expect(operator.requests).toHaveLength(2);
  });

  it('classifies pre-accept connection setup failures as operator_connect_failed', () => {
    for (const code of ['ENOENT', 'ECONNREFUSED', 'ENOTSOCK', 'EACCES'] as const) {
      const error = classifyOperatorTransportError({ code } as NodeJS.ErrnoException);
      expect(error.code).toBe('operator_connect_failed');
      expect(error.status).toBe(503);
      expect(error.message).toBe('The operator service is not reachable');
    }
  });

  it('keeps ambiguous transport loss path-free as operator_unavailable', () => {
    const error = classifyOperatorTransportError({ code: 'ECONNRESET' } as NodeJS.ErrnoException);

    expect(error.code).toBe('operator_unavailable');
    expect(error.status).toBe(503);
    expect(error.message).toBe('The operator service is not reachable');
  });

  it('maps a missing socket to operator_connect_failed without leaking the OS path', async () => {
    const dir = await makeSocketDir();
    const socketPath = path.join(dir, 'absent-operator.sock');
    const client = createOperatorClient({ socketPath });

    const error = await client.submit(restartRequest).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(OperatorClientError);
    const clientError = error as OperatorClientError;
    expect(clientError.code).toBe('operator_connect_failed');
    expect(clientError.status).toBe(503);
    expect(clientError.message).not.toContain(socketPath);
    expect(clientError.message).not.toContain(dir);
    expect(clientError.message).not.toContain('.sock');
  });

  it('maps a refused connection to operator_connect_failed', async () => {
    const operator = await startFakeOperator((_recorded, res) => {
      jsonResponse(res, 202, { operationId: 'unused', accepted: true });
    });
    await operator.close();

    const client = createOperatorClient({ socketPath: operator.socketPath });
    const error = (await client
      .submit(restartRequest)
      .catch((err: unknown) => err)) as OperatorClientError;

    expect(error).toBeInstanceOf(OperatorClientError);
    expect(error.code).toBe('operator_connect_failed');
    expect(error.status).toBe(503);
  });

  it('treats a post-request connection reset as operator_unavailable', async () => {
    const operator = await startFakeOperator((_recorded, _res) => {
      // Ambiguous loss after the request reached the operator: the operator may
      // already have accepted or started the work before the transport died.
      _res.socket?.destroy();
    });
    const client = createOperatorClient({ socketPath: operator.socketPath });

    const error = (await client
      .submit(restartRequest)
      .catch((err: unknown) => err)) as OperatorClientError;

    expect(error).toBeInstanceOf(OperatorClientError);
    expect(error.code).toBe('operator_unavailable');
    expect(error.status).toBe(503);
  });

  it('times out a hung operator instead of waiting forever', async () => {
    const operator = await startFakeOperator(() => {
      // Never responds: exercises the client-side timeout.
    });
    const client = createOperatorClient({
      socketPath: operator.socketPath,
      requestTimeoutMs: 150,
    });

    const error = (await client
      .submit(restartRequest)
      .catch((err: unknown) => err)) as OperatorClientError;

    expect(error).toBeInstanceOf(OperatorClientError);
    expect(error.code).toBe('operator_timeout');
    expect(error.status).toBe(504);
    expect(error.message).not.toContain(operator.socketPath);
  });

  it('rejects a non-JSON response as operator_invalid_response', async () => {
    const operator = await startFakeOperator((_recorded, res) => {
      res.statusCode = 202;
      res.end('not json');
    });
    const client = createOperatorClient({ socketPath: operator.socketPath });

    const error = (await client
      .submit(restartRequest)
      .catch((err: unknown) => err)) as OperatorClientError;

    expect(error).toBeInstanceOf(OperatorClientError);
    expect(error.code).toBe('operator_invalid_response');
    expect(error.status).toBe(502);
  });

  it('rejects an acceptance for a different operation id', async () => {
    const operator = await startFakeOperator((_recorded, res) => {
      jsonResponse(res, 202, { operationId: 'someone-elses-op', accepted: true });
    });
    const client = createOperatorClient({ socketPath: operator.socketPath });

    const error = (await client
      .submit(restartRequest)
      .catch((err: unknown) => err)) as OperatorClientError;

    expect(error.code).toBe('operator_invalid_response');
    expect(error.status).toBe(502);
  });

  it('rejects an acceptance payload that is not accepted:true', async () => {
    const operator = await startFakeOperator((_recorded, res) => {
      jsonResponse(res, 202, { operationId: 'op-restart-1', accepted: false });
    });
    const client = createOperatorClient({ socketPath: operator.socketPath });

    const error = (await client
      .submit(restartRequest)
      .catch((err: unknown) => err)) as OperatorClientError;

    expect(error.code).toBe('operator_invalid_response');
  });

  it('caps the response body instead of buffering unbounded operator output', async () => {
    const operator = await startFakeOperator((_recorded, res) => {
      res.statusCode = 202;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ operationId: 'op-restart-1', accepted: true, pad: 'x'.repeat(4096) }));
    });
    const client = createOperatorClient({
      socketPath: operator.socketPath,
      maxResponseBytes: 256,
    });

    const error = (await client
      .submit(restartRequest)
      .catch((err: unknown) => err)) as OperatorClientError;

    expect(error).toBeInstanceOf(OperatorClientError);
    expect(error.code).toBe('operator_invalid_response');
    expect(error.message).not.toContain(operator.socketPath);
  });

  it('maps operator_busy to a conflict rather than a generic failure', async () => {
    const operator = await startFakeOperator((_recorded, res) => {
      jsonResponse(res, 409, { error: 'operator_busy' });
    });
    const client = createOperatorClient({ socketPath: operator.socketPath });

    const error = (await client
      .submit(restartRequest)
      .catch((err: unknown) => err)) as OperatorClientError;

    expect(error.code).toBe('operator_busy');
    expect(error.status).toBe(409);
  });

  it('maps an operator protocol rejection to operator_rejected without echoing details', async () => {
    const operator = await startFakeOperator((_recorded, res) => {
      jsonResponse(res, 400, { error: 'invalid_request' });
    });
    const client = createOperatorClient({ socketPath: operator.socketPath });

    const error = (await client
      .submit(restartRequest)
      .catch((err: unknown) => err)) as OperatorClientError;

    expect(error.code).toBe('operator_rejected');
    expect(error.status).toBe(502);
    expect(error.message).not.toContain(operator.socketPath);
  });

  it('refuses a relative socket path so the client never depends on the working directory', () => {
    expect(() => createOperatorClient({ socketPath: 'run/operator.sock' })).toThrow(
      'OPERATOR_SOCKET_PATH must be an absolute path',
    );
  });

  it('refuses an empty socket path', () => {
    expect(() => createOperatorClient({ socketPath: '' })).toThrow(
      'OPERATOR_SOCKET_PATH must be an absolute path',
    );
  });
});

describe('operatorQueryClient', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop()!;
      await cleanup();
    }
  });

  async function makeSocketDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'ariadne-operator-query-client-'));
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    return dir;
  }

  async function startFakeOperator(handler: FakeHandler): Promise<FakeOperator> {
    const dir = await makeSocketDir();
    const socketPath = path.join(dir, 'operator.sock');
    const requests: RecordedRequest[] = [];

    const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const recorded: RecordedRequest = {
          method: req.method ?? '',
          url: req.url ?? '',
          contentType: req.headers['content-type'],
          body: Buffer.concat(chunks).toString('utf8'),
        };
        requests.push(recorded);
        handler(recorded, res);
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });

    const fake: FakeOperator = {
      socketPath,
      requests,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    };
    cleanups.push(() => fake.close());
    return fake;
  }

  it('posts strict queries to the fixed /v1/queries endpoint and returns the normalized value', async () => {
    const operator = await startFakeOperator((recorded, res) => {
      jsonResponse(res, 200, {
        type: 'host_metrics',
        value: {
          cpuPercent: 12.5,
          memoryUsedBytes: 10,
          memoryTotalBytes: 20,
          filesystemUsedBytes: 30,
          filesystemTotalBytes: 40,
        },
      });
    });

    const client = createOperatorQueryClient({ socketPath: operator.socketPath });
    const result = await client.query({ type: 'host_metrics' });

    expect(result).toEqual({
      cpuPercent: 12.5,
      memoryUsedBytes: 10,
      memoryTotalBytes: 20,
      filesystemUsedBytes: 30,
      filesystemTotalBytes: 40,
    });
    expect(operator.requests).toHaveLength(1);
    expect(operator.requests[0].method).toBe('POST');
    expect(operator.requests[0].url).toBe(OPERATOR_QUERY_PATH);
    expect(JSON.parse(operator.requests[0].body)).toEqual({ type: 'host_metrics' });
  });

  it('times out a hung query instead of waiting forever', async () => {
    const operator = await startFakeOperator(() => {
      // Never responds: exercises the client-side timeout.
    });
    const client = createOperatorQueryClient({
      socketPath: operator.socketPath,
      requestTimeoutMs: 150,
    });

    const error = (await client
      .query({ type: 'service_status' })
      .catch((err: unknown) => err)) as OperatorClientError;

    expect(error).toBeInstanceOf(OperatorClientError);
    expect(error.code).toBe('operator_timeout');
    expect(error.status).toBe(504);
    expect(error.message).not.toContain(operator.socketPath);
  });

  it('caps buffered query responses instead of reading unbounded output', async () => {
    const operator = await startFakeOperator((_recorded, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          type: 'logs_read',
          value: {
            entries: [
              {
                sequence: 1,
                timestamp: '2026-09-23T10:00:00.000Z',
                severity: 'info',
                message: 'x'.repeat(4096),
                redacted: false,
              },
            ],
            nextCursor: null,
          },
        }),
      );
    });
    const client = createOperatorQueryClient({
      socketPath: operator.socketPath,
      maxResponseBytes: 256,
    });

    const error = (await client
      .query({ type: 'logs_read', source: 'backup', limit: 1 })
      .catch((err: unknown) => err)) as OperatorClientError;

    expect(error).toBeInstanceOf(OperatorClientError);
    expect(error.code).toBe('operator_invalid_response');
    expect(error.message).not.toContain(operator.socketPath);
  });

  it('rejects a query response whose discriminant does not match the request', async () => {
    const operator = await startFakeOperator((_recorded, res) => {
      jsonResponse(res, 200, {
        type: 'service_status',
        value: {
          services: [{ name: 'sync-server', state: 'running' }],
        },
      });
    });
    const client = createOperatorQueryClient({ socketPath: operator.socketPath });

    const error = (await client
      .query({ type: 'deployment_status' })
      .catch((err: unknown) => err)) as OperatorClientError;

    expect(error).toBeInstanceOf(OperatorClientError);
    expect(error.code).toBe('operator_invalid_response');
    expect(error.status).toBe(502);
  });

  it('maps a missing query socket to a path-free operator_connect_failed error', async () => {
    const dir = await makeSocketDir();
    const socketPath = path.join(dir, 'missing-query.sock');
    const client = createOperatorQueryClient({ socketPath });

    const error = (await client.query({ type: 'host_metrics' }).catch((err: unknown) => err)) as OperatorClientError;

    expect(error).toBeInstanceOf(OperatorClientError);
    expect(error.code).toBe('operator_connect_failed');
    expect(error.status).toBe(503);
    expect(error.message).not.toContain(socketPath);
    expect(error.message).not.toContain(dir);
    expect(error.message).not.toContain('.sock');
  });

  it('validates streamed backup checksum and size headers before returning the stream', async () => {
    const operator = await startFakeOperator((_recorded, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-length', '12');
      res.setHeader('x-ariadne-backup-sha256', 'not-a-sha256');
      res.setHeader('content-disposition', 'attachment; filename="ariadne-20260923T032200Z.dump"');
      res.end('backup-bytes');
    });
    const client = createOperatorQueryClient({ socketPath: operator.socketPath });

    const error = (await client
      .downloadBackup('ariadne-20260923T032200Z.dump', new AbortController().signal)
      .catch((err: unknown) => err)) as OperatorClientError;

    expect(error).toBeInstanceOf(OperatorClientError);
    expect(error.code).toBe('operator_invalid_response');
    expect(error.status).toBe(502);
  });

  it('destroys the operator backup stream when the caller aborts the download', async () => {
    const operator = await startFakeOperator((_recorded, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-length', '1024');
      res.setHeader('x-ariadne-backup-sha256', 'a'.repeat(64));
      res.setHeader('content-disposition', 'attachment; filename="ariadne-20260923T032200Z.dump"');
      Readable.from([Buffer.alloc(1024, 'x')]).pipe(res);
    });
    const client = createOperatorQueryClient({ socketPath: operator.socketPath });
    const abortController = new AbortController();

    const download = await client.downloadBackup(
      'ariadne-20260923T032200Z.dump',
      abortController.signal,
    );

    let destroyed = false;
    const stream = new PassThrough({
      destroy(error, callback) {
        destroyed = true;
        callback(error);
      },
    });

    (download.stream as Readable).pipe(stream);
    stream.once('data', () => abortController.abort());

    for (let attempt = 0; attempt < 50 && !destroyed; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(destroyed).toBe(true);
  });
});
