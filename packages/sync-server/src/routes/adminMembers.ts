import { Router, type Response } from 'express';
import type { Pool } from 'pg';
import { requireSingletonAdmin } from '../adminAccess.js';
import { asyncHandler, type AuthenticatedRequest } from '../middleware.js';

interface TeamMemberRow {
  userId: string;
  username: string;
  role: 'admin' | 'member';
  active: boolean;
  createdAt: Date;
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
}

export function createAdminMembersRouter(pool: Pool): Router {
  const router = Router();

  router.use((_req, res, next) => {
    noStore(res);
    next();
  });

  router.get(
    '/members',
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const adminMembership = await requireSingletonAdmin(pool, req.userId!);
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

      res.status(200).json({
        members: rows.map((row) => ({
          userId: row.userId,
          username: row.username,
          role: row.role,
          active: row.active,
          createdAt: row.createdAt.toISOString(),
          immutable: row.role === 'admin',
        })),
      });
    }),
  );

  return router;
}
