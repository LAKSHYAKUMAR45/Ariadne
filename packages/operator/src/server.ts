import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { chmod, lstat, rm } from 'node:fs/promises';
import { parseOperatorRequest, type OperatorAccepted, type OperatorRequest } from './protocol.js';
import {
  OperationAdmissionRegistry,
  createSerialQueue,
  DEFAULT_TERMINAL_CACHE_MAX_ENTRIES,
  DEFAULT_TERMINAL_CACHE_TTL_MS,
} from './admission.js';
import {
  createOperatorExecutor,
  type OperatorEventSink,
  type OperatorExecutor,
} from './executor.js';

export const MAX_OPERATOR_REQUEST_BODY_BYTES = 8 * 1024;
export { DEFAULT_TERMINAL_CACHE_TTL_MS, DEFAULT_TERMINAL_CACHE_MAX_ENTRIES };
export const DEFAULT_HEADERS_TIMEOUT_MS = 10 * 1000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 20 * 1000;
export const SOCKET_CREATION_UMASK = 0o177;

const OPERATOR_ROUTE_PATH = '/v1/operations';

interface JsonErrorResponse {
  error: string;
}

export type OperatorExecuteFn = (
  request: OperatorRequest,
  reporter: OperatorEventSink,
) => Promise<void>;

