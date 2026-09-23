import { parse as parseCookieHeader } from 'cookie';
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import type { Pool } from 'pg';
import { requireSingletonAdmin } from './adminAccess.js';
import {
  ADMIN_SESSION_COOKIE_NAME,
  findActiveAdminSession,
  hashSessionToken,
  isReauthenticated,
  isWellFormedToken,
  timingSafeHexEqual,
  type AdminSessionRecord,
} from './adminSessions.js';
import { verifyToken } from './auth.js';
import { ApiError, errorBody, internalErrorBody, isPayloadTooLargeError } from './errors.js';

export interface AuthenticatedRequest extends Request {
  userId?: string;
  username?: string;
}

export interface AdminSessionRequest extends AuthenticatedRequest {
  adminSession?: {
    id: string;
    userId: string;
    csrfHash: string;
    reauthenticatedUntil: string | null;
  };
  adminReauthenticated?: boolean;
}

export const CSRF_HEADER = 'x-csrf-token';
/** Methods that cannot change state, and so carry no CSRF requirement. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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

/** Reads the admin session cookie with strict parsing, never touching other cookies. */
export function readAdminSessionCookie(req: Request): string | null {
  const header = req.header('cookie');
  if (!header) {
    return null;
  }
  const parsed = parseCookieHeader(header);
  const value = parsed[ADMIN_SESSION_COOKIE_NAME];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Exact-match Origin check.
 *
 * When no public origin is configured (development and the test harness) the
 * server accepts only requests that carry no `Origin` at all — i.e. non-browser
 * clients, which cannot be the target of a cross-site forgery. Browsers always
 * send `Origin` on state-changing requests, so a browser is only ever trusted
 * against a configured origin; production refuses to boot without one.
 */
export function isAllowedOrigin(req: Request, allowedOrigin: string | null): boolean {
  const origin = req.header('origin');
  if (allowedOrigin === null) {
    return origin === undefined;
  }
  return origin === allowedOrigin;
}

function rejectWith(res: Response, status: number, code: string, message: string): void {
  const err = new ApiError(status, code, message);
  res.status(err.status).json(errorBody(err));
}

/**
 * Authenticates a browser-facing `/api/v1/admin/*` request from its session
 * cookie. No bearer token is consulted: the sync JWT deliberately carries no
 * authority over the dashboard, so any `Authorization` header on these routes
 * is ignored outright.
 *
 * Active singleton-admin membership is re-queried on every request, so a
 * demotion or deactivation takes effect on the admin's very next call rather
 * than when their session happens to expire.
 */
export function requireAdminSession(pool: Pool): RequestHandler {
  return (req: AdminSessionRequest, res: Response, next: NextFunction): void => {
    void (async () => {
      const token = readAdminSessionCookie(req);
      if (!token) {
        rejectWith(res, 401, 'missing_session', 'An admin dashboard session is required');
        return;
      }
      if (!isWellFormedToken(token)) {
        rejectWith(res, 401, 'invalid_session', 'The dashboard session is invalid or expired');
        return;
      }

      const session = await findActiveAdminSession(pool, token);
      if (!session) {
        rejectWith(res, 401, 'invalid_session', 'The dashboard session is invalid or expired');
        return;
      }

      try {
        await requireSingletonAdmin(pool, session.userId);
      } catch (error: unknown) {
        if (error instanceof ApiError) {
          res.status(error.status).json(errorBody(error));
          return;
        }
        throw error;
      }

      attachAdminSession(req, session);
      next();
    })().catch(next);
  };
}

function attachAdminSession(req: AdminSessionRequest, session: AdminSessionRecord): void {
  req.userId = session.userId;
  req.adminSession = {
    id: session.id,
    userId: session.userId,
    csrfHash: session.csrfHash,
    reauthenticatedUntil: session.reauthenticatedUntil,
  };
  req.adminReauthenticated = isReauthenticated(session);
}

/**
 * Double-submit CSRF protection for every state-changing dashboard request:
 * the caller must prove both that it is running on the approved origin and
 * that it can read the CSRF token, which — unlike the session cookie — is
 * never sent automatically by the browser.
 */
export function requireCsrf(options: { allowedOrigin: string | null }): RequestHandler {
  return (req: AdminSessionRequest, res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }

    if (!isAllowedOrigin(req, options.allowedOrigin)) {
      rejectWith(res, 403, 'origin_not_allowed', 'Request origin is not allowed');
      return;
    }

    const session = req.adminSession;
    if (!session) {
      rejectWith(res, 401, 'missing_session', 'An admin dashboard session is required');
      return;
    }

    const presented = req.header(CSRF_HEADER);
    if (!isWellFormedToken(presented)) {
      rejectWith(res, 403, 'csrf_failed', 'A valid CSRF token is required');
      return;
    }

    if (!timingSafeHexEqual(hashSessionToken(presented), session.csrfHash)) {
      rejectWith(res, 403, 'csrf_failed', 'A valid CSRF token is required');
      return;
    }

    next();
  };
}

/**
 * Gates destructive operations on a password reauthentication performed within
 * the last five minutes. The window lives in the database, so it cannot be
 * forged or extended by anything the browser sends.
 */
export function requireRecentReauthentication(): RequestHandler {
  return (req: AdminSessionRequest, res: Response, next: NextFunction): void => {
    if (req.adminReauthenticated !== true) {
      rejectWith(
        res,
        403,
        'reauthentication_required',
        'This action requires a freshly reauthenticated dashboard session',
      );
      return;
    }
    next();
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
