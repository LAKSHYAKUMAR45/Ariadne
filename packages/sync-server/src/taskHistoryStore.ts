import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Pool, PoolClient } from 'pg';
import type { EncryptedBlob, EncryptionKeyring } from './encryption.js';
import { ApiError } from './errors.js';
import { inaccessibleTaskError } from './taskAccess.js';

/** Mirrors `FileCaptureTrigger` in @ariadne-dev/core without a package dependency. */
export type FileCaptureTrigger = 'git_commit' | 'checkpoint' | 'explicit';

export type BlobType = 'snapshot' | 'diff';

export interface StoreCaptureEntryInput {
  path: string;
  content: Buffer;
  unifiedDiff: Buffer;
  contentSha256: string;
}

export interface StoreCaptureInput {
  captureId: string;
  teamId: string;
  taskId: string;
  trigger: FileCaptureTrigger;
  gitCommitSha: string | null;
  checkpointId: string | null;
  createdAt: string;
  entries: StoreCaptureEntryInput[];
}

export interface StoreCaptureResult {
  captureId: string;
  status: 'stored' | 'duplicate';
  entryCount: number;
}

export interface CaptureEntry {
  path: string;
  content: Buffer;
  unifiedDiff: Buffer;
  contentSha256: string;
}

export interface CaptureRecord {
  captureId: string;
  teamId: string;
  taskId: string;
  trigger: FileCaptureTrigger;
  gitCommitSha: string | null;
  checkpointId: string | null;
  createdAt: string;
  entries: CaptureEntry[];
}

export interface DeleteCaptureInput {
  teamId: string;
  taskId: string;
  captureId: string;
  actorUserId: string;
  reason: string;
}

export interface DeleteCaptureResult {
  deletionId: string;
  captureId: string;
  deletedPaths: string[];
  deletedEntryCount: number;
  deletedBlobCount: number;
}

export interface TaskHistoryStore {
  storeCapture(input: StoreCaptureInput): Promise<StoreCaptureResult>;
  readCapture(teamId: string, taskId: string, captureId: string): Promise<CaptureRecord>;
  deleteCapture(input: DeleteCaptureInput): Promise<DeleteCaptureResult>;
}

export interface ServerCaptureLimits {
  /** Inclusive maximum byte length of a single snapshot or diff payload. */
  maxFileBytes: number;
  /** Inclusive maximum total snapshot (and, separately, diff) bytes per capture. */
  maxCaptureBytes: number;
  /** Inclusive maximum number of entries in one capture. */
  maxEntries: number;
}

/** Server-side mirror of the client guardrails in docs §7.2. */
export const DEFAULT_SERVER_CAPTURE_LIMITS: ServerCaptureLimits = {
  maxFileBytes: 1024 * 1024,
  maxCaptureBytes: 10 * 1024 * 1024,
  maxEntries: 2000,
};

export class TaskHistoryValidationError extends ApiError {
  constructor(message: string) {
    super(400, 'invalid_capture', message);
    this.name = 'TaskHistoryValidationError';
  }
}

export class TaskHistoryLimitError extends ApiError {
  constructor(message: string) {
    super(413, 'capture_too_large', message);
    this.name = 'TaskHistoryLimitError';
  }
}

export class TaskHistoryConflictError extends ApiError {
  constructor(captureId: string) {
    super(409, 'capture_conflict', `Capture ${captureId} already exists with different contents`);
    this.name = 'TaskHistoryConflictError';
  }
}

export class CaptureNotFoundError extends ApiError {
  constructor(captureId: string) {
    super(404, 'capture_not_found', `No capture with id ${captureId}`);
    this.name = 'CaptureNotFoundError';
  }
}

export class ForbiddenActorError extends ApiError {
  constructor() {
    super(403, 'forbidden_actor', 'Actor is not an active member of the team');
    this.name = 'ForbiddenActorError';
  }
}

export class CaptureIntegrityError extends ApiError {
  constructor(message: string) {
    super(500, 'capture_integrity_error', message);
    this.name = 'CaptureIntegrityError';
  }
}

const BLOB_AAD_VERSION = 1;
const COMPRESSION = 'gzip';
const MAX_CAPTURE_ID_LENGTH = 200;
const MAX_CHECKPOINT_ID_LENGTH = 200;
const MAX_PATH_LENGTH = 1024;
const MAX_REASON_LENGTH = 500;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const TRIGGERS: readonly FileCaptureTrigger[] = ['git_commit', 'checkpoint', 'explicit'];

