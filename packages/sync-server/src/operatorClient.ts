/**
 * Unix-socket client for the root-owned `ariadne-operator` service.
 *
 * The wire contract is owned by `packages/operator/src/protocol.ts`. The
 * sync-server does not depend on the operator package at runtime (they are
 * deployed as separate services with separate privilege levels), so the request
 * shape is mirrored structurally here and validated before it is sent.
 */
import http from 'node:http';
import path from 'node:path';
import { SyncServerConfigError } from './config.js';

export const OPERATOR_REQUEST_PATH = '/v1/operations';
export const DEFAULT_OPERATOR_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_OPERATOR_RESPONSE_BYTES = 8 * 1024;

export type OperatorSubmitRequest =
  | { operationId: string; type: 'service_restart'; service: 'sync-server' | 'postgres' }
  | { operationId: string; type: 'deployment_apply'; revision: string }
  | { operationId: string; type: 'backup_create' }
  | { operationId: string; type: 'backup_verify'; backupName: string }
  | { operationId: string; type: 'backup_restore'; backupName: string };

export interface OperatorAcceptance {
  operationId: string;
  accepted: true;
}

export type OperatorClientErrorCode =
  | 'operator_connect_failed'
  | 'operator_unavailable'
  | 'operator_timeout'
  | 'operator_busy'
  | 'operator_invalid_response'
  | 'operator_rejected';

/**
 * Transport and protocol failures surface as fixed, path-free messages: the
 * socket location is deployment-internal and must never reach an API response
 * or an audit row.
 */
export class OperatorClientError extends Error {
  constructor(
    public readonly code: OperatorClientErrorCode,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'OperatorClientError';
  }
}

export interface OperatorClient {
  submit(request: OperatorSubmitRequest): Promise<OperatorAcceptance>;
}

export interface CreateOperatorClientOptions {
  socketPath: string;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
}

const ERROR_MESSAGES: Record<OperatorClientErrorCode, string> = {
  operator_connect_failed: 'The operator service is not reachable',
  operator_unavailable: 'The operator service is not reachable',
  operator_timeout: 'The operator service did not respond in time',
  operator_busy: 'Another operator operation is already running',
  operator_invalid_response: 'The operator service returned an unusable response',
  operator_rejected: 'The operator service rejected the request',
};

const DEFINITE_CONNECT_FAILURE_CODES = new Set(['ENOENT', 'ECONNREFUSED', 'ENOTSOCK', 'EACCES']);

function operatorError(code: OperatorClientErrorCode, status: number): OperatorClientError {
  return new OperatorClientError(code, status, ERROR_MESSAGES[code]);
}

export function classifyOperatorTransportError(error: NodeJS.ErrnoException): OperatorClientError {
  if (
    typeof error.code === 'string' &&
    DEFINITE_CONNECT_FAILURE_CODES.has(error.code.toUpperCase())
  ) {
    return operatorError('operator_connect_failed', 503);
  }

  return operatorError('operator_unavailable', 503);
}

function isAcceptance(value: unknown, operationId: string): value is OperatorAcceptance {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { operationId?: unknown; accepted?: unknown };
  return candidate.accepted === true && candidate.operationId === operationId;
}

interface RawResponse {
  statusCode: number;
  body: string;
}

export function createOperatorClient(options: CreateOperatorClientOptions): OperatorClient {
  const socketPath = options.socketPath;
  if (!socketPath || !path.isAbsolute(socketPath)) {
    throw new SyncServerConfigError(
      'OPERATOR_SOCKET_PATH must be an absolute path (e.g. /run/ariadne/operator.sock)',
    );
  }

  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_OPERATOR_REQUEST_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_OPERATOR_RESPONSE_BYTES;

  function send(payload: string): Promise<RawResponse> {
    return new Promise<RawResponse>((resolve, reject) => {
      let settled = false;
      const settle = (outcome: { ok: RawResponse } | { err: Error }): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(overallTimer);
        if ('ok' in outcome) {
          resolve(outcome.ok);
        } else {
          reject(outcome.err);
        }
      };

      const request = http.request(
        {
          socketPath,
          path: OPERATOR_REQUEST_PATH,
          method: 'POST',
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(payload, 'utf8'),
            accept: 'application/json',
            connection: 'close',
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          response.on('data', (chunk: Buffer) => {
            totalBytes += chunk.length;
            if (totalBytes > maxResponseBytes) {
              response.destroy();
              request.destroy();
              settle({ err: operatorError('operator_invalid_response', 502) });
              return;
            }
            chunks.push(chunk);
          });
          response.on('error', () => {
            settle({ err: operatorError('operator_unavailable', 503) });
          });
          response.on('end', () => {
            settle({
              ok: {
                statusCode: response.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8'),
              },
            });
          });
        },
      );

      // Guards the whole exchange (connect, write, and response body), not just
      // socket inactivity.
      const overallTimer = setTimeout(() => {
        request.destroy();
        settle({ err: operatorError('operator_timeout', 504) });
      }, requestTimeoutMs);

      request.setTimeout(requestTimeoutMs, () => {
        request.destroy();
        settle({ err: operatorError('operator_timeout', 504) });
      });

      request.on('error', (error: NodeJS.ErrnoException) => {
        settle({ err: classifyOperatorTransportError(error) });
      });

      request.end(payload);
    });
  }

  return {
    async submit(operatorRequest: OperatorSubmitRequest): Promise<OperatorAcceptance> {
      const payload = JSON.stringify(operatorRequest);
      const response = await send(payload);

      if (response.statusCode === 409) {
        throw operatorError('operator_busy', 409);
      }

      if (response.statusCode !== 202) {
        throw operatorError('operator_rejected', 502);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        throw operatorError('operator_invalid_response', 502);
      }

      if (!isAcceptance(parsed, operatorRequest.operationId)) {
        throw operatorError('operator_invalid_response', 502);
      }

      return { operationId: parsed.operationId, accepted: true };
    },
  };
}
