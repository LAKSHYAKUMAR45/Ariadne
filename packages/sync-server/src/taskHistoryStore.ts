import { gunzipSync, gzipSync } from 'node:zlib';
import type { Pool, PoolClient } from 'pg';
import {
  MAX_CAPTURE_ID_LENGTH,
  MAX_REASON_LENGTH,
  normalizeCapture,
  requireBuffer,
  requireSafeId,
  requireUuid,
  sha256Hex,
  type BlobRow,
  type NormalizedCapture,
} from './captureValidation.js';
import type { EncryptedBlob, EncryptionKeyring } from './encryption.js';
import { inaccessibleTaskError } from './taskAccess.js';
import {
  CaptureEventConflictError,
  CaptureIntegrityError,
  CaptureNotFoundError,
  CaptureStorageConflictError,
  ForbiddenActorError,
  TaskHistoryConflictError,
  TaskHistoryValidationError,
} from './taskHistoryErrors.js';
import {
  DEFAULT_SERVER_CAPTURE_LIMITS,
  type BlobType,
  type CaptureRecord,
  type DeleteCaptureInput,
  type DeleteCaptureResult,
  type FileCaptureTrigger,
  type ServerCaptureLimits,
  type StoreCaptureInput,
  type StoreCaptureResult,
  type TaskHistoryStore,
} from './taskHistoryTypes.js';

export * from './taskHistoryTypes.js';
export * from './taskHistoryErrors.js';

const BLOB_AAD_VERSION = 1;
const COMPRESSION = 'gzip';

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

function pgConstraint(error: unknown): { code?: string; constraint?: string } {
  if (!error || typeof error !== 'object') {
    return {};
  }
  return error as { code?: string; constraint?: string };
}

const BLOB_REFERENCE_CONSTRAINTS = new Set([
  'task_file_capture_entries_snapshot_fk',
  'task_file_capture_entries_diff_fk',
]);

/** Transient Postgres states that a single retry can legitimately resolve. */
function isTransientConflict(error: unknown): boolean {
  const { code, constraint } = pgConstraint(error);
  if (code === '40001' || code === '40P01') {
    return true;
  }
  return code === '23503' && constraint !== undefined && BLOB_REFERENCE_CONSTRAINTS.has(constraint);
}

function blobKey(blobType: BlobType, sha256: string): string {
  return `${blobType}:${sha256}`;
}

interface BlobRequest {
  blobType: BlobType;
  sha256: string;
  plaintext: Buffer;
}

