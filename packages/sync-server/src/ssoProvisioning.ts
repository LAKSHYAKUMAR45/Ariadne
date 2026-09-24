import type { Pool } from 'pg';

type SsoRole = 'admin' | 'member';

const SINGLETON_TEAM_KEY = 'default';
const SINGLETON_TEAM_NAME = 'Default team';

interface TeamRow {
  id: string;
}

interface UserRow {
  id: string;
}

/**
 * Creates or updates the Ariadne user + singleton-team membership for a
 * jcnr-triage-authenticated identity. This is a distinct code path from
 * `registerIntoSingletonTeam` (self-registration, "first user is admin"):
 * SSO provisioning always sets the role explicitly from jcnr-triage's own
 * role, which is how multiple Ariadne admins become possible without
 * touching self-registration's existing single-first-admin behavior.
 *
 * SSO-provisioned users have no `password_hash` (NULL) — they can only
 * authenticate through the SSO callback, never through
 * `POST /api/v1/admin/session`.
 */
export async function provisionSsoUser(
  pool: Pool,
  username: string,
  role: SsoRole,
): Promise<{ userId: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
      throw new Error('Singleton team is missing after provisioning insert');
    }

    const userResult = await client.query<UserRow>(
      `INSERT INTO users (username, password_hash)
       VALUES ($1, NULL)
       ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
       RETURNING id`,
      [username],
    );
    const userId = userResult.rows[0]?.id;
    if (!userId) {
      throw new Error(`SSO provisioning for ${username} did not return a user id`);
    }

    await client.query(
      `INSERT INTO team_memberships (team_id, user_id, role, active)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (team_id, user_id)
       DO UPDATE SET role = EXCLUDED.role, active = true`,
      [teamId, userId, role],
    );

    await client.query('COMMIT');
    return { userId };
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
