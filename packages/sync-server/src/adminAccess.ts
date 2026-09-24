import type { Pool } from 'pg';
import { ApiError } from './errors.js';
import type { ActiveMembership } from './teamAccess.js';

export async function requireSingletonAdmin(
  pool: Pool,
  userId: string,
): Promise<ActiveMembership> {
  const { rows } = await pool.query<ActiveMembership>(
    `SELECT team_id AS "teamId", role
     FROM team_memberships
     WHERE user_id = $1 AND active = true AND role = 'admin'
     ORDER BY created_at ASC
     LIMIT 1`,
    [userId],
  );

  const membership = rows[0];
  if (!membership) {
    throw new ApiError(403, 'admin_required', `User ${userId} is not the singleton admin`);
  }

  return membership;
}
