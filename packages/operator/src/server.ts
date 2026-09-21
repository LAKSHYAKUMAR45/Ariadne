import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { chmod, lstat, rm } from 'node:fs/promises';
import { parseOperatorRequest, type OperatorAccepted, type OperatorRequest } from './protocol.js';
import {
  createOperatorExecutor,
  type OperatorEventSink,
  type OperatorExecutor,
} from './executor.js';

export const MAX_OPERATOR_REQUEST_BODY_BYTES = 8 * 1024;
const OPERATOR_ROUTE_PATH = '/v1/operations';

interface JsonErrorResponse {
  error: string;
}

export interface CreateOperatorServerOptions {
  socketPath: string;
  executeOperation?: OperatorExecutor['execute'];
  reporter?: OperatorEventSink;
  requestBodyLimitBytes?: number;
}

export interface OperatorServer {
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
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
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

function readJsonBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<string | JsonErrorResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let exceeded = false;

    request.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) {
        exceeded = true;
        return;
      }
      chunks.push(buffer);
    });
    request.on('error', reject);
    request.on('end', () => {
      if (exceeded) {
        resolve({ error: 'request_too_large' });
        return;
      }

      resolve(Buffer.concat(chunks).toString('utf8'));
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
  const defaultExecutor = createOperatorExecutor({ reporter: options.reporter });
  const executeOperation = options.executeOperation ?? defaultExecutor.execute.bind(defaultExecutor);

  const acceptedById = new Map<string, OperatorAccepted>();
  let activeOperationId: string | null = null;

  const server = http.createServer(async (request, response) => {
    if ((request.url ?? '') !== OPERATOR_ROUTE_PATH) {
      writeJson(response, 404, { error: 'not_found' });
      return;
    }

    if (request.method !== 'POST') {
      writeJson(response, 405, { error: 'method_not_allowed' });
      return;
    }

    try {
      const rawBody = await readJsonBody(request, requestBodyLimitBytes);
      if (typeof rawBody !== 'string') {
        writeJson(response, 413, rawBody);
        return;
      }

      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        writeJson(response, 400, { error: 'invalid_json' });
        return;
      }

      const operatorRequest = parseOperatorRequest(parsedBody);
      const accepted = acceptedById.get(operatorRequest.operationId);

      if (accepted) {
        writeJson(response, 202, accepted);
        return;
      }

      if (activeOperationId && activeOperationId !== operatorRequest.operationId) {
        writeJson(response, 409, { error: 'operator_busy' });
        return;
      }

      const acceptedResponse: OperatorAccepted = {
        operationId: operatorRequest.operationId,
        accepted: true,
      };

      activeOperationId = operatorRequest.operationId;
      acceptedById.set(operatorRequest.operationId, acceptedResponse);
      writeJson(response, 202, acceptedResponse);

      void runAcceptedOperation(
        operatorRequest,
        executeOperation,
        acceptedById,
        () => activeOperationId,
        (operationId) => {
          if (activeOperationId === operationId) {
            activeOperationId = null;
          }
        },
      );
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'ZodError') {
        writeJson(response, 400, { error: 'invalid_request' });
        return;
      }
      writeJson(response, 500, { error: 'internal_error' });
    }
  });

  return {
    async start(): Promise<void> {
      await safeRemoveOwnedSocket(options.socketPath);

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.socketPath, () => {
          server.off('error', reject);
          resolve();
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
  executeOperation: OperatorExecutor['execute'],
  acceptedById: Map<string, OperatorAccepted>,
  getActiveOperationId: () => string | null,
  clearActiveOperationId: (operationId: string) => void,
): Promise<void> {
  try {
    await executeOperation(request);
  } catch {
  } finally {
    if (getActiveOperationId() === request.operationId) {
      clearActiveOperationId(request.operationId);
    }
    acceptedById.delete(request.operationId);
  }
}
