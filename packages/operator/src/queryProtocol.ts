import { z } from 'zod';
import { isBackupBasename } from './protocol.js';

const RFC_3339_MESSAGE = 'timestamp must be RFC 3339 with timezone';

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

export interface BackupReadResult {
  filename: string;
  sha256: string;
  sizeBytes: number;
  stream: NodeJS.ReadableStream;
}

export type OperatorQueryResult =
  | { type: 'host_metrics'; value: HostMetricsResult }
  | { type: 'service_status'; value: ServiceStatusResult }
  | { type: 'deployment_status'; value: DeploymentStatusResult }
  | { type: 'logs_read'; value: LogsReadResult }
  | { type: 'backup_read'; value: BackupReadResult };

export interface OperatorQueryExecutor {
  execute(query: OperatorQuery): Promise<OperatorQueryResult>;
}

export interface OperatorLogCursor {
  timestamp: string;
  sequence: number;
}

const rfc3339Schema = z.string().datetime({ offset: true, message: RFC_3339_MESSAGE });

const backupNameSchema = z
  .string()
  .min(1, 'backupName is required')
  .refine(isBackupBasename, 'backupName must be a basename without path separators');

const operatorLogCursorSchema = z
  .object({
    timestamp: rfc3339Schema,
    sequence: z.number().int().min(0),
  })
  .strict();

const cursorSchema = z
  .string()
  .min(1)
  .transform((value, context) => {
    let decoded = '';
    try {
      decoded = Buffer.from(value, 'base64url').toString('utf8');
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'cursor must be base64url JSON' });
      return z.NEVER;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'cursor must be base64url JSON' });
      return z.NEVER;
    }

    const result = operatorLogCursorSchema.safeParse(parsed);
    if (!result.success) {
      for (const issue of result.error.issues) {
        context.addIssue(issue);
      }
      return z.NEVER;
    }

    return value;
  });

const hostMetricsQuerySchema = z.object({ type: z.literal('host_metrics') }).strict();
const serviceStatusQuerySchema = z.object({ type: z.literal('service_status') }).strict();
const deploymentStatusQuerySchema = z.object({ type: z.literal('deployment_status') }).strict();
const backupReadQuerySchema = z
  .object({
    type: z.literal('backup_read'),
    backupName: backupNameSchema,
  })
  .strict();

const logsReadQuerySchema = z
  .object({
    type: z.literal('logs_read'),
    source: z.enum(['sync-server', 'operator', 'deployment', 'backup']),
    cursor: cursorSchema.optional(),
    limit: z.number().int().min(1).max(500),
    severity: z.enum(['error', 'warning', 'info']).optional(),
    since: rfc3339Schema.optional(),
  })
  .strict();

export const operatorQuerySchema = z.discriminatedUnion('type', [
  hostMetricsQuerySchema,
  serviceStatusQuerySchema,
  deploymentStatusQuerySchema,
  backupReadQuerySchema,
  logsReadQuerySchema,
]);

export function parseOperatorQuery(input: unknown): OperatorQuery {
  return operatorQuerySchema.parse(input);
}

export function encodeOperatorLogCursor(cursor: OperatorLogCursor): string {
  return Buffer.from(JSON.stringify(operatorLogCursorSchema.parse(cursor)), 'utf8').toString(
    'base64url',
  );
}

export function decodeOperatorLogCursor(cursor: string): OperatorLogCursor {
  return operatorLogCursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
}