interface NormalizedEntry {
  path: string;
  content: Buffer;
  unifiedDiff: Buffer;
  contentSha256: string;
  diffSha256: string;
}

interface NormalizedCapture {
  captureId: string;
  teamId: string;
  taskId: string;
  trigger: FileCaptureTrigger;
  gitCommitSha: string | null;
  checkpointId: string | null;
  createdAt: string;
  entries: NormalizedEntry[];
}

interface BlobRow {
  id: string;
  team_id: string;
  plaintext_sha256: string;
  blob_type: BlobType;
  key_id: string;
  aad_version: number;
  compression: string;
  nonce: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
  plaintext_bytes: number;
}

function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new TaskHistoryValidationError(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

function requireSafeId(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new TaskHistoryValidationError(`${field} must be 1-${maxLength} characters`);
  }
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new TaskHistoryValidationError(`${field} contains unsupported characters`);
  }
  return value;
}

function requireIsoTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    throw new TaskHistoryValidationError(`${field} must be an ISO-8601 timestamp`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TaskHistoryValidationError(`${field} must be an ISO-8601 timestamp`);
  }
  return parsed.toISOString();
}

/**
 * Accepts only workspace-relative, normalized POSIX paths. Absolute paths,
 * traversal segments, backslashes, and control characters are rejected before
 * any ciphertext is produced.
 */
function requireCapturePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH) {
    throw new TaskHistoryValidationError(`Capture entry path must be 1-${MAX_PATH_LENGTH} characters`);
  }
  if (/[\u0000-\u001f\\]/.test(value)) {
    throw new TaskHistoryValidationError('Capture entry path contains unsupported characters');
  }
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw new TaskHistoryValidationError('Capture entry path must be workspace-relative');
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new TaskHistoryValidationError('Capture entry path must be a normalized relative path');
  }
  return value;
}

function requireBuffer(value: unknown, field: string): Buffer {
  if (!Buffer.isBuffer(value)) {
    throw new TaskHistoryValidationError(`${field} must be a Buffer`);
  }
  return value;
}

function normalizeEntries(
  entries: unknown,
  limits: ServerCaptureLimits,
): NormalizedEntry[] {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new TaskHistoryValidationError('Capture must contain at least one entry');
  }
  if (entries.length > limits.maxEntries) {
    throw new TaskHistoryLimitError(`Capture exceeds the ${limits.maxEntries}-entry limit`);
  }

  const seen = new Set<string>();
  const normalized: NormalizedEntry[] = [];
  for (const raw of entries as StoreCaptureEntryInput[]) {
    const path = requireCapturePath(raw?.path);
    if (seen.has(path)) {
      throw new TaskHistoryValidationError('Capture contains duplicate entry paths');
    }
    seen.add(path);

    const content = requireBuffer(raw?.content, 'Capture entry content');
    const unifiedDiff = requireBuffer(raw?.unifiedDiff, 'Capture entry diff');
    if (typeof raw?.contentSha256 !== 'string' || !SHA256_PATTERN.test(raw.contentSha256)) {
      throw new TaskHistoryValidationError('Capture entry contentSha256 must be lowercase hex');
    }

    const actual = sha256Hex(content);
    if (actual !== raw.contentSha256) {
      throw new TaskHistoryValidationError(`Capture entry content hash mismatch for ${path}`);
    }

    normalized.push({
      path,
      content,
      unifiedDiff,
      contentSha256: actual,
      diffSha256: sha256Hex(unifiedDiff),
    });
  }

  normalized.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  assertWithinLimits(normalized, limits);
  return normalized;
}

function assertWithinLimits(entries: NormalizedEntry[], limits: ServerCaptureLimits): void {
  let totalContent = 0;
  let totalDiff = 0;

  for (const entry of entries) {
    if (entry.content.length > limits.maxFileBytes) {
      throw new TaskHistoryLimitError(`Capture entry ${entry.path} exceeds the per-file size limit`);
    }
    if (entry.unifiedDiff.length > limits.maxFileBytes) {
      throw new TaskHistoryLimitError(`Capture diff for ${entry.path} exceeds the per-file size limit`);
    }
    totalContent += entry.content.length;
    totalDiff += entry.unifiedDiff.length;
  }

  if (totalContent > limits.maxCaptureBytes || totalDiff > limits.maxCaptureBytes) {
    throw new TaskHistoryLimitError('Capture exceeds the total capture size limit');
  }
}

