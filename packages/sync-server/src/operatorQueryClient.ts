import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { SyncServerConfigError } from './config.js';
import { OperatorClientError, classifyOperatorTransportError } from './operatorClient.js';

export const OPERATOR_QUERY_PATH = '/v1/queries';
export const DEFAULT_OPERATOR_QUERY_TIMEOUT_MS = 10_000;
export const MAX_OPERATOR_QUERY_RESPONSE_BYTES = 256 * 1024;
export const MAX_OPERATOR_BACKUP_DOWNLOAD_BYTES = 10 * 1024 * 1024 * 1024;

export type OperatorLogSource = 'sync-server' | 'operator' | 'deployment' | 'backup';
export type OperatorLogSeverity = 'error' | 'warning' | 'info';

export type OperatorQuery =
  | { type: 'host_metrics' }
  | { type: 'service_status' }
  | { type: 'deployment_status' }
  | { type: 'backup_read'; backupName: string }
  | {
      type: 'logs_read';
      source: OperatorLogSource;
      cursor?: string;
      limit: number;
      severity?: OperatorLogSeverity;
      since?: string;
    };

export interface HostMetricsResult {
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  filesystemUsedBytes: number;
  filesystemTotalBytes: number;
}

export interface ServiceStatusResult {
  services: Array<{
    name: 'sync-server' | 'operator' | 'postgres';
    state: 'running' | 'stopped' | 'failed' | 'unavailable';
    detail?: string;
  }>;
}

export interface DeploymentStatusResult {
  currentRevision: string;
  rollbackRevision: string | null;
  schemaVersion: number;
  candidates: Array<{ revision: string; committedAt: string; subject: string }>;
}

export interface LogsReadResult {
  entries: Array<{
    sequence: number;
    timestamp: string;
    severity: OperatorLogSeverity;
    message: string;
    redacted: boolean;
  }>;
  nextCursor: string | null;
}

export interface OperatorBackupDownload {
  filename: string;
  sha256: string;
  sizeBytes: number;
  stream: NodeJS.ReadableStream;
}

export interface OperatorQueryClient {
  query(
    request: Exclude<OperatorQuery, { type: 'backup_read' }>,
  ): Promise<HostMetricsResult | ServiceStatusResult | DeploymentStatusResult | LogsReadResult>;
  downloadBackup(backupName: string, signal: AbortSignal): Promise<OperatorBackupDownload>;
}

export interface CreateOperatorQueryClientOptions {
  socketPath: string;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  maxDownloadBytes?: number;
}

interface RawResponse {
  statusCode: number;
  body: string;
}

const ERROR_MESSAGES = {
  operator_unavailable: 'The operator service is not reachable',
  operator_timeout: 'The operator service did not respond in time',
  operator_invalid_response: 'The operator service returned an unusable response',
} as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const rfc3339Schema = z.string().datetime({ offset: true });
const shaSchema = z.string().regex(SHA256_PATTERN);
const hostMetricsResultSchema = z
  .object({
    cpuPercent: z.number(),
    memoryUsedBytes: z.number().int().nonnegative(),
    memoryTotalBytes: z.number().int().positive(),
    filesystemUsedBytes: z.number().int().nonnegative(),
    filesystemTotalBytes: z.number().int().positive(),
  })
  .strict();

