import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { verifyToken } from './auth.js';
import { ApiError, errorBody, internalErrorBody, isPayloadTooLargeError } from './errors.js';

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

interface JsonParseError extends SyntaxError {
  status: number;
  type: 'entity.parse.failed';
  body: string;
}

function isJsonParseError(error: unknown): error is JsonParseError {
  if (!(error instanceof SyntaxError)) {
    return false;
  }

  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as Partial<JsonParseError> & {
    type?: unknown;
    body?: unknown;
    status?: unknown;
  };

  return (
    candidate.type === 'entity.parse.failed' &&
    candidate.status === 400 &&
    typeof candidate.body === 'string'
  );
}

/** Express middleware requiring `Authorization: ****** per docs/07-CLOUD-SYNC-API-CONTRACT.md §4. */
export function requireAuth(jwtSecret: string) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const header = req.header('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    if (!token) {
      const err = new ApiError(401, 'missing_token', 'Authorization: ****** header is required');
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

  if (isPayloadTooLargeError(error)) {
    // Routes that need a larger ceiling (capture uploads, operator callbacks)
    // translate this into their own code before it reaches here; anything else
    // gets the stable global answer instead of a misleading 500.
    const err = new ApiError(413, 'payload_too_large', 'Request body is too large');
    res.status(err.status).json(errorBody(err));
    return;
  }

  if (isJsonParseError(error)) {
    const authenticatedRequest = req as AuthenticatedRequest;
    // V8's parse message can echo raw request fragments (including
    // credentials), so only fixed, non-body-derived metadata is logged.
    console.error('Malformed JSON request', {
      method: req.method,
      path: req.originalUrl,
      userId: authenticatedRequest.userId ?? null,
      error: {
        type: error.type,
        status: error.status,
        reason: 'request body could not be parsed',
      },
    });
    const err = new ApiError(400, 'invalid_request', 'Invalid request body');
    res.status(err.status).json(errorBody(err));
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
