import type { Pool, PoolClient } from 'pg';

export type AdminOperationType =
  | 'service_restart'
  | 'deployment_apply'
  | 'deployment_rollback'
  | 'file_capture_delete'
  | 'backup_create'
  | 'backup_verify'
  | 'backup_restore';

export type AdminOperationState = 'queued' | 'running' | 'succeeded' | 'failed';

export interface AdminOperation {
  id: string;
  requestedBy: string;
  type: AdminOperationType;
  state: AdminOperationState;
  summary: string;
  output: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface AdminOperationEvent {
  id: number;
  operationId: string;
  actorUserId: string | null;
  state: AdminOperationState;
  message: string;
  metadata: JsonObject;
  createdAt: string;
}

export interface AdminAuditEvent {
  id: number;
  actorUserId: string | null;
  action: string;
  source: string;
  outcome: string;
  metadata: JsonObject;
  createdAt: string;
}

export type BackupRecordStatus =
  | 'created'
  | 'verified'
  | 'verify_failed'
  | 'restored'
  | 'restore_failed';

export interface BackupRecord {
  filename: string;
  sha256: string;
  sizeBytes: number;
  status: BackupRecordStatus;
  createdAt: string;
  verifiedAt: string | null;
  restoreVerificationMessage: string | null;
}

export interface CreateAdminOperationInput {
  id: string;
  requestedBy: string;
  type: AdminOperationType;
  summary: string;
  source: string;
  createdAt?: string;
  metadata?: JsonObject;
}

export interface TransitionAdminOperationInput {
  id: string;
  nextState: Exclude<AdminOperationState, 'queued'>;
  actorUserId?: string | null;
  source: string;
  message?: string;
  metadata?: JsonObject;
  output?: string | null;
  occurredAt?: string;
  /**
   * Backup artifact described by a terminal operator result. Written inside
   * the same transaction as the state change, so an operation can never be
   * recorded terminal without the backup row it reported (or vice versa).
   */
  backupRecord?: UpsertBackupRecordInput;
}

export interface RecordAdminAuditEventInput {
  actorUserId?: string | null;
  action: string;
  source: string;
  outcome: string;
  metadata?: JsonObject;
  createdAt?: string;
}

export interface UpsertBackupRecordInput {
  filename: string;
  sha256: string;
  sizeBytes: number;
  status: BackupRecordStatus;
  createdAt: string;
  verifiedAt?: string | null;
  restoreVerificationMessage?: string | null;
}

export interface OperationsStore {
  createOperation(input: CreateAdminOperationInput): Promise<AdminOperation>;
  getOperation(id: string): Promise<AdminOperation | null>;
  listOperations(input: {
    afterCreatedAt?: string;
    limit: number;
  }): Promise<{ operations: AdminOperation[]; nextCursor: string | null }>;
  transitionOperation(input: TransitionAdminOperationInput): Promise<AdminOperation>;
  listOperationEvents(operationId: string): Promise<AdminOperationEvent[]>;
  recordAuditEvent(input: RecordAdminAuditEventInput): Promise<AdminAuditEvent>;
  listAuditEvents(input: {
    afterId?: number;
    limit: number;
    action?: string;
    outcome?: string;
  }): Promise<{ events: AdminAuditEvent[]; nextCursor: string | null }>;
  upsertBackupRecord(input: UpsertBackupRecordInput): Promise<BackupRecord>;
  getBackupRecord(filename: string): Promise<BackupRecord | null>;
  listBackupRecords(limit?: number): Promise<BackupRecord[]>;
}

export class AdminOperationNotFoundError extends Error {
  constructor(operationId: string) {
    super(`Admin operation not found: ${operationId}`);
    this.name = 'AdminOperationNotFoundError';
  }
}

export class OperationTransitionError extends Error {
  constructor(fromState: AdminOperationState, toState: AdminOperationState) {
    super(`Illegal admin operation state transition: ${fromState} -> ${toState}`);
    this.name = 'OperationTransitionError';
  }
}

type JsonPrimitive = boolean | number | string | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

interface AdminOperationRow {
  id: string;
  requested_by: string;
  type: AdminOperationType;
  state: AdminOperationState;
  summary: string;
  output: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
}

interface AdminOperationEventRow {
  id: string | number;
  operation_id: string;
  actor_user_id: string | null;
  state: AdminOperationState;
  message: string;
  metadata: JsonObject;
  created_at: Date;
}

interface AdminAuditEventRow {
  id: string | number;
  actor_user_id: string | null;
  action: string;
  source: string;
  outcome: string;
  metadata: JsonObject;
  created_at: Date;
}

interface BackupRecordRow {
  filename: string;
  sha256: string;
  size_bytes: string | number;
  status: BackupRecordStatus;
  created_at: Date;
  verified_at: Date | null;
  restore_verification_message: string | null;
}

const MAX_OPERATION_OUTPUT_BYTES = 256 * 1024;
export const OUTPUT_TRUNCATION_MARKER = '\n...[TRUNCATED TO 256 KiB]';

const KNOWN_SECRET_BLOCK_RULES = [
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: '***REDACTED PRIVATE KEY***',
  },
] as const;

