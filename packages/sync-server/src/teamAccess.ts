import type { Pool } from 'pg';
import { ApiError } from './errors.js';

type MembershipRole = 'admin' | 'member';

const SINGLETON_TEAM_KEY = 'default';
const SINGLETON_TEAM_NAME = 'Default team';
const SINGLETON_TEAM_LOCK = 'ariadne-singleton-team-registration';

export interface ActiveMembership {
  teamId: string;
  role: MembershipRole;
}

interface TeamRow {
  id: string;
}

interface UserRow {
  id: string;
}

interface PostgresErrorLike {
  code?: string;
  constraint?: string;
}

function isPostgresError(error: unknown): error is PostgresErrorLike {
  return typeof error === 'object' && error !== null;
}

function isUsernameTakenError(error: unknown): boolean {
  return (
    isPostgresError(error) &&
    error.code === '23505' &&
    error.constraint === 'users_username_key'
  );
}

export async function requireActiveMembership(
  pool: Pool,
  userId: string,
): Promise<ActiveMembership> {
  const { rows } = await pool.query<ActiveMembership>(
    `SELECT team_id AS "teamId", role
     FROM team_memberships
     WHERE user_id = $1 AND active = true
     ORDER BY created_at ASC
     LIMIT 1`,
    [userId],
  );

  const membership = rows[0];
  if (!membership) {
    throw new ApiError(
      403,
      'inactive_membership',
      `User ${userId} does not have an active team membership`,
    );
  }

  return membership;
}

export async function registerIntoSingletonTeam(
  pool: Pool,
  username: string,
  passwordHash: string,
): Promise<{ userId: string; teamId: string; role: MembershipRole }> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('${SINGLETON_TEAM_LOCK}'))`,
    );
    await client.query(
      `INSERT INTO teams (singleton_key, name)
       VALUES ($1, $2)
       ON CONFLICT (singleton_key) DO NOTHING`,
      [SINGLETON_TEAM_KEY, SINGLETON_TEAM_NAME],
    );

    const teamResult = await client.query<TeamRow>(
      'SELECT id FROM teams WHERE singleton_key = $1',
      [SINGLETON_TEAM_KEY],
    );
    const teamId = teamResult.rows[0]?.id;
    if (!teamId) {
      throw new Error('Singleton team is missing after registration lock acquisition');
    }

    const adminResult = await client.query(
      `SELECT 1
       FROM team_memberships
       WHERE team_id = $1 AND role = 'admin'
       LIMIT 1`,
      [teamId],
    );
    const role: MembershipRole = adminResult.rows.length === 0 ? 'admin' : 'member';

    const userResult = await client.query<UserRow>(
      `INSERT INTO users (username, password_hash)
       VALUES ($1, $2)
       RETURNING id`,
      [username, passwordHash],
    );
    const userId = userResult.rows[0]?.id;
    if (!userId) {
      throw new Error(`Registration for ${username} did not return a user id`);
    }

    await client.query(
      `INSERT INTO team_memberships (team_id, user_id, role, active)
       VALUES ($1, $2, $3, true)`,
      [teamId, userId, role],
    );

    await client.query('COMMIT');
    return { userId, teamId, role };
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    if (isUsernameTakenError(error)) {
      throw new ApiError(409, 'username_taken', `Username "${username}" is already registered`);
    }
    throw error;
  } finally {
    client.release();
  }
}
