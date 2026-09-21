import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from './testConfig.js';
import { runMigrations } from '../src/migrate.js';
import { registerIntoSingletonTeam } from '../src/teamAccess.js';
import {
  CORE_FIXTURE_TABLES,
  truncateFixtureTables,
  isAuditTruncateTriggerEnabled,
} from './dbCleanup.js';

describe('test-only fixture cleanup helper', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL });
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await truncateFixtureTables(pool, CORE_FIXTURE_TABLES);
  });

  it('truncates cascading fixture tables even though admin_audit_events is append-only', async () => {
    const registration = await registerIntoSingletonTeam(pool, 'cleanup-user', 'hash-cleanup');

    await pool.query(
      `INSERT INTO admin_audit_events (actor_user_id, action, source, outcome)
       VALUES ($1, 'test.cleanup', 'test', 'success')`,
      [registration.userId],
    );

    await truncateFixtureTables(pool, CORE_FIXTURE_TABLES);

    const remainingUsers = await pool.query('SELECT 1 FROM users');
    expect(remainingUsers.rowCount).toBe(0);
    const remainingAudit = await pool.query('SELECT 1 FROM admin_audit_events');
    expect(remainingAudit.rowCount).toBe(0);
  });

  it('re-enables the append-only truncate trigger after a successful cleanup', async () => {
    await truncateFixtureTables(pool, CORE_FIXTURE_TABLES);

    expect(await isAuditTruncateTriggerEnabled(pool)).toBe(true);
    await expect(pool.query('TRUNCATE TABLE admin_audit_events')).rejects.toThrow(/append-only/i);
  });

  it('re-enables the append-only truncate trigger when the cleanup fails', async () => {
    await expect(
      truncateFixtureTables(pool, ['table_that_does_not_exist']),
    ).rejects.toThrow();

    expect(await isAuditTruncateTriggerEnabled(pool)).toBe(true);
    await expect(pool.query('TRUNCATE TABLE admin_audit_events')).rejects.toThrow(/append-only/i);
  });

  it('rejects table names that are not plain identifiers', async () => {
    await expect(
      truncateFixtureTables(pool, ['users; DROP TABLE users']),
    ).rejects.toThrow(/invalid table name/i);

    expect(await isAuditTruncateTriggerEnabled(pool)).toBe(true);
  });
});
