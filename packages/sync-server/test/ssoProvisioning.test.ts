import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { provisionSsoUser } from '../src/ssoProvisioning.js';
import { TEST_DATABASE_URL } from './testConfig.js';
import { CORE_FIXTURE_TABLES, truncateFixtureTables } from './dbCleanup.js';
import type { Pool } from 'pg';

describe('provisionSsoUser', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = createPool(TEST_DATABASE_URL);
    await runMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await truncateFixtureTables(pool, CORE_FIXTURE_TABLES);
  });

  it('creates a new admin user and membership on first SSO login', async () => {
    const { userId } = await provisionSsoUser(pool, 'triage-admin', 'admin');
    const { rows } = await pool.query(
      `SELECT u.username, m.role
         FROM users u
         JOIN team_memberships m ON m.user_id = u.id
        WHERE u.id = $1 AND m.active = true`,
      [userId],
    );
    expect(rows).toEqual([{ username: 'triage-admin', role: 'admin' }]);
  });

  it('is idempotent: a second call with the same username and role does not duplicate rows', async () => {
    const first = await provisionSsoUser(pool, 'triage-guest', 'member');
    const second = await provisionSsoUser(pool, 'triage-guest', 'member');
    expect(second.userId).toBe(first.userId);
    const { rows } = await pool.query(
      'SELECT count(*)::int AS count FROM team_memberships WHERE user_id = $1',
      [first.userId],
    );
    expect(rows[0].count).toBe(1);
  });

  it('updates the membership role when jcnr-triage promotes a user from guest to admin', async () => {
    const { userId } = await provisionSsoUser(pool, 'promoted-user', 'member');
    await provisionSsoUser(pool, 'promoted-user', 'admin');
    const { rows } = await pool.query(
      `SELECT role FROM team_memberships WHERE user_id = $1 AND active = true`,
      [userId],
    );
    expect(rows).toEqual([{ role: 'admin' }]);
  });

  it('provisions two different users both as admins without unique-violation error', async () => {
    const first = await provisionSsoUser(pool, 'admin-user-1', 'admin');
    const second = await provisionSsoUser(pool, 'admin-user-2', 'admin');

    expect(first.userId).not.toBe(second.userId);

    const { rows } = await pool.query(
      `SELECT u.username, m.role
         FROM users u
         JOIN team_memberships m ON m.user_id = u.id
        WHERE m.active = true
        ORDER BY u.username`,
    );
    expect(rows).toEqual([
      { username: 'admin-user-1', role: 'admin' },
      { username: 'admin-user-2', role: 'admin' },
    ]);
  });
});
