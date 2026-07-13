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
    expect(tableNames).toEqual(expect.arrayContaining(['users', 'tasks', 'checkpoints', 'schema_meta', 'migrations_applied']));
  });
});
