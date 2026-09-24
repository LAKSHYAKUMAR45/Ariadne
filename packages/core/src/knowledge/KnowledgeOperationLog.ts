import type Database from 'better-sqlite3';
import { redact } from '../Redactor.js';
import { createKnowledgeId } from './KnowledgeIds.js';

const SENSITIVE_DETAIL_KEY = /(?:password|passwd|pwd|token|secret|api[-_]?key|apikey|auth|credential|access[-_]?key)/i;
const OPERATION_STATUSES = new Set<KnowledgeOperationStatus>(['success', 'failure', 'cancelled']);

export type KnowledgeOperationStatus = 'success' | 'failure' | 'cancelled';

export interface KnowledgeOperationEvent {
  id: string;
  projectId: string;
  operationKind: string;
  status: KnowledgeOperationStatus;
  detail: Record<string, unknown>;
  createdAt: string;
  completedAt: string | null;
}

export interface AppendKnowledgeOperationInput {
  id?: string;
  projectId: string;
  operationKind: string;
  status: KnowledgeOperationStatus;
  detail: Record<string, unknown>;
  createdAt?: string;
  completedAt?: string | null;
}

export interface ListKnowledgeOperationsOptions {
  limit?: number;
  status?: KnowledgeOperationStatus;
  operationKind?: string;
}

interface KnowledgeOperationRow {
  id: string;
  project_id: string;
  operation_kind: string;
  status: KnowledgeOperationStatus;
  detail_json: string;
  created_at: string;
  completed_at: string | null;
}

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Knowledge operation ${label} must not be empty`);
  }
}

function redactOperationValue(value: unknown, key?: string): unknown {
  if (key !== undefined && SENSITIVE_DETAIL_KEY.test(key)) {
    return '***';
  }

  if (typeof value === 'string') {
    return redact(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactOperationValue(item));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).flatMap(([entryKey, entryValue]) =>
        entryValue === undefined ? [] : [[entryKey, redactOperationValue(entryValue, entryKey)]],
      ),
    );
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    return null;
  }

  return value;
}

function redactOperationDetail(detail: Record<string, unknown>): Record<string, unknown> {
  return redactOperationValue(detail) as Record<string, unknown>;
}

function rowToKnowledgeOperation(row: KnowledgeOperationRow): KnowledgeOperationEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    operationKind: row.operation_kind,
    status: row.status,
    detail: JSON.parse(row.detail_json) as Record<string, unknown>,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

/**
 * Appends durable, secret-redacted knowledge operation telemetry.
 */
export class KnowledgeOperationLog {
  constructor(private readonly db: Database.Database) {}

  appendKnowledgeOperation(input: AppendKnowledgeOperationInput): KnowledgeOperationEvent {
    requireNonEmpty(input.projectId, 'project ID');
    requireNonEmpty(input.operationKind, 'kind');
    if (!OPERATION_STATUSES.has(input.status)) {
      throw new Error(`Unsupported knowledge operation status: ${input.status}`);
    }

    const event: KnowledgeOperationEvent = {
      id: input.id ?? createKnowledgeId('operation'),
      projectId: input.projectId,
      operationKind: input.operationKind,
      status: input.status,
      detail: redactOperationDetail(input.detail),
      createdAt: input.createdAt ?? new Date().toISOString(),
      completedAt: input.completedAt ?? null,
    };

    this.db
      .prepare(
        `INSERT INTO knowledge_operation_log (
          id, project_id, operation_kind, status, detail_json, created_at, completed_at
        ) VALUES (@id, @projectId, @operationKind, @status, @detailJson, @createdAt, @completedAt)`,
      )
      .run({
        ...event,
        detailJson: JSON.stringify(event.detail),
      });

    return event;
  }

  listKnowledgeOperations(
    projectId: string,
    options: ListKnowledgeOperationsOptions = {},
  ): KnowledgeOperationEvent[] {
    requireNonEmpty(projectId, 'project ID');

    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
      throw new Error('Knowledge operation list limit must be a positive integer');
    }

    const clauses = ['project_id = @projectId'];
    const parameters: Record<string, string | number> = { projectId };
    if (options.status !== undefined) {
      clauses.push('status = @status');
      parameters.status = options.status;
    }
    if (options.operationKind !== undefined) {
      clauses.push('operation_kind = @operationKind');
      parameters.operationKind = options.operationKind;
    }

    const limit = options.limit === undefined ? '' : ' LIMIT @limit';
    if (options.limit !== undefined) {
      parameters.limit = options.limit;
    }

    const rows = this.db
      .prepare(
        `SELECT id, project_id, operation_kind, status, detail_json, created_at, completed_at
         FROM knowledge_operation_log
         WHERE ${clauses.join(' AND ')}
        ORDER BY rowid DESC${limit}`,
      )
      .all(parameters) as KnowledgeOperationRow[];

    return rows.map(rowToKnowledgeOperation);
  }
}