function normalizeCapture(input: StoreCaptureInput, limits: ServerCaptureLimits): NormalizedCapture {
  if (!input || typeof input !== 'object') {
    throw new TaskHistoryValidationError('Capture input must be an object');
  }

  const trigger = input.trigger;
  if (!TRIGGERS.includes(trigger)) {
    throw new TaskHistoryValidationError('Capture trigger is not supported');
  }

  let gitCommitSha: string | null = null;
  if (input.gitCommitSha !== null && input.gitCommitSha !== undefined) {
    if (typeof input.gitCommitSha !== 'string' || !GIT_SHA_PATTERN.test(input.gitCommitSha)) {
      throw new TaskHistoryValidationError('Capture gitCommitSha must be a lowercase hex Git SHA');
    }
    gitCommitSha = input.gitCommitSha;
  }

  let checkpointId: string | null = null;
  if (input.checkpointId !== null && input.checkpointId !== undefined) {
    checkpointId = requireSafeId(input.checkpointId, 'Capture checkpointId', MAX_CHECKPOINT_ID_LENGTH);
  }

  if (trigger === 'git_commit' && gitCommitSha === null) {
    throw new TaskHistoryValidationError('Commit captures require a gitCommitSha');
  }
  if (trigger === 'checkpoint' && checkpointId === null) {
    throw new TaskHistoryValidationError('Checkpoint captures require a checkpointId');
  }

  return {
    captureId: requireSafeId(input.captureId, 'Capture id', MAX_CAPTURE_ID_LENGTH),
    teamId: requireUuid(input.teamId, 'Capture teamId'),
    taskId: requireUuid(input.taskId, 'Capture taskId'),
    trigger,
    gitCommitSha,
    checkpointId,
    createdAt: requireIsoTimestamp(input.createdAt, 'Capture createdAt'),
    entries: normalizeEntries(input.entries, limits),
  };
}

/**
 * Stable additional authenticated data for one blob. It deliberately excludes
 * capture id and path so that one deduplicated ciphertext can be referenced by
 * many capture entries; capture/task/path integrity is enforced by the
 * transactional foreign keys in migration 0007.
 */
function buildBlobAad(fields: {
  aadVersion: number;
  teamId: string;
  plaintextSha256: string;
  blobType: BlobType;
  keyId: string;
  compression: string;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema: 'ariadne.encrypted_blob',
      v: fields.aadVersion,
      teamId: fields.teamId,
      plaintextSha256: fields.plaintextSha256,
      blobType: fields.blobType,
      keyId: fields.keyId,
      compression: fields.compression,
    }),
    'utf8',
  );
}

function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  if (candidate.code !== '23505') {
    return false;
  }
  return constraint === undefined || candidate.constraint === constraint;
}