const KNOWN_SECRET_INLINE_RULES = [
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: '***' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: '***' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replace: '***' },
  { pattern: /\bsk-[A-Za-z0-9]{20,}\b/g, replace: '***' },
] as const;

const SENSITIVE_KEY_CORE =
  '(?:PASSWORD|PASSWD|PWD|TOKEN|SECRET|API(?:[-_]?KEY)?|AUTH(?:ORIZATION)?|CREDENTIAL|ACCESS(?:[-_]?KEY))';

const SENSITIVE_KEY_NAME = `[A-Z0-9_-]{0,64}${SENSITIVE_KEY_CORE}[A-Z0-9_-]{0,64}`;

const SENSITIVE_VALUE = `(?:"[^"\r\n]*"|'[^'\r\n]*'|\\S+)`;

const ASSIGNMENT_RULES = [
  {
    pattern: new RegExp(
      `(^|[\\s([{,;])(--?${SENSITIVE_KEY_NAME})([=\\s]+)${SENSITIVE_VALUE}`,
      'gi',
    ),
    replace: '$1$2$3***',
  },
  {
    pattern: new RegExp(
      `((["']?)${SENSITIVE_KEY_NAME}\\2)(\\s*[:=]\\s*)${SENSITIVE_VALUE}`,
      'gi',
    ),
    replace: '$1$3***',
  },
] as const;

const SENSITIVE_KEY_PATTERN = new RegExp(`^${SENSITIVE_KEY_NAME}$`, 'i');

const LIKELY_SECRET_LINE_PATTERN = new RegExp(
  [
    '\\bAKIA[0-9A-Z]{8,}\\b',
    '\\bgh[pousr]_[A-Za-z0-9]{8,}\\b',
    '\\bxox[baprs]-[A-Za-z0-9-]{8,}\\b',
    '\\bsk-[A-Za-z0-9]{8,}\\b',
    '-----BEGIN [A-Z ]*PRIVATE KEY-----',
    `(?:^|[\\s([{,;])--?${SENSITIVE_KEY_NAME}(?:[=\\s]|$)`,
    `${SENSITIVE_KEY_NAME}\\s*[:=]`,
  ].join('|'),
  'i',
);

const ALLOWED_TRANSITIONS: Record<
  AdminOperationState,
  ReadonlyArray<Exclude<AdminOperationState, 'queued'>>
> = {
  queued: ['running', 'failed'],
  running: ['succeeded', 'failed'],
  succeeded: [],
  failed: [],
};

