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
    expect(version.rows[0].value).toBe('7');

    const dedupIndex = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'encrypted_blobs' AND indexdef LIKE '%UNIQUE%plaintext_sha256%'`,
    );
    expect(dedupIndex.rows).toHaveLength(1);
    expect(dedupIndex.rows[0].indexdef).toContain('team_id');
    expect(dedupIndex.rows[0].indexdef).toContain('blob_type');

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
      expect(schemaVersion.rows[0].value).toBe('7');

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
      ).rejects.toMatchObject({ code: '23505' });

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
});
