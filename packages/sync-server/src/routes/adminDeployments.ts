import { Router, type Response } from 'express';
import { ApiError } from '../errors.js';
import { asyncHandler, type AuthenticatedRequest } from '../middleware.js';
import { OperatorClientError } from '../operatorClient.js';
import type { OperatorQueryClient } from '../operatorQueryClient.js';

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

function toApiError(error: unknown): Error {
  if (error instanceof ApiError) {
    return error;
  }
  if (error instanceof OperatorClientError) {
    return new ApiError(error.status, error.code, error.message);
  }
  return error instanceof Error
    ? error
    : new ApiError(503, 'operator_unavailable', 'The operator service is not reachable');
}

export function createAdminDeploymentsRouter(options: {
  operatorQueryClient: OperatorQueryClient | null;
}): Router {
  const router = Router();

  router.use((_req, res, next) => {
    noStore(res);
    next();
  });

  router.get(
    '/services',
    asyncHandler(async (_req: AuthenticatedRequest, res) => {
      try {
        const operatorQueryClient = requireOperatorQueryClient(options.operatorQueryClient);
        const services = await operatorQueryClient.query({ type: 'service_status' });
        res.status(200).json(services);
      } catch (error: unknown) {
        throw toApiError(error);
      }
    }),
  );

  router.get(
    '/deployments',
    asyncHandler(async (_req: AuthenticatedRequest, res) => {
      try {
        const operatorQueryClient = requireOperatorQueryClient(options.operatorQueryClient);
        const deployment = await operatorQueryClient.query({ type: 'deployment_status' });
        res.status(200).json(deployment);
      } catch (error: unknown) {
        throw toApiError(error);
      }
    }),
  );

  return router;
}