function toIsoString(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function sanitizeSecrets(text: string): string {
  let sanitized = text;
  for (const rule of KNOWN_SECRET_BLOCK_RULES) {
    sanitized = sanitized.replace(rule.pattern, rule.replace);
  }

  return sanitized
    .split('\n')
    .map((line) => sanitizeSecretsInLine(line))
    .join('\n');
}

function sanitizeSecretsInLine(line: string): string {
  if (!LIKELY_SECRET_LINE_PATTERN.test(line)) {
    return line;
  }

  let sanitized = line;
  for (const rule of [...KNOWN_SECRET_INLINE_RULES, ...ASSIGNMENT_RULES]) {
    sanitized = sanitized.replace(rule.pattern, rule.replace);
  }
  return sanitized;
}

function truncateUtf8(text: string, maxBytes: number, marker: string): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text;
  }

  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const budget = maxBytes - markerBytes;
  const bytes = Buffer.from(text, 'utf8');
  let truncated = bytes.subarray(0, budget).toString('utf8');
  while (Buffer.byteLength(truncated, 'utf8') > budget) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}${marker}`;
}

export function sanitizeOperationOutputForStorage(
  output: string | null | undefined,
): string | null | undefined {
  if (output === undefined || output === null) {
    return output;
  }

  return truncateUtf8(
    sanitizeSecrets(output),
    MAX_OPERATION_OUTPUT_BYTES,
    OUTPUT_TRUNCATION_MARKER,
  );
}

function sanitizeJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return sanitizeSecrets(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJsonValue(entry));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object') {
    return sanitizeJsonObject(value as Record<string, unknown>);
  }
  return String(value);
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

function sanitizeMetadata(metadata: JsonObject | undefined): JsonObject {
  if (!metadata) {
    return {};
  }
  return sanitizeJsonObject(metadata);
}

function sanitizeJsonObject(object: Record<string, unknown>): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(object)) {
    if (isSensitiveKey(key)) {
      result[key] = '***';
      continue;
    }
    result[key] = sanitizeJsonValue(value);
  }
  return result;
}

function mapOperation(row: AdminOperationRow): AdminOperation {
  return {
    id: row.id,
    requestedBy: row.requested_by,
    type: row.type,
    state: row.state,
    summary: row.summary,
    output: row.output,
    startedAt: toIsoString(row.started_at),
    completedAt: toIsoString(row.completed_at),
    createdAt: row.created_at.toISOString(),
  };
}

function mapOperationEvent(row: AdminOperationEventRow): AdminOperationEvent {
  return {
    id: Number(row.id),
    operationId: row.operation_id,
    actorUserId: row.actor_user_id,
    state: row.state,
    message: row.message,
    metadata: row.metadata ?? {},
    createdAt: row.created_at.toISOString(),
  };
}

function mapAuditEvent(row: AdminAuditEventRow): AdminAuditEvent {
  return {
    id: Number(row.id),
    actorUserId: row.actor_user_id,
    action: row.action,
    source: row.source,
    outcome: row.outcome,
    metadata: row.metadata ?? {},
    createdAt: row.created_at.toISOString(),
  };
}

function mapBackupRecord(row: BackupRecordRow): BackupRecord {
  return {
    filename: row.filename,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    status: row.status,
    createdAt: row.created_at.toISOString(),
    verifiedAt: toIsoString(row.verified_at),
    restoreVerificationMessage: row.restore_verification_message,
  };
}

interface OperationListCursor {
  createdAt: string;
  id: string;
}

function encodeOperationCursor(operation: AdminOperation): string {
  return Buffer.from(
    JSON.stringify({ createdAt: operation.createdAt, id: operation.id } satisfies OperationListCursor),
    'utf8',
  ).toString('base64url');
}

function decodeOperationCursor(cursor: string | undefined): OperationListCursor | null {
  if (!cursor) {
    return null;
  }

  const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<OperationListCursor>;
  if (
    typeof parsed.createdAt !== 'string' ||
    parsed.createdAt.length === 0 ||
    typeof parsed.id !== 'string' ||
    parsed.id.length === 0
  ) {
    throw new Error('invalid operation cursor');
  }

  return {
    createdAt: parsed.createdAt,
    id: parsed.id,
  };
}

async function withTransaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function insertOperationEvent(
  client: PoolClient,
  input: {
    operationId: string;
    actorUserId?: string | null;
    state: AdminOperationState;
    message: string;
    metadata?: JsonObject;
    createdAt?: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO admin_operation_events (
       operation_id, actor_user_id, state, message, metadata, created_at
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, COALESCE($6::timestamptz, now()))`,
    [
      input.operationId,
      input.actorUserId ?? null,
      input.state,
      input.message,
      JSON.stringify(sanitizeMetadata(input.metadata)),
      input.createdAt ?? null,
    ],
  );
}

async function insertAuditEvent(
  client: PoolClient,
  input: RecordAdminAuditEventInput,
): Promise<AdminAuditEvent> {
  const { rows } = await client.query<AdminAuditEventRow>(
    `INSERT INTO admin_audit_events (
       actor_user_id, action, source, outcome, metadata, created_at
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, COALESCE($6::timestamptz, now()))
     RETURNING id, actor_user_id, action, source, outcome, metadata, created_at`,
    [
      input.actorUserId ?? null,
      input.action,
      input.source,
      input.outcome,
      JSON.stringify(sanitizeMetadata(input.metadata)),
      input.createdAt ?? null,
    ],
  );
  return mapAuditEvent(rows[0]);
}

/**
 * Upserts one backup artifact row.
 *
 * A backup is identified by its filename, and later reports about it (a
 * verification, a restore) only ever refine what is already recorded. So the
 * creation timestamp of an existing row is never rewritten, and an earlier
 * successful verification timestamp is kept unless the caller supplies a newer
 * one: those are historical facts about the artifact. The status and the
 * human-readable message always describe the *latest* report, so both are
 * replaced — a stale "verified cleanly" note must never survive a failure.
 */
