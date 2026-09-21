import { Router, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { requireSingletonAdmin } from '../adminAccess.js';
import { ApiError, errorBody } from '../errors.js';
import type { AuthenticatedRequest } from '../middleware.js';
import type { ActiveMembership } from '../teamAccess.js';

const patchMemberSchema = z.object({
  active: z.boolean(),
});

export interface TeamMemberView {
  userId: string;
  username: string;
  role: 'admin' | 'member';
  active: boolean;
  createdAt: string;
}

interface TeamMemberRow {
  userId: string;
  username: string;
  role: 'admin' | 'member';
  active: boolean;
  createdAt: Date;
}

function toTeamMemberView(row: TeamMemberRow): TeamMemberView {
  return {
    userId: row.userId,
    username: row.username,
    role: row.role,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createMembersRouter(pool: Pool): Router {
  const router = Router();

  async function requireAdmin(
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<ActiveMembership | null> {
    try {
      return await requireSingletonAdmin(pool, req.userId!);
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        res.status(error.status).json(errorBody(error));
        return null;
      }
      throw error;
    }
  }

  router.get('/members', async (req: AuthenticatedRequest, res) => {
    const adminMembership = await requireAdmin(req, res);
    if (!adminMembership) {
      return;
    }

    const { rows } = await pool.query<TeamMemberRow>(
      `SELECT tm.user_id AS "userId",
              u.username,
              tm.role,
              tm.active,
              tm.created_at AS "createdAt"
       FROM team_memberships tm
       JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = $1
       ORDER BY tm.created_at ASC, tm.user_id ASC`,
      [adminMembership.teamId],
    );

    res.status(200).json({ members: rows.map(toTeamMemberView) });
  });

  router.patch('/members/:userId', async (req: AuthenticatedRequest, res) => {
    const parsed = patchMemberSchema.safeParse(req.body);
    if (!parsed.success) {
      const err = new ApiError(400, 'invalid_request', parsed.error.message);
      res.status(err.status).json(errorBody(err));
      return;
    }

    const adminMembership = await requireAdmin(req, res);
    if (!adminMembership) {
      return;
    }

    const { rows: existingRows } = await pool.query<TeamMemberRow>(
      `SELECT tm.user_id AS "userId",
              u.username,
              tm.role,
              tm.active,
              tm.created_at AS "createdAt"
       FROM team_memberships tm
       JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = $1 AND tm.user_id = $2
       LIMIT 1`,
      [adminMembership.teamId, req.params.userId],
    );

    const existingMember = existingRows[0];
    if (!existingMember) {
      const err = new ApiError(
        404,
        'member_not_found',
        `No team member with userId ${req.params.userId}`,
      );
      res.status(err.status).json(errorBody(err));
      return;
    }

    if (existingMember.role === 'admin') {
      const err = new ApiError(
        409,
        'admin_immutable',
        'The singleton admin cannot be mutated through this API',
      );
      res.status(err.status).json(errorBody(err));
      return;
    }

    const { rows: updatedRows } = await pool.query<TeamMemberRow>(
      `WITH updated_membership AS (
         UPDATE team_memberships
         SET active = $3
         WHERE team_id = $1 AND user_id = $2 AND role = 'member'
         RETURNING user_id, role, active, created_at
       )
       SELECT updated_membership.user_id AS "userId",
              u.username,
              updated_membership.role,
              updated_membership.active,
              updated_membership.created_at AS "createdAt"
       FROM updated_membership
       JOIN users u ON u.id = updated_membership.user_id`,
      [adminMembership.teamId, req.params.userId, parsed.data.active],
    );

    const updatedMember = updatedRows[0];
    if (!updatedMember) {
       throw new Error(`Member update for ${req.params.userId} returned no row`);
    }

    res.status(200).json({ member: toTeamMemberView(updatedMember) });
  });

  return router;
}
