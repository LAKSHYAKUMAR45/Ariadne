import { Router, type Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import {
  asyncHandler,
  rethrowDatabaseUnavailable,
  type AuthenticatedRequest,
} from '../middleware.js';
import type { OperationsStore } from '../operationsStore.js';

const auditQuerySchema = z
  .object({
    cursor: z.string().regex(/^\d+$/).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(50),
    action: z.string().min(1).max(200).optional(),
    outcome: z.string().min(1).max(200).optional(),
  })
  .strict();

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
}

export function createAdminAuditRouter(options: { operationsStore: OperationsStore }): Router {
  const router = Router();

  router.use((_req, res, next) => {
    noStore(res);
    next();
  });

  router.get(
    '/audit',
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const parsed = auditQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new ApiError(400, 'invalid_request', parsed.error.message);
      }

      let audit;
      try {
        audit = await options.operationsStore.listAuditEvents({
          afterId: parsed.data.cursor ? Number(parsed.data.cursor) : undefined,
          limit: parsed.data.limit,
          action: parsed.data.action,
          outcome: parsed.data.outcome,
        });
      } catch (error: unknown) {
        rethrowDatabaseUnavailable(error);
      }

      res.status(200).json(audit);
    }),
  );

  return router;
}
