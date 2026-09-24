import { Router, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { requireSingletonAdmin } from '../adminAccess.js';
import { ApiError } from '../errors.js';
import {
  asyncHandler,
  rethrowDatabaseUnavailable,
  type AuthenticatedRequest,
} from '../middleware.js';
import { confirmationFor, requireConfirmation } from '../operationConfirmation.js';
import { ADMIN_OPERATION_SOURCE } from './adminOperations.js';

interface TeamMemberRow {
  userId: string;
  username: string;
  role: 'admin' | 'member';
  active: boolean;
  createdAt: Date;
}

interface ReauthenticatedAdminRequest extends AuthenticatedRequest {
  adminReauthenticated?: boolean;
}

const patchMemberSchema = z
  .object({
    active: z.boolean(),
    confirmation: z.string(),
  })
  .strict();

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
      try {
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
      } catch (error: unknown) {
        rethrowDatabaseUnavailable(error);
      }
    }),
  );

  router.patch(
    '/members/:userId',
    asyncHandler(async (req: ReauthenticatedAdminRequest, res) => {
      try {
        const adminMembership = await requireSingletonAdmin(pool, req.userId!);
        if (req.adminReauthenticated !== true) {
          throw new ApiError(
            403,
            'reauthentication_required',
            'This action requires a freshly reauthenticated dashboard session',
          );
        }

        const parsed = patchMemberSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          throw new ApiError(400, 'invalid_request', 'Request body is invalid');
        }

        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const { rows } = await client.query<TeamMemberRow>(
            `SELECT tm.user_id AS "userId",
                    u.username,
                    tm.role,
                    tm.active,
                    tm.created_at AS "createdAt"
               FROM team_memberships tm
               JOIN users u ON u.id = tm.user_id
              WHERE tm.team_id = $1 AND tm.user_id = $2
              LIMIT 1
              FOR UPDATE`,
            [adminMembership.teamId, req.params.userId],
          );

          const existingMember = rows[0];
          if (!existingMember) {
            throw new ApiError(404, 'member_not_found', 'No such team member');
          }
          if (existingMember.role === 'admin') {
            throw new ApiError(
              409,
              'admin_immutable',
              'The singleton admin cannot be mutated through this API',
            );
          }

          try {
            requireConfirmation(
              confirmationFor.memberState(existingMember.username, parsed.data.active),
              parsed.data.confirmation,
            );
          } catch {
            throw new ApiError(
              400,
              'confirmation_mismatch',
              'Confirmation text does not match the requested member action',
            );
          }

          const { rows: updatedRows } = await client.query<TeamMemberRow>(
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
            throw new ApiError(404, 'member_not_found', 'No such team member');
          }

          await client.query(
            `INSERT INTO admin_audit_events (
               actor_user_id, action, source, outcome, metadata
             )
             VALUES ($1, $2, $3, 'succeeded', $4::jsonb)`,
            [
              req.userId,
              updatedMember.active ? 'member.activate' : 'member.deactivate',
              ADMIN_OPERATION_SOURCE,
              JSON.stringify({
                userId: updatedMember.userId,
                username: updatedMember.username,
                previousActive: existingMember.active,
                active: updatedMember.active,
              }),
            ],
          );

          await client.query('COMMIT');
          res.status(200).json({
            member: {
              userId: updatedMember.userId,
              username: updatedMember.username,
              role: updatedMember.role,
              active: updatedMember.active,
              createdAt: updatedMember.createdAt.toISOString(),
              immutable: false,
            },
          });
        } catch (error: unknown) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      } catch (error: unknown) {
        rethrowDatabaseUnavailable(error);
      }
    }),
  );

  return router;
}