async function upsertBackupRecordRow(
  client: PoolClient,
  input: UpsertBackupRecordInput,
): Promise<BackupRecord> {
  const { rows } = await client.query<BackupRecordRow>(
    `INSERT INTO backup_records (
       filename,
       sha256,
       size_bytes,
       status,
       created_at,
       verified_at,
       restore_verification_message
     )
     VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7)
     ON CONFLICT (filename) DO UPDATE
     SET
       sha256 = EXCLUDED.sha256,
       size_bytes = EXCLUDED.size_bytes,
       status = EXCLUDED.status,
       created_at = backup_records.created_at,
       verified_at = COALESCE(EXCLUDED.verified_at, backup_records.verified_at),
       restore_verification_message = EXCLUDED.restore_verification_message
     RETURNING
       filename,
       sha256,
       size_bytes,
       status,
       created_at,
       verified_at,
       restore_verification_message`,
    [
      input.filename,
      input.sha256,
      input.sizeBytes,
      input.status,
      input.createdAt,
      input.verifiedAt ?? null,
      input.restoreVerificationMessage ?? null,
    ],
  );
  return mapBackupRecord(rows[0]);
}

export function createOperationsStore(pool: Pool): OperationsStore {
  return {
    async createOperation(input: CreateAdminOperationInput): Promise<AdminOperation> {
      return withTransaction(pool, async (client) => {
        const { rows } = await client.query<AdminOperationRow>(
          `INSERT INTO admin_operations (
             id, requested_by, type, state, summary, output, started_at, completed_at, created_at
           )
           VALUES ($1, $2, $3, 'queued', $4, NULL, NULL, NULL, COALESCE($5::timestamptz, now()))
           RETURNING
             id,
             requested_by,
             type,
             state,
             summary,
             output,
             started_at,
             completed_at,
             created_at`,
          [input.id, input.requestedBy, input.type, input.summary, input.createdAt ?? null],
        );

        await insertOperationEvent(client, {
          operationId: input.id,
          actorUserId: input.requestedBy,
          state: 'queued',
          message: 'Operation queued',
          metadata: input.metadata,
          createdAt: input.createdAt,
        });

        await insertAuditEvent(client, {
          actorUserId: input.requestedBy,
          action: 'admin_operation.created',
          source: input.source,
          outcome: 'accepted',
          metadata: {
            ...sanitizeMetadata(input.metadata),
            operationId: input.id,
            type: input.type,
            state: 'queued',
          },
          createdAt: input.createdAt,
        });

        return mapOperation(rows[0]);
      });
    },

    async getOperation(id: string): Promise<AdminOperation | null> {
      const { rows } = await pool.query<AdminOperationRow>(
        `SELECT
           id,
           requested_by,
           type,
           state,
           summary,
           output,
           started_at,
           completed_at,
           created_at
         FROM admin_operations
         WHERE id = $1`,
        [id],
      );
      return rows[0] ? mapOperation(rows[0]) : null;
    },

    async listOperations(input: {
      afterCreatedAt?: string;
      limit: number;
    }): Promise<{ operations: AdminOperation[]; nextCursor: string | null }> {
      const cursor = decodeOperationCursor(input.afterCreatedAt);
      const { rows } = await pool.query<AdminOperationRow>(
        `SELECT
           id,
           requested_by,
           type,
           state,
           summary,
           output,
           started_at,
           completed_at,
           created_at
         FROM admin_operations
         WHERE (
           $1::timestamptz IS NULL
           OR (created_at, id) < ($1::timestamptz, $2::text)
         )
         ORDER BY created_at DESC, id DESC
         LIMIT $3`,
        [cursor?.createdAt ?? null, cursor?.id ?? null, input.limit + 1],
      );
      const operations = rows.slice(0, input.limit).map(mapOperation);
      return {
        operations,
        nextCursor:
          rows.length > input.limit && operations.length > 0
            ? encodeOperationCursor(operations.at(-1)!)
            : null,
      };
    },

    async transitionOperation(input: TransitionAdminOperationInput): Promise<AdminOperation> {
      return withTransaction(pool, async (client) => {
        const existing = await client.query<AdminOperationRow>(
          `SELECT
             id,
             requested_by,
             type,
             state,
             summary,
             output,
             started_at,
             completed_at,
             created_at
           FROM admin_operations
           WHERE id = $1
           FOR UPDATE`,
          [input.id],
        );
        const row = existing.rows[0];
        if (!row) {
          throw new AdminOperationNotFoundError(input.id);
        }

        if (!ALLOWED_TRANSITIONS[row.state].includes(input.nextState)) {
          throw new OperationTransitionError(row.state, input.nextState);
        }

        const occurredAt = input.occurredAt ?? new Date().toISOString();
        const nextStartedAt =
          input.nextState === 'running' ? occurredAt : row.started_at?.toISOString() ?? null;
        const nextCompletedAt =
          input.nextState === 'running' ? null : occurredAt;
        const nextOutput =
          input.output === undefined
            ? row.output
            : sanitizeOperationOutputForStorage(input.output);

        const { rows } = await client.query<AdminOperationRow>(
          `UPDATE admin_operations
           SET
             state = $2,
             output = $3,
             started_at = $4::timestamptz,
             completed_at = $5::timestamptz
           WHERE id = $1
           RETURNING
             id,
             requested_by,
             type,
             state,
             summary,
             output,
             started_at,
             completed_at,
             created_at`,
          [input.id, input.nextState, nextOutput ?? null, nextStartedAt, nextCompletedAt],
        );

        await insertOperationEvent(client, {
          operationId: input.id,
          actorUserId: input.actorUserId ?? row.requested_by,
          state: input.nextState,
          message: input.message ?? `Operation ${input.nextState}`,
          metadata: input.metadata,
          createdAt: occurredAt,
        });

        await insertAuditEvent(client, {
          actorUserId: input.actorUserId ?? row.requested_by,
          action: 'admin_operation.state_changed',
          source: input.source,
          outcome: input.nextState,
          metadata: {
            ...sanitizeMetadata(input.metadata),
            operationId: row.id,
            type: row.type,
            fromState: row.state,
            toState: input.nextState,
            state: input.nextState,
          },
          createdAt: occurredAt,
        });

        if (input.backupRecord) {
          await upsertBackupRecordRow(client, input.backupRecord);
        }

        return mapOperation(rows[0]);
      });
    },

    async listOperationEvents(operationId: string): Promise<AdminOperationEvent[]> {
      const { rows } = await pool.query<AdminOperationEventRow>(
        `SELECT
           id,
           operation_id,
           actor_user_id,
           state,
           message,
           metadata,
           created_at
         FROM admin_operation_events
         WHERE operation_id = $1
         ORDER BY created_at ASC, id ASC`,
        [operationId],
      );
      return rows.map(mapOperationEvent);
    },

    async recordAuditEvent(input: RecordAdminAuditEventInput): Promise<AdminAuditEvent> {
      return withTransaction(pool, async (client) => insertAuditEvent(client, input));
    },

    async listAuditEvents(input: {
      afterId?: number;
      limit: number;
      action?: string;
      outcome?: string;
    }): Promise<{ events: AdminAuditEvent[]; nextCursor: string | null }> {
      const { rows } = await pool.query<AdminAuditEventRow>(
        `SELECT
           id,
           actor_user_id,
           action,
           source,
           outcome,
           metadata,
           created_at
         FROM admin_audit_events
         WHERE ($1::bigint IS NULL OR id < $1)
           AND ($2::text IS NULL OR action = $2)
           AND ($3::text IS NULL OR outcome = $3)
         ORDER BY created_at DESC, id DESC
         LIMIT $4`,
        [input.afterId ?? null, input.action ?? null, input.outcome ?? null, input.limit + 1],
      );
      const events = rows.slice(0, input.limit).map(mapAuditEvent);
      return {
        events,
        nextCursor:
          rows.length > input.limit && events.length > 0 ? String(events.at(-1)!.id) : null,
      };
    },

    async upsertBackupRecord(input: UpsertBackupRecordInput): Promise<BackupRecord> {
      const client = await pool.connect();
      try {
        return await upsertBackupRecordRow(client, input);
      } finally {
        client.release();
      }
    },

    async getBackupRecord(filename: string): Promise<BackupRecord | null> {
      const { rows } = await pool.query<BackupRecordRow>(
        `SELECT
           filename,
           sha256,
           size_bytes,
           status,
           created_at,
           verified_at,
           restore_verification_message
         FROM backup_records
         WHERE filename = $1
         LIMIT 1`,
        [filename],
      );
      return rows[0] ? mapBackupRecord(rows[0]) : null;
    },

    async listBackupRecords(limit = 50): Promise<BackupRecord[]> {
      const { rows } = await pool.query<BackupRecordRow>(
        `SELECT
           filename,
           sha256,
           size_bytes,
           status,
           created_at,
           verified_at,
           restore_verification_message
         FROM backup_records
         ORDER BY created_at DESC, filename DESC
         LIMIT $1`,
        [limit],
      );
      return rows.map(mapBackupRecord);
    },
  };
}
