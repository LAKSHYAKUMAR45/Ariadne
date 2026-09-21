import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { verifyToken } from './auth.js';
import { ApiError, errorBody, internalErrorBody } from './errors.js';

export interface AuthenticatedRequest extends Request {
  userId?: string;
  username?: string;
}

export function asyncHandler<TRequest extends Request = Request>(
  handler: (req: TRequest, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req as TRequest, res, next).catch(next);
  };
}

/** Express middleware requiring `Authorization: Bearer <token>`, per docs/07-CLOUD-SYNC-API-CONTRACT.md §4. */
export function requireAuth(jwtSecret: string) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const header = req.header('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    if (!token) {
      const err = new ApiError(401, 'missing_token', 'Authorization: Bearer <token> header is required');
      res.status(err.status).json(errorBody(err));
      return;
    }
    try {
      const payload = verifyToken(token, jwtSecret);
      req.userId = payload.sub;
      req.username = payload.username;
      next();
    } catch {
      const err = new ApiError(401, 'invalid_token', 'The provided token is invalid or expired');
      res.status(err.status).json(errorBody(err));
    }
  };
}

export const handleUnexpectedError: ErrorRequestHandler = (error, req, res, next): void => {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof ApiError) {
    res.status(error.status).json(errorBody(error));
    return;
  }

  const authenticatedRequest = req as AuthenticatedRequest;
  console.error('Unhandled sync-server error', {
    method: req.method,
    path: req.originalUrl,
    userId: authenticatedRequest.userId ?? null,
    error,
  });
  res.status(500).json(internalErrorBody());
};
