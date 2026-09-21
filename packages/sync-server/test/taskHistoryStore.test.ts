import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/db.js';
import { createEncryptionKeyring, type EncryptionKeyring } from '../src/encryption.js';
import { runMigrations } from '../src/migrate.js';
import {
  createTaskHistoryStore,
  DEFAULT_SERVER_CAPTURE_LIMITS,
  type StoreCaptureInput,
  type TaskHistoryStore,
} from '../src/taskHistoryStore.js';
import { TEST_DATABASE_URL } from './testConfig.js';
import {
  relaxSingletonTeamConstraints,
  restoreSingletonTeamConstraints,
} from './singletonConstraints.js';

const PLAINTEXT_MARKER = 'ARIADNE_PLAINTEXT_CANARY_7Q4Z';

const KEY_ONE = 'test-key-1';
const KEY_TWO = 'test-key-2';

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function keyringWith(activeKeyId: string, keyIds: string[]): EncryptionKeyring {
  const keys = new Map<string, Buffer>();
  for (const [index, keyId] of keyIds.entries()) {
    keys.set(keyId, Buffer.alloc(32, 0x11 + index));
  }
  return createEncryptionKeyring(activeKeyId, keys);
}

describe('taskHistoryStore', () => {
  let pool: Pool;
  let store: TaskHistoryStore;
  let keyring: EncryptionKeyring;

  let teamAId: string;
  let teamBId: string;
  let adminAId: string;
  let adminBId: string;
  let taskAId: string;
  let taskA2Id: string;
  let taskBId: string;

  beforeAll(async () => {
    pool = createPool(TEST_DATABASE_URL);
    await runMigrations(pool);
    await relaxSingletonTeamConstraints(pool);
  });

  afterAll(async () => {
    await restoreSingletonTeamConstraints(pool);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE TABLE todos, decisions, errors, open_questions, commands, checkpoints, tasks, team_memberships, teams, users CASCADE',
    );

    keyring = keyringWith(KEY_ONE, [KEY_ONE]);
    store = createTaskHistoryStore(pool, keyring);

    teamAId = await createTeam('Team Alpha');
    teamBId = await createTeam('Team Beta');
    adminAId = await createMember('alpha-admin', teamAId);
    adminBId = await createMember('beta-admin', teamBId);
    taskAId = await createTask(teamAId, adminAId, 'alpha-1');
    taskA2Id = await createTask(teamAId, adminAId, 'alpha-2');
    taskBId = await createTask(teamBId, adminBId, 'beta-1');
  });

  async function createTeam(name: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO teams (singleton_key, name) VALUES ($1, $2) RETURNING id',
      [null, name],
    );
    return rows[0].id;
  }

  async function createMember(username: string, teamId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
      [username, `hash-${username}`],
    );
    const userId = rows[0].id;
    await pool.query(
      `INSERT INTO team_memberships (team_id, user_id, role, active) VALUES ($1, $2, 'admin', true)`,
      [teamId, userId],
    );
    return userId;
  }

  async function createTask(teamId: string, ownerUserId: string, localId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO tasks (local_id, owner_user_id, title, status, created_at, updated_at, team_id)
       VALUES ($1, $2, $3, 'active', $4, $4, $5)
       RETURNING id`,
      [localId, ownerUserId, `Task ${localId}`, '2026-09-21T00:00:00Z', teamId],
    );
    return rows[0].id;
  }

  function captureInput(overrides: Partial<StoreCaptureInput> = {}): StoreCaptureInput {
    const content = Buffer.from(`const secret = '${PLAINTEXT_MARKER}';\n`, 'utf8');
    const diff = Buffer.from(`+const secret = '${PLAINTEXT_MARKER}';\n`, 'utf8');
    return {
      captureId: 'capture-0001',
      teamId: teamAId,
      taskId: taskAId,
      trigger: 'git_commit',
      gitCommitSha: 'a'.repeat(40),
      checkpointId: null,
      createdAt: '2026-09-21T01:00:00.000Z',
      entries: [
        {
          path: 'src/app.ts',
          content,
          unifiedDiff: diff,
          contentSha256: sha256(content),
        },
      ],
      ...overrides,
    };
  }

  function entry(path: string, content: string, diff: string) {
    const contentBuffer = Buffer.from(content, 'utf8');
    return {
      path,
      content: contentBuffer,
      unifiedDiff: Buffer.from(diff, 'utf8'),
      contentSha256: sha256(contentBuffer),
    };
  }

  async function countRows(table: string): Promise<number> {
    const { rows } = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table}`);
    return rows[0].count;
  }

  /** Scans every text/bytea column in the public schema for a plaintext marker. */
  async function findPlaintextLeaks(marker: string): Promise<string[]> {
    const { rows } = await pool.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT c.table_name, c.column_name, c.data_type
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
       WHERE c.table_schema = 'public'
         AND t.table_type = 'BASE TABLE'
         AND c.data_type IN ('text', 'character varying', 'bytea', 'ARRAY')`,
    );

    const leaks: string[] = [];
    for (const column of rows) {
      const expression =
        column.data_type === 'bytea'
          ? `encode("${column.column_name}", 'escape')`
          : `"${column.column_name}"::text`;
      const { rows: hits } = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM "${column.table_name}" WHERE ${expression} LIKE $1`,
        [`%${marker}%`],
      );
      if (hits[0].count > 0) {
        leaks.push(`${column.table_name}.${column.column_name}`);
      }
    }
    return leaks;
  }

  it('stores capture content and diffs only as authenticated ciphertext', async () => {
    const input = captureInput();
    const result = await store.storeCapture(input);

    expect(result).toEqual({ captureId: 'capture-0001', status: 'stored', entryCount: 1 });
    expect(await findPlaintextLeaks(PLAINTEXT_MARKER)).toEqual([]);

    const blobs = await pool.query(
      'SELECT compression, plaintext_bytes, compressed_bytes, key_id, nonce, auth_tag, ciphertext, blob_type FROM encrypted_blobs ORDER BY blob_type ASC',
    );
    expect(blobs.rows).toHaveLength(2);
    for (const blob of blobs.rows) {
      expect(blob.compression).toBe('gzip');
      expect(blob.key_id).toBe(KEY_ONE);
      expect(blob.nonce).toHaveLength(12);
      expect(blob.auth_tag).toHaveLength(16);
      expect(blob.compressed_bytes).toBe(blob.ciphertext.length);
      expect(blob.plaintext_bytes).toBeGreaterThan(0);
      expect(() => gunzipSync(blob.ciphertext)).toThrow();
    }
    expect(blobs.rows.map((row) => row.blob_type)).toEqual(['diff', 'snapshot']);
  });

  it('round-trips content and diffs for the owning team and task', async () => {
    const input = captureInput();
    await store.storeCapture(input);

    const capture = await store.readCapture(teamAId, taskAId, 'capture-0001');
    expect(capture.captureId).toBe('capture-0001');
    expect(capture.teamId).toBe(teamAId);
    expect(capture.taskId).toBe(taskAId);
    expect(capture.trigger).toBe('git_commit');
    expect(capture.gitCommitSha).toBe('a'.repeat(40));
    expect(capture.checkpointId).toBeNull();
    expect(capture.createdAt).toBe('2026-09-21T01:00:00.000Z');
    expect(capture.entries).toHaveLength(1);

    const [only] = capture.entries;
    expect(only.path).toBe('src/app.ts');
    expect(only.content.equals(input.entries[0].content)).toBe(true);
    expect(only.unifiedDiff.equals(input.entries[0].unifiedDiff)).toBe(true);
    expect(only.contentSha256).toBe(input.entries[0].contentSha256);
  });

  it('deduplicates identical plaintext within a team and never across teams', async () => {
    const sharedContent = `${PLAINTEXT_MARKER} shared body\n`;
    const sharedDiff = `+${PLAINTEXT_MARKER} shared body\n`;

    await store.storeCapture(
      captureInput({
        captureId: 'team-a-1',
        entries: [
          entry('src/one.ts', sharedContent, sharedDiff),
          entry('src/two.ts', sharedContent, sharedDiff),
        ],
      }),
    );

    expect(await countRows('encrypted_blobs')).toBe(2);
    expect(await countRows('task_file_capture_entries')).toBe(2);

    await store.storeCapture(
      captureInput({
        captureId: 'team-a-2',
        taskId: taskA2Id,
        gitCommitSha: 'b'.repeat(40),
        entries: [entry('src/three.ts', sharedContent, sharedDiff)],
      }),
    );
    expect(await countRows('encrypted_blobs')).toBe(2);

    await store.storeCapture(
      captureInput({
        captureId: 'team-b-1',
        teamId: teamBId,
        taskId: taskBId,
        entries: [entry('src/one.ts', sharedContent, sharedDiff)],
      }),
    );

    expect(await countRows('encrypted_blobs')).toBe(4);
    const perTeam = await pool.query<{ team_id: string; count: number }>(
      'SELECT team_id, count(*)::int AS count FROM encrypted_blobs GROUP BY team_id ORDER BY count DESC',
    );
    expect(perTeam.rows.map((row) => row.count)).toEqual([2, 2]);
  });

  it('keeps identical snapshot and diff plaintext in distinct authenticated blob types', async () => {
    const identical = `${PLAINTEXT_MARKER} identical bytes\n`;
    await store.storeCapture(
      captureInput({ entries: [entry('src/app.ts', identical, identical)] }),
    );

    const blobs = await pool.query<{ blob_type: string; plaintext_sha256: string; id: string }>(
      'SELECT id, blob_type, plaintext_sha256 FROM encrypted_blobs ORDER BY blob_type ASC',
    );
    expect(blobs.rows).toHaveLength(2);
    expect(blobs.rows[0].plaintext_sha256).toBe(blobs.rows[1].plaintext_sha256);
    expect(blobs.rows.map((row) => row.blob_type)).toEqual(['diff', 'snapshot']);

    // Blob-type substitution is rejected by the schema, not silently served.
    const diff = blobs.rows.find((row) => row.blob_type === 'diff')!;
    const snapshot = blobs.rows.find((row) => row.blob_type === 'snapshot')!;
    await expect(
      pool.query('UPDATE task_file_capture_entries SET snapshot_blob_id = $1', [diff.id]),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      pool.query('UPDATE task_file_capture_entries SET diff_blob_id = $1', [snapshot.id]),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('treats an identical capture replay as idempotent', async () => {
    const input = captureInput({
      entries: [entry('src/one.ts', 'alpha\n', '+alpha\n'), entry('src/two.ts', 'beta\n', '+beta\n')],
    });

    const first = await store.storeCapture(input);
    const second = await store.storeCapture(input);

    expect(first.status).toBe('stored');
    expect(second).toEqual({ captureId: input.captureId, status: 'duplicate', entryCount: 2 });
    expect(await countRows('task_file_captures')).toBe(1);
    expect(await countRows('task_file_capture_entries')).toBe(2);
    expect(await countRows('encrypted_blobs')).toBe(4);
  });

  it('rejects a capture id replay that changes metadata or entries', async () => {
    const input = captureInput();
    await store.storeCapture(input);

    await expect(
      store.storeCapture(captureInput({ gitCommitSha: 'c'.repeat(40) })),
    ).rejects.toMatchObject({ status: 409, code: 'capture_conflict' });

    await expect(
      store.storeCapture(captureInput({ taskId: taskA2Id })),
    ).rejects.toMatchObject({ status: 409, code: 'capture_conflict' });

    await expect(
      store.storeCapture(captureInput({ entries: [entry('src/app.ts', 'changed\n', '+changed\n')] })),
    ).rejects.toMatchObject({ status: 409, code: 'capture_conflict' });

    await expect(
      store.storeCapture(
        captureInput({ teamId: teamBId, taskId: taskBId }),
      ),
    ).rejects.toMatchObject({ status: 409, code: 'capture_conflict' });

    expect(await countRows('task_file_captures')).toBe(1);
    expect(await countRows('task_file_capture_entries')).toBe(1);
  });

  it('refuses to store a capture for a task in another team', async () => {
    await expect(
      store.storeCapture(captureInput({ teamId: teamBId })),
    ).rejects.toMatchObject({ status: 404, code: 'task_not_found' });
    expect(await countRows('task_file_captures')).toBe(0);
  });

  it('hides captures from the wrong team or task', async () => {
    await store.storeCapture(captureInput());

    await expect(store.readCapture(teamBId, taskAId, 'capture-0001')).rejects.toMatchObject({
      status: 404,
      code: 'capture_not_found',
    });
    await expect(store.readCapture(teamAId, taskA2Id, 'capture-0001')).rejects.toMatchObject({
      status: 404,
      code: 'capture_not_found',
    });
    await expect(store.readCapture(teamAId, taskAId, 'missing-capture')).rejects.toMatchObject({
      status: 404,
      code: 'capture_not_found',
    });
  });

  it('reads captures written with a retired key after rotation', async () => {
    await store.storeCapture(captureInput());

    const rotated = createTaskHistoryStore(pool, keyringWith(KEY_TWO, [KEY_ONE, KEY_TWO]));
    const old = await rotated.readCapture(teamAId, taskAId, 'capture-0001');
    expect(old.entries[0].content.toString('utf8')).toContain(PLAINTEXT_MARKER);

    await rotated.storeCapture(
      captureInput({
        captureId: 'capture-0002',
        gitCommitSha: 'd'.repeat(40),
        entries: [entry('src/new.ts', 'rotated\n', '+rotated\n')],
      }),
    );

    const keyIds = await pool.query<{ key_id: string; count: number }>(
      'SELECT key_id, count(*)::int AS count FROM encrypted_blobs GROUP BY key_id ORDER BY key_id ASC',
    );
    expect(keyIds.rows).toEqual([
      { key_id: KEY_ONE, count: 2 },
      { key_id: KEY_TWO, count: 2 },
    ]);

    const fresh = await rotated.readCapture(teamAId, taskAId, 'capture-0002');
    expect(fresh.entries[0].content.toString('utf8')).toBe('rotated\n');
  });

  it('fails closed when a stored blob or its authenticated metadata is tampered with', async () => {
    await store.storeCapture(captureInput());
    await store.storeCapture(
      captureInput({
        captureId: 'capture-0002',
        taskId: taskA2Id,
        gitCommitSha: 'f'.repeat(40),
        entries: [entry('src/other.ts', 'other body\n', '+other body\n')],
      }),
    );

    await pool.query(
      `UPDATE encrypted_blobs SET ciphertext = ciphertext || '\\x00'::bytea
       WHERE id = (SELECT snapshot_blob_id FROM task_file_capture_entries WHERE capture_id = 'capture-0001')`,
    );
    await expect(store.readCapture(teamAId, taskAId, 'capture-0001')).rejects.toMatchObject({
      status: 500,
      code: 'capture_integrity_error',
    });

    // Rewriting authenticated metadata (the key id) must also fail closed.
    await pool.query(
      `UPDATE encrypted_blobs SET plaintext_sha256 = repeat('0', 64)
       WHERE id = (SELECT diff_blob_id FROM task_file_capture_entries WHERE capture_id = 'capture-0002')`,
    );
    await expect(store.readCapture(teamAId, taskA2Id, 'capture-0002')).rejects.toMatchObject({
      status: 500,
      code: 'capture_integrity_error',
    });
  });

  it('enforces server-side size limits before encrypting anything', async () => {
    const oversizedFile = 'x'.repeat(DEFAULT_SERVER_CAPTURE_LIMITS.maxFileBytes + 1);
    await expect(
      store.storeCapture(captureInput({ entries: [entry('src/big.ts', oversizedFile, '+big\n')] })),
    ).rejects.toMatchObject({ status: 413, code: 'capture_too_large' });

    const chunk = 'y'.repeat(DEFAULT_SERVER_CAPTURE_LIMITS.maxFileBytes);
    const entries = Array.from({ length: 11 }, (_, index) =>
      entry(`src/file-${index}.ts`, chunk, '+y\n'),
    );
    await expect(store.storeCapture(captureInput({ entries }))).rejects.toMatchObject({
      status: 413,
      code: 'capture_too_large',
    });

    expect(await countRows('encrypted_blobs')).toBe(0);
    expect(await countRows('task_file_captures')).toBe(0);
  });

  it('rejects malformed capture input', async () => {
    const badContent = Buffer.from('content\n', 'utf8');

    await expect(
      store.storeCapture(
        captureInput({
          entries: [
            { path: 'src/app.ts', content: badContent, unifiedDiff: badContent, contentSha256: 'f'.repeat(64) },
          ],
        }),
      ),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_capture' });

    await expect(
      store.storeCapture(captureInput({ entries: [entry('/etc/passwd', 'a\n', '+a\n')] })),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_capture' });

    await expect(
      store.storeCapture(captureInput({ entries: [entry('../outside.ts', 'a\n', '+a\n')] })),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_capture' });

    await expect(
      store.storeCapture(
        captureInput({ entries: [entry('src/dup.ts', 'a\n', '+a\n'), entry('src/dup.ts', 'b\n', '+b\n')] }),
      ),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_capture' });

    await expect(store.storeCapture(captureInput({ entries: [] }))).rejects.toMatchObject({
      status: 400,
      code: 'invalid_capture',
    });

    await expect(
      store.storeCapture(captureInput({ trigger: 'nope' as StoreCaptureInput['trigger'] })),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_capture' });

    await expect(store.storeCapture(captureInput({ createdAt: 'not-a-date' }))).rejects.toMatchObject({
      status: 400,
      code: 'invalid_capture',
    });

    expect(await countRows('task_file_captures')).toBe(0);
  });

  it('deletes a capture, keeps shared blobs, and garbage-collects unreferenced blobs', async () => {
    const shared = 'shared body\n';
    await store.storeCapture(
      captureInput({
        captureId: 'capture-keep',
        entries: [entry('src/shared.ts', shared, '+shared\n')],
      }),
    );
    await store.storeCapture(
      captureInput({
        captureId: 'capture-drop',
        taskId: taskA2Id,
        gitCommitSha: 'e'.repeat(40),
        entries: [
          entry('src/shared.ts', shared, '+shared\n'),
          entry('src/unique.ts', 'unique body\n', '+unique\n'),
        ],
      }),
    );

    expect(await countRows('encrypted_blobs')).toBe(4);

    const deletion = await store.deleteCapture({
      teamId: teamAId,
      taskId: taskA2Id,
      captureId: 'capture-drop',
      actorUserId: adminAId,
      reason: 'admin requested history purge',
    });

    expect(deletion.captureId).toBe('capture-drop');
    expect(deletion.deletedEntryCount).toBe(2);
    expect(deletion.deletedPaths).toEqual(['src/shared.ts', 'src/unique.ts']);
    expect(deletion.deletedBlobCount).toBe(2);

    expect(await countRows('task_file_captures')).toBe(1);
    expect(await countRows('task_file_capture_entries')).toBe(1);
    expect(await countRows('encrypted_blobs')).toBe(2);

    const kept = await store.readCapture(teamAId, taskAId, 'capture-keep');
    expect(kept.entries[0].content.toString('utf8')).toBe(shared);

    await expect(store.readCapture(teamAId, taskA2Id, 'capture-drop')).rejects.toMatchObject({
      status: 404,
      code: 'capture_not_found',
    });
  });

  it('records an immutable deletion audit row', async () => {
    await store.storeCapture(captureInput());
    await store.deleteCapture({
      teamId: teamAId,
      taskId: taskAId,
      captureId: 'capture-0001',
      actorUserId: adminAId,
      reason: 'cleanup',
    });

    const audit = await pool.query(
      `SELECT team_id, task_id, capture_id, actor_user_id, deleted_paths, deleted_entry_count, deleted_blob_count, reason
       FROM task_file_history_deletions`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      team_id: teamAId,
      task_id: taskAId,
      capture_id: 'capture-0001',
      actor_user_id: adminAId,
      deleted_paths: ['src/app.ts'],
      deleted_entry_count: 1,
      deleted_blob_count: 2,
      reason: 'cleanup',
    });

    await expect(
      pool.query(`UPDATE task_file_history_deletions SET reason = 'rewritten'`),
    ).rejects.toMatchObject({ code: 'P0001' });
    await expect(pool.query('DELETE FROM task_file_history_deletions')).rejects.toMatchObject({
      code: 'P0001',
    });
  });

  it('refuses deletion for the wrong team, task, reason, or a non-member actor', async () => {
    await store.storeCapture(captureInput());

    const base = {
      teamId: teamAId,
      taskId: taskAId,
      captureId: 'capture-0001',
      actorUserId: adminAId,
      reason: 'cleanup',
    };

    await expect(store.deleteCapture({ ...base, teamId: teamBId })).rejects.toMatchObject({
      status: 404,
    });
    await expect(store.deleteCapture({ ...base, taskId: taskA2Id })).rejects.toMatchObject({
      status: 404,
      code: 'capture_not_found',
    });
    await expect(store.deleteCapture({ ...base, actorUserId: adminBId })).rejects.toMatchObject({
      status: 403,
      code: 'forbidden_actor',
    });
    await expect(store.deleteCapture({ ...base, reason: '   ' })).rejects.toMatchObject({
      status: 400,
      code: 'invalid_capture',
    });

    expect(await countRows('task_file_captures')).toBe(1);
    expect(await countRows('task_file_history_deletions')).toBe(0);
  });
});
