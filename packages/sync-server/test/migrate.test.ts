import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { TEST_DATABASE_URL } from './testConfig.js';

describe('runMigrations', () => {
  let pool: Pool;

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it('applies migrations once and is a no-op on a second run', async () => {
    pool = createPool(TEST_DATABASE_URL);
    // Reset to a clean schema first: this assertion cares about "did this
    // call apply 0001_init.sql", which is only meaningful starting from an
    // empty database — other test files (routes.test.ts) may have already
    // triggered migrations against the same shared test database.
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

    const first = await runMigrations(pool);
    expect(first).toContain('0001_init.sql');

    const second = await runMigrations(pool);
    expect(second).toEqual([]);
  });

  it('creates the expected tables', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    );
    const tableNames = rows.map((r) => r.table_name);
    expect(tableNames).toEqual(
      expect.arrayContaining([
        'users',
        'tasks',
        'checkpoints',
        'schema_meta',
        'migrations_applied',
        'encrypted_blobs',
        'task_file_captures',
        'task_file_capture_entries',
        'task_file_history_deletions',
        'admin_operations',
        'admin_operation_events',
        'admin_audit_events',
        'backup_records',
      ]),
    );
  });

  it('constrains encrypted history storage to authenticated, team-scoped blobs', async () => {
    if (!pool) {
      pool = createPool(TEST_DATABASE_URL);
      await runMigrations(pool);
    }

    const version = await pool.query<{ value: string }>(
      `SELECT value FROM schema_meta WHERE key = 'schema_version'`,
    );
    expect(version.rows[0].value).toBe('12');

    const dedupIndex = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'encrypted_blobs' AND indexname = 'encrypted_blobs_team_content_key'`,
    );
    expect(dedupIndex.rows).toHaveLength(1);
    expect(dedupIndex.rows[0].indexdef).toContain('team_id');
    expect(dedupIndex.rows[0].indexdef).toContain('blob_type');
    expect(dedupIndex.rows[0].indexdef).toContain('plaintext_sha256');

    const capturePrimaryKey = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid = 'task_file_captures'::regclass AND contype = 'p'`,
    );
    expect(capturePrimaryKey.rows[0].definition).toBe('PRIMARY KEY (team_id, id)');

    const entryConstraints = await pool.query<{ conname: string; definition: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conrelid = 'task_file_capture_entries'::regclass AND contype IN ('p', 'f')`,
    );
    const entryDefinitions = Object.fromEntries(
      entryConstraints.rows.map((row) => [row.conname, row.definition]),
    );
    expect(entryDefinitions.task_file_capture_entries_pkey).toBe(
      'PRIMARY KEY (team_id, capture_id, path)',
    );
    expect(entryDefinitions.task_file_capture_entries_snapshot_fk).toContain(
      '(snapshot_blob_id, team_id, snapshot_blob_type, snapshot_sha256)',
    );
    expect(entryDefinitions.task_file_capture_entries_snapshot_fk).toContain(
      'encrypted_blobs(id, team_id, blob_type, plaintext_sha256)',
    );
    expect(entryDefinitions.task_file_capture_entries_diff_fk).toContain(
      '(diff_blob_id, team_id, diff_blob_type, diff_sha256)',
    );

    const checks = await pool.query<{ conname: string; definition: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'encrypted_blobs'::regclass AND contype = 'c'`,
    );
    const definitions = checks.rows.map((row) => row.definition).join(' | ');
    expect(definitions).toContain("'snapshot'");
    expect(definitions).toContain("'diff'");
    expect(definitions).toContain("'gzip'");

    const noPlaintextColumns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'encrypted_blobs' AND column_name IN ('plaintext', 'content', 'unified_diff')`,
    );
    expect(noPlaintextColumns.rows).toEqual([]);
  });

  it('backfills a singleton team and scopes existing tasks to it', async () => {
    if (!pool) {
      pool = createPool(TEST_DATABASE_URL);
    }
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

    const v5MigrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-sync-v5-'));
    try {
      for (const file of [
        '0001_init.sql',
        '0002_workspace_label.sql',
        '0003_checkpoint_attribution.sql',
        '0004_subentity_sync.sql',
        '0005_subentity_updated_at.sql',
      ]) {
        fs.copyFileSync(
          path.join(process.cwd(), 'migrations', file),
          path.join(v5MigrationsDir, file),
        );
      }

      const initialMigrations = await runMigrations(pool, v5MigrationsDir);
      expect(initialMigrations).toEqual(
        expect.arrayContaining([
          '0001_init.sql',
          '0002_workspace_label.sql',
          '0003_checkpoint_attribution.sql',
          '0004_subentity_sync.sql',
          '0005_subentity_updated_at.sql',
        ]),
      );

      const users = await pool.query<{ id: string }>(
        `INSERT INTO users (username, password_hash, created_at)
         VALUES
           ('alice', 'hash-alice', '2026-01-01T00:00:00Z'),
           ('bob', 'hash-bob', '2026-01-02T00:00:00Z')
         RETURNING id`,
      );
      const [alice, bob] = users.rows;

      await pool.query(
        `INSERT INTO tasks (
           local_id,
           owner_user_id,
           title,
           goal,
           status,
           branch,
           workspace_label,
           created_at,
           updated_at
         )
         VALUES
           ($1, $2, $3, $4, $5, $6, $7, $8, $9),
           ($10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [
          'task-alice',
          alice.id,
          'Task One',
          'goal one',
          'active',
          'main',
          'laptop1:repo',
          '2026-01-01T01:00:00Z',
          '2026-01-01T01:00:00Z',
          'task-bob',
          bob.id,
          'Task Two',
          'goal two',
          'active',
          'main',
          'laptop1:repo',
          '2026-01-02T01:00:00Z',
          '2026-01-02T01:00:00Z',
        ],
      );

      const upgraded = await runMigrations(pool);
      expect(upgraded).toEqual([
        '0006_single_team_authorization.sql',
        '0007_encrypted_task_history.sql',
        '0008_admin_operations.sql',
        '0009_admin_sessions.sql',
        '0010_complete_admin_operations.sql',
        '0011_sso_codes.sql',
        '0012_multi_admin.sql',
      ]);

      const secondRun = await runMigrations(pool);
      expect(secondRun).toEqual([]);

      const teams = await pool.query('SELECT id, singleton_key FROM teams');
      expect(teams.rows).toHaveLength(1);
      expect(teams.rows[0].singleton_key).toBe('default');
      const teamId = teams.rows[0].id;

      const schemaVersion = await pool.query<{ value: string }>(
        `SELECT value FROM schema_meta WHERE key = 'schema_version'`,
      );
      expect(schemaVersion.rows).toHaveLength(1);
      expect(schemaVersion.rows[0].value).toBe('12');

      const memberships = await pool.query(
        `SELECT u.username, m.role, m.active
         FROM team_memberships m
         JOIN users u ON u.id = m.user_id
         ORDER BY u.username ASC`,
      );
      expect(memberships.rows).toEqual([
        { username: 'alice', role: 'admin', active: true },
        { username: 'bob', role: 'member', active: true },
      ]);

      const duplicateAdmin = await pool.query<{ id: string }>(
        `INSERT INTO users (username, password_hash, created_at)
         VALUES ('carol', 'hash-carol', '2026-01-03T00:00:00Z')
         RETURNING id`,
      );
      await expect(
        pool.query(
          `INSERT INTO team_memberships (team_id, user_id, role, active)
           VALUES ($1, $2, 'admin', true)`,
          [teamId, duplicateAdmin.rows[0].id],
        ),
      ).resolves.toBeTruthy();

      const taskTeams = await pool.query<{ id: string; team_id: string | null }>(
        'SELECT id, team_id FROM tasks ORDER BY local_id ASC',
      );
      expect(taskTeams.rows).toHaveLength(2);
      expect(taskTeams.rows.every((row) => row.team_id === teamId)).toBe(true);

      const unscoped = await pool.query('SELECT count(*)::int AS count FROM tasks WHERE team_id IS NULL');
      expect(unscoped.rows[0].count).toBe(0);

      // Reapplying the 0006 body (e.g. a manual re-run against an existing
      // deployment) must never resurrect or re-role an existing membership.
      await pool.query(
        `UPDATE team_memberships SET active = false WHERE user_id = $1`,
        [alice.id],
      );
      await pool.query(
        `UPDATE team_memberships SET role = 'member' WHERE user_id = $1`,
        [alice.id],
      );

      const migrationSql = fs.readFileSync(
        path.join(process.cwd(), 'migrations', '0006_single_team_authorization.sql'),
        'utf8',
      );
      await pool.query(migrationSql);

      const afterReapply = await pool.query(
        `SELECT u.username, m.role, m.active
         FROM team_memberships m
         JOIN users u ON u.id = m.user_id
         WHERE u.username = 'alice'`,
      );
      expect(afterReapply.rows).toEqual([
        { username: 'alice', role: 'member', active: false },
      ]);
    } finally {
      fs.rmSync(v5MigrationsDir, { recursive: true, force: true });
    }
  });

  it('creates admin operation and backup metadata tables without storing backup bytes', async () => {
    if (!pool) {
      pool = createPool(TEST_DATABASE_URL);
    }
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(pool);

    const version = await pool.query<{ value: string }>(
      `SELECT value FROM schema_meta WHERE key = 'schema_version'`,
    );
    expect(version.rows[0].value).toBe('12');

    const operationChecks = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'admin_operations'::regclass AND contype = 'c'
       ORDER BY conname ASC`,
    );
    const operationDefinitions = operationChecks.rows.map((row) => row.definition).join(' | ');
    expect(operationDefinitions).toContain("'service_restart'");
    expect(operationDefinitions).toContain("'deployment_apply'");
    expect(operationDefinitions).toContain("'backup_create'");
    expect(operationDefinitions).toContain("'backup_verify'");
    expect(operationDefinitions).toContain("'backup_restore'");
    expect(operationDefinitions).toContain("'queued'");
    expect(operationDefinitions).toContain("'running'");
    expect(operationDefinitions).toContain("'succeeded'");
    expect(operationDefinitions).toContain("'failed'");

    const auditTrigger = await pool.query<{ tgname: string }>(
      `SELECT tgname
       FROM pg_trigger
       WHERE tgrelid = 'admin_audit_events'::regclass AND NOT tgisinternal`,
    );
    expect(auditTrigger.rows.map((row) => row.tgname)).toEqual(
      expect.arrayContaining([
        'trg_admin_audit_events_append_only',
        'trg_admin_audit_events_append_only_truncate',
      ]),
    );

    await expect(pool.query('TRUNCATE TABLE admin_audit_events')).rejects.toThrow(/append-only/i);

    const backupColumns = await pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_name = 'backup_records'
       ORDER BY ordinal_position ASC`,
    );
    expect(backupColumns.rows).toEqual(
      expect.arrayContaining([
        { column_name: 'filename', data_type: 'text' },
        { column_name: 'sha256', data_type: 'text' },
        { column_name: 'size_bytes', data_type: 'bigint' },
        { column_name: 'created_at', data_type: 'timestamp with time zone' },
        { column_name: 'verified_at', data_type: 'timestamp with time zone' },
        { column_name: 'status', data_type: 'text' },
        { column_name: 'restore_verification_message', data_type: 'text' },
      ]),
    );
    expect(
      backupColumns.rows.filter((column) => column.data_type === 'bytea'),
    ).toEqual([]);

    const descendingIndexes = await pool.query<{ tablename: string; indexdef: string }>(
      `SELECT tablename, indexdef
       FROM pg_indexes
       WHERE tablename IN (
         'admin_operations',
         'admin_operation_events',
         'admin_audit_events',
         'backup_records'
       )`,
    );
    expect(descendingIndexes.rows.map((row) => row.indexdef).join(' | ')).toContain('DESC');
  });

  it('upgrades admin operation types in place for rollback and local deletion', async () => {
    if (!pool) {
      pool = createPool(TEST_DATABASE_URL);
    }
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

    const v9MigrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-sync-v9-'));
    try {
      for (const file of [
        '0001_init.sql',
        '0002_workspace_label.sql',
        '0003_checkpoint_attribution.sql',
        '0004_subentity_sync.sql',
        '0005_subentity_updated_at.sql',
        '0006_single_team_authorization.sql',
        '0007_encrypted_task_history.sql',
        '0008_admin_operations.sql',
        '0009_admin_sessions.sql',
      ]) {
        fs.copyFileSync(
          path.join(process.cwd(), 'migrations', file),
          path.join(v9MigrationsDir, file),
        );
      }

      const applied = await runMigrations(pool, v9MigrationsDir);
      expect(applied.at(-1)).toBe('0009_admin_sessions.sql');

      const team = await pool.query<{ id: string }>(
        `SELECT id FROM teams WHERE singleton_key = 'default'`,
      );
      const teamId = team.rows[0].id;
      const user = await pool.query<{ id: string }>(
        `INSERT INTO users (username, password_hash, created_at)
         VALUES ('migration-admin', 'hash', '2026-09-23T09:00:00Z')
         RETURNING id`,
      );
      await pool.query(
        `INSERT INTO team_memberships (team_id, user_id, role, active, created_at)
         VALUES ($1, $2, 'member', true, '2026-09-23T09:00:01Z')`,
        [teamId, user.rows[0].id],
      );
      await pool.query(
        `INSERT INTO admin_operations (id, requested_by, type, state, summary, created_at)
         VALUES ('op-pre-0010', $1, 'backup_restore', 'queued', 'Restore backup', '2026-09-23T09:05:00Z')`,
        [user.rows[0].id],
      );
      await pool.query(
        `INSERT INTO admin_audit_events (
           actor_user_id, action, source, outcome, metadata, created_at
         )
         VALUES ($1, 'admin_operation.created', 'admin_api', 'accepted', '{"operationId":"op-pre-0010"}', '2026-09-23T09:05:01Z')`,
        [user.rows[0].id],
      );

      const upgraded = await runMigrations(pool);
      expect(upgraded).toEqual([
        '0010_complete_admin_operations.sql',
        '0011_sso_codes.sql',
        '0012_multi_admin.sql',
      ]);

      await expect(
        pool.query(
          `INSERT INTO admin_operations (id, requested_by, type, state, summary, created_at)
           VALUES ('op-rollback', $1, 'deployment_rollback', 'queued', 'Rollback revision', now())`,
          [user.rows[0].id],
        ),
      ).resolves.toBeTruthy();
      await expect(
        pool.query(
          `INSERT INTO admin_operations (id, requested_by, type, state, summary, created_at)
           VALUES ('op-delete', $1, 'file_capture_delete', 'queued', 'Delete file capture', now())`,
          [user.rows[0].id],
        ),
      ).resolves.toBeTruthy();

      const preserved = await pool.query<{ summary: string }>(
        `SELECT summary FROM admin_operations WHERE id = 'op-pre-0010'`,
      );
      expect(preserved.rows).toEqual([{ summary: 'Restore backup' }]);

      const audits = await pool.query<{ action: string }>(
        `SELECT action FROM admin_audit_events WHERE metadata->>'operationId' = 'op-pre-0010'`,
      );
      expect(audits.rows).toEqual([{ action: 'admin_operation.created' }]);

      const constraints = await pool.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conrelid = 'admin_operations'::regclass
            AND contype = 'c'
            AND conname = 'admin_operations_type_check'`,
      );
      expect(constraints.rows[0].definition).toContain("'deployment_rollback'");
      expect(constraints.rows[0].definition).toContain("'file_capture_delete'");

      const schemaVersion = await pool.query<{ value: string }>(
        `SELECT value FROM schema_meta WHERE key = 'schema_version'`,
      );
      expect(schemaVersion.rows[0].value).toBe('12');

      const secondRun = await runMigrations(pool);
      expect(secondRun).toEqual([]);
    } finally {
      fs.rmSync(v9MigrationsDir, { recursive: true, force: true });
    }
  });

  it('stores admin dashboard sessions as hashes with an expiry index', async () => {
    if (!pool) {
      pool = createPool(TEST_DATABASE_URL);
    }
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await runMigrations(pool);

    const columns = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'admin_sessions'
        ORDER BY column_name ASC`,
    );
    expect(columns.rows.map((column) => column.column_name)).toEqual([
      'created_at',
      'csrf_hash',
      'expires_at',
      'id',
      'last_seen_at',
      'reauthenticated_until',
      'revoked_at',
      'token_hash',
      'user_id',
    ]);
    // No column may hold a raw token: only the two hex digests exist.
    expect(columns.rows.map((column) => column.column_name)).not.toContain('token');
    expect(columns.rows.map((column) => column.column_name)).not.toContain('csrf_token');

    const hashChecks = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'admin_sessions'::regclass AND contype = 'c'`,
    );
    const definitions = hashChecks.rows.map((row) => row.definition).join(' | ');
    expect(definitions).toContain("'^[0-9a-f]{64}$'");

    const indexes = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'admin_sessions'`,
    );
    const indexDefs = indexes.rows.map((row) => row.indexdef).join(' | ');
    expect(indexDefs).toContain('expires_at');
    expect(indexDefs).toContain('UNIQUE');
  });
});
