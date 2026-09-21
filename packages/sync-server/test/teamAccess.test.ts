import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { registerIntoSingletonTeam, requireActiveMembership } from '../src/teamAccess.js';
import { TEST_DATABASE_URL } from './testConfig.js';
import { CORE_FIXTURE_TABLES, truncateFixtureTables } from './dbCleanup.js';

describe('teamAccess', () => {
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

  it('makes the first registered user admin and later users members', async () => {
    const first = await registerIntoSingletonTeam(pool, 'alice', 'hash-alice');
    const second = await registerIntoSingletonTeam(pool, 'bob', 'hash-bob');

    expect(first.role).toBe('admin');
    expect(second.role).toBe('member');
    expect(second.teamId).toBe(first.teamId);

    await expect(requireActiveMembership(pool, first.userId)).resolves.toEqual({
      teamId: first.teamId,
      role: 'admin',
    });
    await expect(requireActiveMembership(pool, second.userId)).resolves.toEqual({
      teamId: first.teamId,
      role: 'member',
    });
  });

  it('returns forbidden for a user with inactive membership', async () => {
    const registration = await registerIntoSingletonTeam(pool, 'alice', 'hash-alice');

    await pool.query(
      'UPDATE team_memberships SET active = false WHERE team_id = $1 AND user_id = $2',
      [registration.teamId, registration.userId],
    );

    await expect(requireActiveMembership(pool, registration.userId)).rejects.toMatchObject({
      status: 403,
      code: 'inactive_membership',
    });
  });

  it('rolls back user creation if membership creation fails', async () => {
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_team_membership_insert()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'membership insert failed';
      END;
      $$;
    `);
    await pool.query(`
      CREATE TRIGGER fail_team_membership_insert_trigger
      BEFORE INSERT ON team_memberships
      FOR EACH ROW
      EXECUTE FUNCTION fail_team_membership_insert();
    `);

    try {
      await expect(registerIntoSingletonTeam(pool, 'alice', 'hash-alice')).rejects.toThrow(
        'membership insert failed',
      );

      const [users, teams, memberships] = await Promise.all([
        pool.query<{ count: number }>('SELECT count(*)::int AS count FROM users'),
        pool.query<{ count: number }>('SELECT count(*)::int AS count FROM teams'),
        pool.query<{ count: number }>('SELECT count(*)::int AS count FROM team_memberships'),
      ]);

      expect(users.rows[0].count).toBe(0);
      expect(teams.rows[0].count).toBe(0);
      expect(memberships.rows[0].count).toBe(0);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS fail_team_membership_insert_trigger ON team_memberships');
      await pool.query('DROP FUNCTION IF EXISTS fail_team_membership_insert()');
    }
  });

  it('keeps exactly one admin under concurrent first registrations', async () => {
    const registrations = await Promise.all([
      registerIntoSingletonTeam(pool, 'alice', 'hash-alice'),
      registerIntoSingletonTeam(pool, 'bob', 'hash-bob'),
    ]);

    const roles = registrations.map((registration) => registration.role).sort();
    expect(roles).toEqual(['admin', 'member']);
    expect(new Set(registrations.map((registration) => registration.teamId)).size).toBe(1);

    const teams = await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM teams');
    expect(teams.rows[0].count).toBe(1);

    const memberships = await pool.query<{ role: 'admin' | 'member'; count: number }>(
      `SELECT role, count(*)::int AS count
       FROM team_memberships
       GROUP BY role
       ORDER BY role ASC`,
    );
    expect(memberships.rows).toEqual([
      { role: 'admin', count: 1 },
      { role: 'member', count: 1 },
    ]);
  });
});