const serviceStatusResultSchema = z
  .object({
    services: z.array(
      z
        .object({
          name: z.enum(['sync-server', 'operator', 'postgres']),
          state: z.enum(['running', 'stopped', 'failed', 'unavailable']),
          detail: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();

const deploymentStatusResultSchema = z
  .object({
    currentRevision: z.string().regex(/^[0-9a-f]{40}$/),
    rollbackRevision: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
    schemaVersion: z.number().int().nonnegative(),
    candidates: z.array(
      z
        .object({
          revision: z.string().regex(/^[0-9a-f]{40}$/),
          committedAt: rfc3339Schema,
          subject: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

const logsReadResultSchema = z
  .object({
    entries: z.array(
      z
        .object({
          sequence: z.number().int().nonnegative(),
          timestamp: rfc3339Schema,
          severity: z.enum(['error', 'warning', 'info']),
          message: z.string(),
          redacted: z.boolean(),
        })
        .strict(),
    ),
    nextCursor: z.string().nullable(),
  })
  .strict();

const operatorQueryResultSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('host_metrics'), value: hostMetricsResultSchema }).strict(),
  z.object({ type: z.literal('service_status'), value: serviceStatusResultSchema }).strict(),
  z.object({ type: z.literal('deployment_status'), value: deploymentStatusResultSchema }).strict(),
  z.object({ type: z.literal('logs_read'), value: logsReadResultSchema }).strict(),
]);

function queryError(
  code: keyof typeof ERROR_MESSAGES,
  status: number,
): OperatorClientError {
  return new OperatorClientError(code, status, ERROR_MESSAGES[code]);
}

function createAbortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError');
}

function parseAttachmentFilename(contentDisposition: string | undefined): string | null {
  if (typeof contentDisposition !== 'string') {
    return null;
  }
  const match = /filename="([^"]+)"/i.exec(contentDisposition);
  if (!match) {
    return null;
  }
  const filename = match[1] ?? '';
  if (
    filename.length === 0 ||
    filename !== path.posix.basename(filename) ||
    filename !== path.win32.basename(filename)
  ) {
    return null;
  }
  return filename;
}

export function createOperatorQueryClient(
  options: CreateOperatorQueryClientOptions,
): OperatorQueryClient {
  const socketPath = options.socketPath;
  if (!socketPath || !path.isAbsolute(socketPath)) {
    throw new SyncServerConfigError(
      'OPERATOR_SOCKET_PATH must be an absolute path (e.g. /run/ariadne/operator.sock)',
    );
  }

  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_OPERATOR_QUERY_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_OPERATOR_QUERY_RESPONSE_BYTES;
  const maxDownloadBytes = options.maxDownloadBytes ?? MAX_OPERATOR_BACKUP_DOWNLOAD_BYTES;

  function sendJson(payload: string): Promise<RawResponse> {
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
          path: OPERATOR_QUERY_PATH,
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
              settle({ err: queryError('operator_invalid_response', 502) });
              return;
            }
            chunks.push(chunk);
          });
          response.on('error', () => {
            settle({ err: queryError('operator_unavailable', 503) });
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

      const overallTimer = setTimeout(() => {
        request.destroy();
        settle({ err: queryError('operator_timeout', 504) });
      }, requestTimeoutMs);

      request.setTimeout(requestTimeoutMs, () => {
        request.destroy();
        settle({ err: queryError('operator_timeout', 504) });
      });

      request.on('error', (error: NodeJS.ErrnoException) => {
        settle({ err: classifyOperatorTransportError(error) });
      });

      request.end(payload);
    });
  }

  return {
    async query(request): Promise<
      HostMetricsResult | ServiceStatusResult | DeploymentStatusResult | LogsReadResult
    > {
      const response = await sendJson(JSON.stringify(request));
      if (response.statusCode === 503) {
        throw queryError('operator_unavailable', 503);
      }
      if (response.statusCode !== 200) {
        throw queryError('operator_invalid_response', 502);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body);
      } catch {
        throw queryError('operator_invalid_response', 502);
      }

      const result = operatorQueryResultSchema.safeParse(parsed);
      if (!result.success || result.data.type !== request.type) {
        throw queryError('operator_invalid_response', 502);
      }
      return result.data.value;
    },

    async downloadBackup(backupName: string, signal: AbortSignal): Promise<OperatorBackupDownload> {
      if (signal.aborted) {
        throw createAbortError();
      }

      const payload = JSON.stringify({ type: 'backup_read', backupName } satisfies OperatorQuery);
      return new Promise<OperatorBackupDownload>((resolve, reject) => {
        let settled = false;
        const settle = (outcome: { ok: OperatorBackupDownload } | { err: Error }): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(overallTimer);
          signal.removeEventListener('abort', abortDownload);
          if ('ok' in outcome) {
            resolve(outcome.ok);
          } else {
            reject(outcome.err);
          }
        };

        let responseStream: Readable | null = null;
        const request = http.request(
          {
            socketPath,
            path: OPERATOR_QUERY_PATH,
            method: 'POST',
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'content-length': Buffer.byteLength(payload, 'utf8'),
              accept: 'application/octet-stream',
              connection: 'close',
            },
          },
          (response) => {
            const statusCode = response.statusCode ?? 0;
            if (statusCode === 503) {
              response.resume();
              settle({ err: queryError('operator_unavailable', 503) });
              return;
            }
            if (statusCode !== 200) {
              response.resume();
              settle({ err: queryError('operator_invalid_response', 502) });
              return;
            }

            const sizeHeader = response.headers['content-length'];
            const checksumHeader = response.headers['x-ariadne-backup-sha256'];
            const dispositionHeader = response.headers['content-disposition'];
            const filename = parseAttachmentFilename(
              Array.isArray(dispositionHeader) ? dispositionHeader[0] : dispositionHeader,
            );
            const sizeBytes = Number(Array.isArray(sizeHeader) ? sizeHeader[0] : sizeHeader);
            const sha256 = Array.isArray(checksumHeader) ? checksumHeader[0] : checksumHeader;

            if (
              !Number.isInteger(sizeBytes) ||
              sizeBytes < 0 ||
              sizeBytes > maxDownloadBytes ||
              typeof sha256 !== 'string' ||
              !SHA256_PATTERN.test(sha256) ||
              filename !== backupName
            ) {
              response.destroy();
              settle({ err: queryError('operator_invalid_response', 502) });
              return;
            }

            responseStream = response;
            response.once('error', (error: Error) => {
              if (!settled) {
                settle({ err: error });
              }
            });
            settle({
              ok: {
                filename,
                sha256,
                sizeBytes,
                stream: response,
              },
            });
          },
        );

        const abortDownload = (): void => {
          const abortError = createAbortError();
          request.destroy(abortError);
          responseStream?.destroy(abortError);
          if (!settled) {
            settle({ err: abortError });
          }
        };

        const overallTimer = setTimeout(() => {
          request.destroy();
          responseStream?.destroy();
          settle({ err: queryError('operator_timeout', 504) });
        }, requestTimeoutMs);

        request.setTimeout(requestTimeoutMs, () => {
          request.destroy();
          responseStream?.destroy();
          settle({ err: queryError('operator_timeout', 504) });
        });

        request.on('error', (error: NodeJS.ErrnoException | Error) => {
          if (error.name === 'AbortError') {
            if (!settled) {
              settle({ err: error });
            }
            return;
          }
          settle({
            err:
              'code' in error
                ? classifyOperatorTransportError(error as NodeJS.ErrnoException)
                : queryError('operator_unavailable', 503),
          });
        });

        signal.addEventListener('abort', abortDownload, { once: true });
        request.end(payload);
      });
    },
  };
}