export function createTaskHistoryStore(
  pool: Pool,
  keyring: EncryptionKeyring,
  limits: ServerCaptureLimits = DEFAULT_SERVER_CAPTURE_LIMITS,
): TaskHistoryStore {
  async function withTransaction<T>(
    run: (client: PoolClient) => Promise<T>,
    options: { isolation?: 'REPEATABLE READ'; readOnly?: boolean } = {},
  ): Promise<T> {
    const client = await pool.connect();
    const begin = [
      'BEGIN',
      options.isolation ? `ISOLATION LEVEL ${options.isolation}` : '',
      options.readOnly ? 'READ ONLY' : '',
    ]
      .filter((part) => part.length > 0)
      .join(' ');
    try {
      await client.query(begin);
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

  /**
   * Resolves every requested blob to a stored id in a bounded number of round
   * trips: one locking read of existing blobs, one multi-row insert of the
   * missing ones, and (only when another writer raced us) one more locking
   * read. Existing rows are locked `FOR SHARE` so concurrent garbage
   * collection cannot remove a blob this capture is about to reference.
   */
  async function resolveBlobIds(
    client: PoolClient,
    teamId: string,
    requests: BlobRequest[],
  ): Promise<Map<string, string>> {
    const unique = new Map<string, BlobRequest>();
    for (const request of requests) {
      const key = blobKey(request.blobType, request.sha256);
      if (!unique.has(key)) {
        unique.set(key, request);
      }
    }
    // Stable lock ordering keeps concurrent uploads from deadlocking.
    const pending = Array.from(unique.entries()).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );

    const resolved = new Map<string, string>();
    const selectExisting = async (batch: Array<[string, BlobRequest]>): Promise<void> => {
      if (batch.length === 0) {
        return;
      }
      const { rows } = await client.query<{ id: string; plaintext_sha256: string; blob_type: BlobType }>(
        `SELECT b.id, b.plaintext_sha256, b.blob_type
         FROM encrypted_blobs b
         JOIN unnest($2::text[], $3::text[]) AS k(sha, blob_type)
           ON b.plaintext_sha256 = k.sha AND b.blob_type = k.blob_type
         WHERE b.team_id = $1
         ORDER BY b.id
         FOR SHARE OF b`,
        [
          teamId,
          batch.map(([, request]) => request.sha256),
          batch.map(([, request]) => request.blobType),
        ],
      );
      for (const row of rows) {
        resolved.set(blobKey(row.blob_type, row.plaintext_sha256), row.id);
      }
    };

    await selectExisting(pending);

    const missing = pending.filter(([key]) => !resolved.has(key));
    if (missing.length > 0) {
      const keyId = keyring.activeKeyId;
      const encryptedRows = missing.map(([, request]) => {
        const compressed = gzipSync(request.plaintext);
        const encrypted: EncryptedBlob = keyring.encrypt(
          compressed,
          buildBlobAad({
            aadVersion: BLOB_AAD_VERSION,
            teamId,
            plaintextSha256: request.sha256,
            blobType: request.blobType,
            keyId,
            compression: COMPRESSION,
          }),
        );
        return {
          request,
          encrypted,
          plaintextBytes: request.plaintext.length,
          compressedBytes: compressed.length,
        };
      });

      const inserted = await client.query<{
        id: string;
        plaintext_sha256: string;
        blob_type: BlobType;
      }>(
        `INSERT INTO encrypted_blobs (
           team_id, plaintext_sha256, blob_type, key_id, aad_version, compression,
           nonce, ciphertext, auth_tag, plaintext_bytes, compressed_bytes, created_at
         )
         SELECT $1, k.sha, k.blob_type, k.key_id, $2, $3,
                k.nonce, k.ciphertext, k.auth_tag, k.plaintext_bytes, k.compressed_bytes, now()
         FROM unnest(
                $4::text[], $5::text[], $6::text[], $7::bytea[], $8::bytea[], $9::bytea[],
                $10::int[], $11::int[]
              ) AS k(sha, blob_type, key_id, nonce, ciphertext, auth_tag, plaintext_bytes, compressed_bytes)
         ON CONFLICT (team_id, plaintext_sha256, blob_type) DO NOTHING
         RETURNING id, plaintext_sha256, blob_type`,
        [
          teamId,
          BLOB_AAD_VERSION,
          COMPRESSION,
          encryptedRows.map((row) => row.request.sha256),
          encryptedRows.map((row) => row.request.blobType),
          encryptedRows.map((row) => row.encrypted.keyId),
          encryptedRows.map((row) => row.encrypted.nonce),
          encryptedRows.map((row) => row.encrypted.ciphertext),
          encryptedRows.map((row) => row.encrypted.authTag),
          encryptedRows.map((row) => row.plaintextBytes),
          encryptedRows.map((row) => row.compressedBytes),
        ],
      );
      for (const row of inserted.rows) {
        resolved.set(blobKey(row.blob_type, row.plaintext_sha256), row.id);
      }

      const raced = missing.filter(([key]) => !resolved.has(key));
      await selectExisting(raced);
      if (raced.some(([key]) => !resolved.has(key))) {
        throw new CaptureStorageConflictError();
      }
    }

    return resolved;
  }

  async function loadBlobs(
    client: PoolClient,
    teamId: string,
    blobIds: string[],
  ): Promise<Map<string, BlobRow>> {
    const unique = Array.from(new Set(blobIds));
    if (unique.length === 0) {
      return new Map();
    }

    const { rows } = await client.query<BlobRow>(
      `SELECT id, team_id, plaintext_sha256, blob_type, key_id, aad_version, compression,
              nonce, ciphertext, auth_tag, plaintext_bytes
       FROM encrypted_blobs
       WHERE id = ANY($1::uuid[]) AND team_id = $2`,
      [unique, teamId],
    );
    return new Map(rows.map((row) => [row.id, row]));
  }

  function decryptBlob(row: BlobRow): Buffer {
    const aad = buildBlobAad({
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
    teamId: string,
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
       FROM task_file_captures WHERE team_id = $1 AND id = $2 FOR UPDATE`,
      [teamId, captureId],
    );
    if (capture.rows.length === 0) {
      return null;
    }

    const entries = await client.query<{
      path: string;
      content_sha256: string;
      diff_sha256: string;
    }>(
      `SELECT path, snapshot_sha256 AS content_sha256, diff_sha256
       FROM task_file_capture_entries
       WHERE team_id = $1 AND capture_id = $2
       ORDER BY path ASC`,
      [teamId, captureId],
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

    const blobIds = await resolveBlobIds(
      client,
      capture.teamId,
      capture.entries.flatMap((entry) => [
        { blobType: 'snapshot' as const, sha256: entry.contentSha256, plaintext: entry.content },
        { blobType: 'diff' as const, sha256: entry.diffSha256, plaintext: entry.unifiedDiff },
      ]),
    );

    const snapshotBlobIds = capture.entries.map((entry) =>
      requireResolvedBlob(blobIds, 'snapshot', entry.contentSha256),
    );
    const diffBlobIds = capture.entries.map((entry) =>
      requireResolvedBlob(blobIds, 'diff', entry.diffSha256),
    );

    await client.query(
      `INSERT INTO task_file_capture_entries (
         capture_id, team_id, task_id, path, snapshot_sha256, diff_sha256,
         snapshot_blob_id, diff_blob_id
       )
       SELECT $1, $2, $3, e.path, e.snapshot_sha256, e.diff_sha256, e.snapshot_blob_id, e.diff_blob_id
       FROM unnest($4::text[], $5::text[], $6::text[], $7::uuid[], $8::uuid[])
         AS e(path, snapshot_sha256, diff_sha256, snapshot_blob_id, diff_blob_id)`,
      [
        capture.captureId,
        capture.teamId,
        capture.taskId,
        capture.entries.map((entry) => entry.path),
        capture.entries.map((entry) => entry.contentSha256),
        capture.entries.map((entry) => entry.diffSha256),
        snapshotBlobIds,
        diffBlobIds,
      ],
    );

    return { captureId: capture.captureId, status: 'stored', entryCount: capture.entries.length };
  }

  async function storeNormalizedCapture(
    capture: NormalizedCapture,
    allowRetry: boolean,
  ): Promise<StoreCaptureResult> {
    try {
      return await withTransaction(async (client) => {
        const existing = await readExistingFingerprint(client, capture.teamId, capture.captureId);
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
      if (allowRetry && (isUniqueViolation(error, 'task_file_captures_pkey') || isTransientConflict(error))) {
        // Either a concurrent writer committed the same capture id first (re-read
        // it and decide duplicate-vs-conflict from the committed row), or a
        // concurrent deletion moved a blob out from under this upload.
        return await storeNormalizedCapture(capture, false);
      }

      const { constraint } = pgConstraint(error);
      if (constraint === 'idx_task_file_captures_commit_idempotency') {
        throw new CaptureEventConflictError('git_commit');
      }
      if (constraint === 'idx_task_file_captures_checkpoint_idempotency') {
        throw new CaptureEventConflictError('checkpoint');
      }
      if (isUniqueViolation(error)) {
        throw new TaskHistoryConflictError(capture.captureId);
      }
      if (isTransientConflict(error)) {
        throw new CaptureStorageConflictError();
      }
      if (pgConstraint(error).constraint === 'task_file_captures_task_team_fk') {
        throw inaccessibleTaskError(capture.taskId);
      }
      throw error;
    }
  }

    /** Every entry blob must have been resolved before entries are inserted. */
  function requireResolvedBlob(
    blobIds: Map<string, string>,
    blobType: BlobType,
    sha256: string,
  ): string {
    const id = blobIds.get(blobKey(blobType, sha256));
    if (!id) {
      throw new CaptureStorageConflictError();
    }
    return id;
  }

  return {
    async storeCapture(input: StoreCaptureInput): Promise<StoreCaptureResult> {
      return await storeNormalizedCapture(normalizeCapture(input, limits), true);
    },

    async readCapture(teamId: string, taskId: string, captureId: string): Promise<CaptureRecord> {
      const scopedTeamId = requireUuid(teamId, 'teamId');
      const scopedTaskId = requireUuid(taskId, 'taskId');
      const scopedCaptureId = requireSafeId(captureId, 'Capture id', MAX_CAPTURE_ID_LENGTH);

      // One client, one repeatable-read snapshot: capture, entries, and blobs
      // are read as they existed at a single instant, so a concurrent deletion
      // yields either the whole capture or a deterministic 404 — never a
      // half-deleted read that looks like a storage integrity failure.
      return await withTransaction(
        async (client) => {
          const capture = await client.query<{
            trigger: FileCaptureTrigger;
            git_commit_sha: string | null;
            checkpoint_id: string | null;
            created_at: Date;
          }>(
            `SELECT "trigger", git_commit_sha, checkpoint_id, created_at
             FROM task_file_captures
             WHERE team_id = $1 AND id = $2 AND task_id = $3`,
            [scopedTeamId, scopedCaptureId, scopedTaskId],
          );
          if (capture.rows.length === 0) {
            throw new CaptureNotFoundError(scopedCaptureId);
          }

          const entries = await client.query<{
            path: string;
            snapshot_sha256: string;
            diff_sha256: string;
            snapshot_blob_id: string;
            diff_blob_id: string;
          }>(
            `SELECT path, snapshot_sha256, diff_sha256, snapshot_blob_id, diff_blob_id
             FROM task_file_capture_entries
             WHERE team_id = $1 AND capture_id = $2 AND task_id = $3
             ORDER BY path ASC`,
            [scopedTeamId, scopedCaptureId, scopedTaskId],
          );

          const blobs = await loadBlobs(
            client,
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
            entries: entries.rows.map((entry) => {
              // Both hashes are verified against the plaintext the reference
              // promised, so a returned hash always describes returned bytes.
              const content = verifiedPlaintext(
                decryptBlob(requireBlob(blobs, entry.snapshot_blob_id)),
                entry.snapshot_sha256,
              );
              const unifiedDiff = verifiedPlaintext(
                decryptBlob(requireBlob(blobs, entry.diff_blob_id)),
                entry.diff_sha256,
              );
              return {
                path: entry.path,
                content,
                unifiedDiff,
                contentSha256: entry.snapshot_sha256,
                diffSha256: entry.diff_sha256,
              };
            }),
          };
        },
        { isolation: 'REPEATABLE READ', readOnly: true },
      );
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

      return await deleteWithRetry(
        { teamId, taskId, captureId, actorUserId, reason },
        true,
      );
    },
  };

  async function deleteWithRetry(
    scoped: Required<DeleteCaptureInput>,
    allowRetry: boolean,
  ): Promise<DeleteCaptureResult> {
    const { teamId, taskId, captureId, actorUserId, reason } = scoped;
    try {
      return await withTransaction(async (client) => {
        // Authorization is decided before capture existence, so a caller who is
        // not an active member always sees the same 403 and can never use the
        // 403-vs-404 difference to probe for capture ids.
        const membership = await client.query(
          `SELECT 1 FROM team_memberships
           WHERE team_id = $1 AND user_id = $2 AND active = true`,
          [teamId, actorUserId],
        );
        if (membership.rows.length === 0) {
          throw new ForbiddenActorError();
        }

        const capture = await client.query(
          `SELECT 1 FROM task_file_captures
           WHERE team_id = $1 AND id = $2 AND task_id = $3
           FOR UPDATE`,
          [teamId, captureId, taskId],
        );
        if (capture.rows.length === 0) {
          throw new CaptureNotFoundError(captureId);
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
          'DELETE FROM task_file_capture_entries WHERE team_id = $1 AND capture_id = $2',
          [teamId, captureId],
        );
        await client.query(
          'DELETE FROM task_file_captures WHERE team_id = $1 AND id = $2 AND task_id = $3',
          [teamId, captureId, taskId],
        );

        // Lock the candidate blobs before testing for remaining references: an
        // upload that already shares one of them holds a FOR SHARE lock, so the
        // reference test below runs only once that upload has committed (and
        // the blob is then kept) or rolled back.
        const locked = await client.query<{ id: string }>(
          `SELECT id FROM encrypted_blobs
           WHERE id = ANY($1::uuid[]) AND team_id = $2
           ORDER BY id
           FOR UPDATE`,
          [candidateBlobIds, teamId],
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
          [locked.rows.map((row) => row.id), teamId],
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
    } catch (error: unknown) {
      if (allowRetry && isTransientConflict(error)) {
        return await deleteWithRetry(scoped, false);
      }
      if (isTransientConflict(error)) {
        throw new CaptureStorageConflictError();
      }
      throw error;
    }
  }
}

/**
 * Confirms decrypted plaintext matches the hash the capture entry references,
 * so a reference, its stored blob, and the bytes returned to callers agree.
 */
function verifiedPlaintext(plaintext: Buffer, expectedSha256: string): Buffer {
  if (sha256Hex(plaintext) !== expectedSha256) {
    throw new CaptureIntegrityError('Stored capture content failed integrity verification');
  }
  return plaintext;
}

/** Looks up a referenced blob loaded for the capture's team. */
function requireBlob(blobs: Map<string, BlobRow>, blobId: string): BlobRow {
  const blob = blobs.get(blobId);
  if (!blob) {
    throw new CaptureIntegrityError('Stored capture content is missing');
  }
  return blob;
}
