import type { Pool } from 'pg';

/**
 * Test-only helpers for the cross-team fixtures. Production only ever has the
 * singleton `default` team, so multi-team fixtures must temporarily relax the
 * `teams.singleton_key` NOT NULL + CHECK constraints created by
 * migrations/0006_single_team_authorization.sql. All test files share one
 * Postgres database, so every file that relaxes the schema must restore the
 * exact original constraint state in teardown.
 */
export async function relaxSingletonTeamConstraints(pool: Pool): Promise<void> {
  await pool.query('ALTER TABLE teams ALTER COLUMN singleton_key DROP NOT NULL');
  await pool.query('ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_singleton_key_check');
}

export async function restoreSingletonTeamConstraints(pool: Pool): Promise<void> {
  // Fixture rows use non-default singleton keys, so they must go before the
  // original constraints can be re-applied.
  await pool.query(
    'TRUNCATE TABLE todos, decisions, errors, open_questions, commands, checkpoints, tasks, team_memberships, teams, users CASCADE',
  );
  await pool.query('ALTER TABLE teams ALTER COLUMN singleton_key SET NOT NULL');
  await pool.query('ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_singleton_key_check');
  await pool.query(
    `ALTER TABLE teams ADD CONSTRAINT teams_singleton_key_check CHECK (singleton_key = 'default')`,
  );
}