export function createTaskHistoryStore(
  pool: Pool,
  keyring: EncryptionKeyring,
  limits: ServerCaptureLimits = DEFAULT_SERVER_CAPTURE_LIMITS,
): TaskHistoryStore {
  async function withTransaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
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

  /** Inserts (or reuses) the team-scoped content-addressed blob for `plaintext`. */
  async function upsertBlob(
    client: PoolClient,
    teamId: string,
    blobType: BlobType,
    plaintext: Buffer,
    plaintextSha256: string,
  ): Promise<string> {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM encrypted_blobs
       WHERE team_id = $1 AND plaintext_sha256 = $2 AND blob_type = $3
       FOR SHARE`,
      [teamId, plaintextSha256, blobType],
    );
    if (existing.rows.length > 0) {
      return existing.rows[0].id;
    }

    const compressed = gzipSync(plaintext);
    const keyId = keyring.activeKeyId;
    const aad = buildBlobAad({
      aadVersion: BLOB_AAD_VERSION,
      teamId,
      plaintextSha256,
      blobType,
      keyId,
      compression: COMPRESSION,
    });
    const encrypted: EncryptedBlob = keyring.encrypt(compressed, aad);

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO encrypted_blobs (
         team_id, plaintext_sha256, blob_type, key_id, aad_version, compression,
         nonce, ciphertext, auth_tag, plaintext_bytes, compressed_bytes, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
       ON CONFLICT (team_id, plaintext_sha256, blob_type) DO NOTHING
       RETURNING id`,
      [
        teamId,
        plaintextSha256,
        blobType,
        encrypted.keyId,
        BLOB_AAD_VERSION,
        COMPRESSION,
        encrypted.nonce,
        encrypted.ciphertext,
        encrypted.authTag,
        plaintext.length,
        compressed.length,
      ],
    );
    if (inserted.rows.length > 0) {
      return inserted.rows[0].id;
    }

    const raced = await client.query<{ id: string }>(
      `SELECT id FROM encrypted_blobs
       WHERE team_id = $1 AND plaintext_sha256 = $2 AND blob_type = $3
       FOR SHARE`,
      [teamId, plaintextSha256, blobType],
    );
    if (raced.rows.length === 0) {
      throw new CaptureIntegrityError('Encrypted blob could not be stored');
    }
    return raced.rows[0].id;
  }

  async function loadBlobs(teamId: string, blobIds: string[]): Promise<Map<string, BlobRow>> {
    const unique = Array.from(new Set(blobIds));
    if (unique.length === 0) {
      return new Map();
    }

    const { rows } = await pool.query<BlobRow>(
      `SELECT id, team_id, plaintext_sha256, blob_type, key_id, aad_version, compression,
              nonce, ciphertext, auth_tag, plaintext_bytes
       FROM encrypted_blobs
       WHERE id = ANY($1::uuid[]) AND team_id = $2`,
      [unique, teamId],
    );
    return new Map(rows.map((row) => [row.id, row]));
  }

  function decryptBlob(row: BlobRow): Buffer {    const aad = buildBlobAad({
      aadVersion: row.aad_version,
      teamId: row.team_id,
      plaintextSha256: row.plaintext_sha256,
      blobType: row.blob_type,
      keyId: row.key_id,
      compression: row.compression,
    });

    let plaintext: Buffer;
    try {
      const compressed = keyring.decrypt(
        {
          keyId: row.key_id,
          nonce: row.nonce,
          ciphertext: row.ciphertext,
          authTag: row.auth_tag,
        },
        aad,
      );
      plaintext = row.compression === COMPRESSION ? gunzipSync(compressed) : compressed;
    } catch {
      throw new CaptureIntegrityError('Stored capture content failed authentication');
    }

    if (row.compression !== COMPRESSION) {
      throw new CaptureIntegrityError('Stored capture content uses an unsupported compression');
    }
    if (plaintext.length !== row.plaintext_bytes || sha256Hex(plaintext) !== row.plaintext_sha256) {
      throw new CaptureIntegrityError('Stored capture content failed integrity verification');
    }
    return plaintext;
  }

  async function readExistingFingerprint(
    client: PoolClient,
    captureId: string,
  ): Promise<{
    teamId: string;
    taskId: string;
    trigger: FileCaptureTrigger;
    gitCommitSha: string | null;
    checkpointId: string | null;
    createdAt: string;
    entries: Array<{ path: string; contentSha256: string; diffSha256: string }>;
  } | null> {
    const capture = await client.query<{
      team_id: string;
      task_id: string;
      trigger: FileCaptureTrigger;
      git_commit_sha: string | null;
      checkpoint_id: string | null;
      created_at: Date;
    }>(
      `SELECT team_id, task_id, "trigger", git_commit_sha, checkpoint_id, created_at
       FROM task_file_captures WHERE id = $1 FOR UPDATE`,
      [captureId],
    );
    if (capture.rows.length === 0) {
      return null;
    }

    const entries = await client.query<{
      path: string;
      content_sha256: string;
      diff_sha256: string;
    }>(
      `SELECT e.path, e.content_sha256, d.plaintext_sha256 AS diff_sha256
       FROM task_file_capture_entries e
       JOIN encrypted_blobs d ON d.id = e.diff_blob_id
       WHERE e.capture_id = $1
       ORDER BY e.path ASC`,
      [captureId],
    );

    const row = capture.rows[0];
    return {
      teamId: row.team_id,
      taskId: row.task_id,
      trigger: row.trigger,
      gitCommitSha: row.git_commit_sha,
      checkpointId: row.checkpoint_id,
      createdAt: row.created_at.toISOString(),
      entries: entries.rows.map((entry) => ({
        path: entry.path,
        contentSha256: entry.content_sha256,
        diffSha256: entry.diff_sha256,
      })),
    };
  }

  function isIdenticalReplay(
    existing: NonNullable<Awaited<ReturnType<typeof readExistingFingerprint>>>,
    capture: NormalizedCapture,
  ): boolean {
    const metadataMatches =
      existing.teamId === capture.teamId &&
      existing.taskId === capture.taskId &&
      existing.trigger === capture.trigger &&
      existing.gitCommitSha === capture.gitCommitSha &&
      existing.checkpointId === capture.checkpointId &&
      existing.createdAt === capture.createdAt;

    if (!metadataMatches || existing.entries.length !== capture.entries.length) {
      return false;
    }

    return capture.entries.every((entry, index) => {
      const stored = existing.entries[index];
      return (
        stored.path === entry.path &&
        stored.contentSha256 === entry.contentSha256 &&
        stored.diffSha256 === entry.diffSha256
      );
    });
  }

  async function insertCapture(
    client: PoolClient,
    capture: NormalizedCapture,
  ): Promise<StoreCaptureResult> {
    const task = await client.query(
      'SELECT 1 FROM tasks WHERE id = $1 AND team_id = $2',
      [capture.taskId, capture.teamId],
    );
    if (task.rows.length === 0) {
      throw inaccessibleTaskError(capture.taskId);
    }

    await client.query(
      `INSERT INTO task_file_captures (
         id, team_id, task_id, "trigger", git_commit_sha, checkpoint_id, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        capture.captureId,
        capture.teamId,
        capture.taskId,
        capture.trigger,
        capture.gitCommitSha,
        capture.checkpointId,
        capture.createdAt,
      ],
    );

    for (const entry of capture.entries) {
      const snapshotBlobId = await upsertBlob(
        client,
        capture.teamId,
        'snapshot',
        entry.content,
        entry.contentSha256,
      );
      const diffBlobId = await upsertBlob(
        client,
        capture.teamId,
        'diff',
        entry.unifiedDiff,
        entry.diffSha256,
      );

      await client.query(
        `INSERT INTO task_file_capture_entries (
           capture_id, team_id, task_id, path, content_sha256, snapshot_blob_id, diff_blob_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          capture.captureId,
          capture.teamId,
          capture.taskId,
          entry.path,
          entry.contentSha256,
          snapshotBlobId,
          diffBlobId,
        ],
      );
    }

    return { captureId: capture.captureId, status: 'stored', entryCount: capture.entries.length };
  }

  async function storeNormalizedCapture(
    capture: NormalizedCapture,
    allowRetry: boolean,
  ): Promise<StoreCaptureResult> {
    try {
      return await withTransaction(async (client) => {
        const existing = await readExistingFingerprint(client, capture.captureId);
        if (existing) {
          if (!isIdenticalReplay(existing, capture)) {
            throw new TaskHistoryConflictError(capture.captureId);
          }
          return {
            captureId: capture.captureId,
            status: 'duplicate' as const,
            entryCount: existing.entries.length,
          };
        }
        return await insertCapture(client, capture);
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error, 'task_file_captures_pkey') && allowRetry) {
        // A concurrent writer committed the same capture id first; re-read it
        // and decide duplicate-vs-conflict from the committed row.
        return await storeNormalizedCapture(capture, false);
      }
      if (isUniqueViolation(error)) {
        throw new TaskHistoryConflictError(capture.captureId);
      }
      throw error;
    }
  }

  return {
    async storeCapture(input: StoreCaptureInput): Promise<StoreCaptureResult> {
      return await storeNormalizedCapture(normalizeCapture(input, limits), true);
    },

    async readCapture(teamId: string, taskId: string, captureId: string): Promise<CaptureRecord> {
      const scopedTeamId = requireUuid(teamId, 'teamId');
      const scopedTaskId = requireUuid(taskId, 'taskId');
      const scopedCaptureId = requireSafeId(captureId, 'Capture id', MAX_CAPTURE_ID_LENGTH);

      const capture = await pool.query<{
        trigger: FileCaptureTrigger;
        git_commit_sha: string | null;
        checkpoint_id: string | null;
        created_at: Date;
      }>(
        `SELECT "trigger", git_commit_sha, checkpoint_id, created_at
         FROM task_file_captures
         WHERE id = $1 AND team_id = $2 AND task_id = $3`,
        [scopedCaptureId, scopedTeamId, scopedTaskId],
      );
      if (capture.rows.length === 0) {
        throw new CaptureNotFoundError(scopedCaptureId);
      }

      const entries = await pool.query<{
        path: string;
        content_sha256: string;
        snapshot_blob_id: string;
        diff_blob_id: string;
      }>(
        `SELECT e.path, e.content_sha256, e.snapshot_blob_id, e.diff_blob_id
         FROM task_file_capture_entries e
         WHERE e.capture_id = $1 AND e.team_id = $2 AND e.task_id = $3
         ORDER BY e.path ASC`,
        [scopedCaptureId, scopedTeamId, scopedTaskId],
      );

      const blobs = await loadBlobs(
        scopedTeamId,
        entries.rows.flatMap((entry) => [entry.snapshot_blob_id, entry.diff_blob_id]),
      );

      const row = capture.rows[0];
      return {
        captureId: scopedCaptureId,
        teamId: scopedTeamId,
        taskId: scopedTaskId,
        trigger: row.trigger,
        gitCommitSha: row.git_commit_sha,
        checkpointId: row.checkpoint_id,
        createdAt: row.created_at.toISOString(),
        entries: entries.rows.map((entry) => ({
          path: entry.path,
          contentSha256: entry.content_sha256,
          content: decryptBlob(requireBlob(blobs, entry.snapshot_blob_id)),
          unifiedDiff: decryptBlob(requireBlob(blobs, entry.diff_blob_id)),
        })),
      };
    },

    async deleteCapture(input: DeleteCaptureInput): Promise<DeleteCaptureResult> {
      const teamId = requireUuid(input?.teamId, 'teamId');
      const taskId = requireUuid(input?.taskId, 'taskId');
      const captureId = requireSafeId(input?.captureId, 'Capture id', MAX_CAPTURE_ID_LENGTH);
      const actorUserId = requireUuid(input?.actorUserId, 'actorUserId');
      const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
      if (reason.length === 0 || reason.length > MAX_REASON_LENGTH) {
        throw new TaskHistoryValidationError(
          `Deletion reason must be 1-${MAX_REASON_LENGTH} characters`,
        );
      }

      return await withTransaction(async (client) => {
        const capture = await client.query(
          `SELECT 1 FROM task_file_captures
           WHERE id = $1 AND team_id = $2 AND task_id = $3
           FOR UPDATE`,
          [captureId, teamId, taskId],
        );
        if (capture.rows.length === 0) {
          throw new CaptureNotFoundError(captureId);
        }

        const membership = await client.query(
          `SELECT 1 FROM team_memberships
           WHERE team_id = $1 AND user_id = $2 AND active = true`,
          [teamId, actorUserId],
        );
        if (membership.rows.length === 0) {
          throw new ForbiddenActorError();
        }

        const entries = await client.query<{
          path: string;
          snapshot_blob_id: string;
          diff_blob_id: string;
        }>(
          `SELECT path, snapshot_blob_id, diff_blob_id
           FROM task_file_capture_entries
           WHERE capture_id = $1 AND team_id = $2 AND task_id = $3
           ORDER BY path ASC`,
          [captureId, teamId, taskId],
        );

        const deletedPaths = entries.rows.map((entry) => entry.path);
        const candidateBlobIds = Array.from(
          new Set(entries.rows.flatMap((entry) => [entry.snapshot_blob_id, entry.diff_blob_id])),
        );

        // References first, then the capture event, then unreferenced blobs.
        await client.query(
          'DELETE FROM task_file_capture_entries WHERE capture_id = $1 AND team_id = $2',
          [captureId, teamId],
        );
        await client.query(
          'DELETE FROM task_file_captures WHERE id = $1 AND team_id = $2 AND task_id = $3',
          [captureId, teamId, taskId],
        );

        const collected = await client.query<{ id: string }>(
          `DELETE FROM encrypted_blobs b
           WHERE b.id = ANY($1::uuid[])
             AND b.team_id = $2
             AND NOT EXISTS (
               SELECT 1 FROM task_file_capture_entries e
               WHERE e.snapshot_blob_id = b.id OR e.diff_blob_id = b.id
             )
           RETURNING b.id`,
          [candidateBlobIds, teamId],
        );

        const audit = await client.query<{ id: string }>(
          `INSERT INTO task_file_history_deletions (
             team_id, task_id, capture_id, actor_user_id, deleted_paths,
             deleted_entry_count, deleted_blob_count, reason
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [
            teamId,
            taskId,
            captureId,
            actorUserId,
            deletedPaths,
            deletedPaths.length,
            collected.rowCount ?? 0,
            reason,
          ],
        );

        return {
          deletionId: audit.rows[0].id,
          captureId,
          deletedPaths,
          deletedEntryCount: deletedPaths.length,
          deletedBlobCount: collected.rowCount ?? 0,
        };
      });
    },
  };
}

/** Fetches every referenced blob for a team in one query, keyed by blob id. */
function requireBlob(blobs: Map<string, BlobRow>, blobId: string): BlobRow {
  const blob = blobs.get(blobId);
  if (!blob) {
    throw new CaptureIntegrityError('Stored capture content is missing');
  }
  return blob;
}