export interface CreateOperatorServerOptions {
  socketPath: string;
  executeOperation?: OperatorExecuteFn;
  reporter?: OperatorEventSink;
  requestBodyLimitBytes?: number;
  terminalCacheTtlMs?: number;
  terminalCacheMaxEntries?: number;
  headersTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export interface OperatorServer {
  readonly headersTimeoutMs: number;
  readonly requestTimeoutMs: number;
  start(): Promise<void>;
  close(): Promise<void>;
}

class OperatorServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperatorServerConfigError';
  }
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: OperatorAccepted | JsonErrorResponse,
): void {
  if (response.writableEnded || response.headersSent) {
    return;
  }
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

/**
 * Terminates the inbound request immediately instead of draining an oversized
 * or slow body, while still flushing the JSON error response.
 */
function rejectRequestBody(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  payload: JsonErrorResponse,
): void {
  request.pause();
  request.removeAllListeners('data');

  if (response.writableEnded || response.headersSent) {
    request.destroy();
    return;
  }

  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('connection', 'close');
  response.end(JSON.stringify(payload), () => {
    request.destroy();
  });
}

async function safeRemoveOwnedSocket(socketPath: string): Promise<void> {
  const currentUid = process.getuid?.();
  if (typeof currentUid !== 'number') {
    throw new OperatorServerConfigError('Current process UID is unavailable');
  }

  try {
    const existingPath = await lstat(socketPath);
    if (!existingPath.isSocket()) {
      throw new OperatorServerConfigError(
        `Refusing to replace existing non-socket path: ${socketPath}`,
      );
    }
    if (existingPath.uid !== currentUid) {
      throw new OperatorServerConfigError(
        `Refusing to replace socket not owned by current uid: ${socketPath}`,
      );
    }

    await rm(socketPath, { force: true });
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * Runs `operation` with a restrictive umask so files/sockets are never created
 * with a permissive mode, restoring the previous umask in all outcomes.
 */
export async function withRestrictiveUmask<T>(operation: () => Promise<T>): Promise<T> {
  if (typeof process.umask !== 'function') {
    return await operation();
  }

  const previousUmask = process.umask(SOCKET_CREATION_UMASK);
  try {
    return await operation();
  } finally {
    process.umask(previousUmask);
  }
}

type BodyOutcome = { kind: 'body'; value: string } | { kind: 'rejected' };

function readJsonBody(
  request: IncomingMessage,
  response: ServerResponse,
  maxBytes: number,
): Promise<BodyOutcome> {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(request.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      rejectRequestBody(request, response, 413, { error: 'request_too_large' });
      resolve({ kind: 'rejected' });
      return;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const settle = (outcome: BodyOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(outcome);
    };

    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) {
        rejectRequestBody(request, response, 413, { error: 'request_too_large' });
        settle({ kind: 'rejected' });
        return;
      }
      chunks.push(buffer);
    });
    request.on('aborted', () => {
      settle({ kind: 'rejected' });
    });
    request.on('error', (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
    request.on('end', () => {
      settle({ kind: 'body', value: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

export function getOperatorSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const socketPath = env.OPERATOR_SOCKET_PATH;
  if (!socketPath) {
    throw new OperatorServerConfigError('OPERATOR_SOCKET_PATH environment variable is required');
  }
  if (!path.isAbsolute(socketPath)) {
    throw new OperatorServerConfigError('OPERATOR_SOCKET_PATH must be an absolute path');
  }
  return socketPath;
}

export function createOperatorServer(options: CreateOperatorServerOptions): OperatorServer {
  const requestBodyLimitBytes = options.requestBodyLimitBytes ?? MAX_OPERATOR_REQUEST_BODY_BYTES;
  const headersTimeoutMs = options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const reporter: OperatorEventSink = options.reporter ?? {};
  const defaultExecutor: OperatorExecutor = createOperatorExecutor({ reporter: options.reporter });
  const executeOperation: OperatorExecuteFn =
    options.executeOperation ??
    ((request, eventSink) => defaultExecutor.execute(request, eventSink));

  const admissions = new OperationAdmissionRegistry({
    ttlMs: options.terminalCacheTtlMs,
    maxEntries: options.terminalCacheMaxEntries,
  });
  const admitExclusively = createSerialQueue();

  const connectionsCheckingIntervalMs = Math.max(
    250,
    Math.floor(Math.min(headersTimeoutMs, requestTimeoutMs) / 2),
  );

  const server = http.createServer(
    { connectionsCheckingInterval: connectionsCheckingIntervalMs },
    async (request, response) => {
    if ((request.url ?? '') !== OPERATOR_ROUTE_PATH) {
      writeJson(response, 404, { error: 'not_found' });
      return;
    }

    if (request.method !== 'POST') {
      writeJson(response, 405, { error: 'method_not_allowed' });
      return;
    }

    try {
      const bodyOutcome = await readJsonBody(request, response, requestBodyLimitBytes);
      if (bodyOutcome.kind === 'rejected') {
        return;
      }

      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(bodyOutcome.value);
      } catch {
        writeJson(response, 400, { error: 'invalid_json' });
        return;
      }

      // Validation happens before any reservation so a rejected request never
      // claims (or burns) its operation id.
      const operatorRequest = parseOperatorRequest(parsedBody);

      // Reservation and dispatch run inside one serialized section, so two
      // requests that both finished body parsing cannot both see an idle
      // operator and execute.
      await admitExclusively(() => {
        const decision = admissions.reserve(operatorRequest.operationId);

        if (decision.kind === 'duplicate') {
          writeJson(response, 202, decision.accepted);
          return;
        }

        if (decision.kind === 'busy') {
          writeJson(response, 409, { error: 'operator_busy' });
          return;
        }

        writeJson(response, 202, decision.accepted);

        void runAcceptedOperation(operatorRequest, executeOperation, reporter, () => {
          admissions.settle(operatorRequest.operationId);
        });
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'ZodError') {
        writeJson(response, 400, { error: 'invalid_request' });
        return;
      }
      writeJson(response, 500, { error: 'internal_error' });
    }
  },
  );

  server.headersTimeout = headersTimeoutMs;
  server.requestTimeout = requestTimeoutMs;
  server.on('clientError', (error: NodeJS.ErrnoException, socket) => {
    const statusLine =
      error.code === 'HPE_HEADERS_TIMEOUT' || error.code === 'ERR_HTTP_REQUEST_TIMEOUT'
        ? 'HTTP/1.1 408 Request Timeout'
        : 'HTTP/1.1 400 Bad Request';

    if (!socket.writable) {
      socket.destroy();
      return;
    }

    socket.end(`${statusLine}\r\nConnection: close\r\n\r\n`, () => {
      socket.destroy();
    });
  });

  return {
    headersTimeoutMs,
    requestTimeoutMs,
    async start(): Promise<void> {
      await safeRemoveOwnedSocket(options.socketPath);

      await withRestrictiveUmask(async () => {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(options.socketPath, () => {
            server.off('error', reject);
            resolve();
          });
        });
      });

      await chmod(options.socketPath, 0o660);
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

      await safeRemoveOwnedSocket(options.socketPath);
    },
  };
}

async function runAcceptedOperation(
  request: OperatorRequest,
  executeOperation: OperatorExecuteFn,
  reporter: OperatorEventSink,
  markTerminal: () => void,
): Promise<void> {
  try {
    await executeOperation(request, reporter);
  } catch {
    // Terminal failures are reported through the event sink; the operation id
    // still becomes terminal so retries with the same id are never re-executed.
  } finally {
    markTerminal();
  }
}
