import { Router, type Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import { asyncHandler, type AuthenticatedRequest } from '../middleware.js';
import { OperatorClientError } from '../operatorClient.js';
import type { OperatorQueryClient } from '../operatorQueryClient.js';

const logsQuerySchema = z
  .object({
    source: z.enum(['sync-server', 'operator', 'deployment', 'backup']),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(50),
    severity: z.enum(['error', 'warning', 'info']).optional(),
    since: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
}

function requireOperatorQueryClient(
  operatorQueryClient: OperatorQueryClient | null,
): OperatorQueryClient {
  if (!operatorQueryClient) {
    throw new ApiError(503, 'operator_unavailable', 'The operator service is not configured');
  }
  return operatorQueryClient;
}

export function createAdminLogsRouter(options: {
  operatorQueryClient: OperatorQueryClient | null;
}): Router {
  const router = Router();

  router.use((_req, res, next) => {
    noStore(res);
    next();
  });

  router.get(
    '/logs',
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const parsed = logsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new ApiError(400, 'invalid_request', parsed.error.message);
      }

      try {
        const operatorQueryClient = requireOperatorQueryClient(options.operatorQueryClient);
        const logs = await operatorQueryClient.query({
          type: 'logs_read',
          source: parsed.data.source,
          cursor: parsed.data.cursor,
          limit: parsed.data.limit,
          severity: parsed.data.severity,
          since: parsed.data.since,
        });
        res.status(200).json(logs);
      } catch (error: unknown) {
        if (error instanceof OperatorClientError) {
          throw new ApiError(error.status, error.code, error.message);
        }
        throw error;
      }
    }),
  );

  return router;
}
