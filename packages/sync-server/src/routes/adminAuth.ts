/**
 * Browser-facing admin session routes.
 *
 * Only `POST /api/v1/admin/session` is reachable without a session; everything
 * else here requires the session cookie, and every state change additionally
 * requires the approved Origin plus the CSRF token.
 */
import { Router, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  ADMIN_LOGIN_ACTION,
  ADMIN_LOGOUT_ACTION,
  ADMIN_REAUTHENTICATION_ACTION,
  createAdminSession,
  markAdminSessionReauthenticated,
  rateLimiterKey,
  recordAdminAuthAuditEvent,
  revokeAdminSession,
  serializeAdminSessionCookie,
  serializeClearedAdminSessionCookie,
  type AdminAuthRateLimiter,
} from '../adminSessions.js';
import { verifyPassword } from '../auth.js';
import { ApiError, errorBody } from '../errors.js';
import {
  asyncHandler,
  isAllowedOrigin,
  requireAdminSession,
  requireCsrf,
  type AdminSessionRequest,
} from '../middleware.js';

const credentialsSchema = z
  .object({
    username: z.string().min(1).max(64),
    password: z.string().min(1).max(256),
  })
  .strict();

const reauthenticateSchema = z
  .object({
    password: z.string().min(1).max(256),
  })
  .strict();

/**
 * One fixed answer for every rejected login. Which half of the credential was
 * wrong, whether the account exists, and whether it is the active admin are
 * all withheld: the dashboard has exactly one legitimate user, so any
 * distinction would only ever help an attacker enumerate.
 */
const INVALID_CREDENTIALS = () =>
  new ApiError(401, 'invalid_credentials', 'Invalid username or password');

/**
 * A bcrypt hash of a value no caller can supply. Verifying against it keeps
 * the "no such user" path as expensive as the real one, so response timing
 * does not reveal whether a username exists.
 */
const DUMMY_PASSWORD_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEe.Vw1AM7bJmWpQrXbFNu4SeL9r7Fg3lKa';

export interface AdminAuthRouterOptions {
  /** Exact origin the dashboard is served from, or `null` outside production. */
  allowedOrigin: string | null;
  /** Whether the session cookie carries `Secure` (see config: HTTPS vs tunnelled loopback). */
  cookieSecure: boolean;
  rateLimiter: AdminAuthRateLimiter;
}

interface AdminUserRow {
  id: string;
  username: string;
  password_hash: string;
  is_active_admin: boolean;
}

/**
 * Loads the credential row together with the authorization fact in one query,
 * so login cannot observe a membership change halfway through.
 */
async function findAdminCandidate(pool: Pool, username: string): Promise<AdminUserRow | null> {
  const { rows } = await pool.query<AdminUserRow>(
    `SELECT u.id,
            u.username,
            u.password_hash,
            EXISTS (
              SELECT 1 FROM team_memberships m
               WHERE m.user_id = u.id AND m.active = true AND m.role = 'admin'
            ) AS is_active_admin
       FROM users u
      WHERE u.username = $1`,
    [username],
  );
  return rows[0] ?? null;
}

async function loadUsername(pool: Pool, userId: string): Promise<string | null> {
  const { rows } = await pool.query<{ username: string }>(
    'SELECT username FROM users WHERE id = $1',
    [userId],
  );
  return rows[0]?.username ?? null;
}

function sendRateLimited(res: Response, retryAfterSeconds: number): void {
  res.setHeader('Retry-After', String(retryAfterSeconds));
  const err = new ApiError(429, 'too_many_attempts', 'Too many attempts; try again later');
  res.status(err.status).json(errorBody(err));
}

/** Mounted at `/api/v1/admin/session`. */
export function createAdminAuthRouter(pool: Pool, options: AdminAuthRouterOptions): Router {
  const router = Router();
  const { allowedOrigin, cookieSecure, rateLimiter } = options;
  const cookieOptions = { secure: cookieSecure };

  router.post(
    '/',
    asyncHandler(async (req: AdminSessionRequest, res: Response) => {
      // Login has no session yet, so the CSRF token cannot apply; the Origin
      // check is still enforced so a foreign page cannot force a session onto
      // the browser.
      if (!isAllowedOrigin(req, allowedOrigin)) {
        const err = new ApiError(403, 'origin_not_allowed', 'Request origin is not allowed');
        res.status(err.status).json(errorBody(err));
        return;
      }

      const parsed = credentialsSchema.safeParse(req.body);
      if (!parsed.success) {
        // The validation detail is not echoed: zod reports the offending
        // value, which here is a credential.
        const err = new ApiError(400, 'invalid_request', 'Invalid request body');
        res.status(err.status).json(errorBody(err));
        return;
      }

      const { username, password } = parsed.data;
      const key = rateLimiterKey(username, req.ip);
      const decision = rateLimiter.check(key);
      if (!decision.allowed) {
        await recordAdminAuthAuditEvent(pool, {
          actorUserId: null,
          action: ADMIN_LOGIN_ACTION,
          outcome: 'failed',
          reason: 'rate_limited',
        });
        sendRateLimited(res, decision.retryAfterSeconds);
        return;
      }

      const candidate = await findAdminCandidate(pool, username);
      const passwordMatches = await verifyPassword(
        password,
        candidate?.password_hash ?? DUMMY_PASSWORD_HASH,
      );

      if (!candidate || !passwordMatches || !candidate.is_active_admin) {
        rateLimiter.recordFailure(key);
        await recordAdminAuthAuditEvent(pool, {
          // Attributing a failure to a user id would leak, through the audit
          // log, exactly the distinction the response withholds.
          actorUserId: null,
          action: ADMIN_LOGIN_ACTION,
          outcome: 'failed',
          reason: 'invalid_credentials',
        });
        const err = INVALID_CREDENTIALS();
        res.status(err.status).json(errorBody(err));
        return;
      }

      rateLimiter.reset(key);
      const created = await createAdminSession(pool, candidate.id);
      await recordAdminAuthAuditEvent(pool, {
        actorUserId: candidate.id,
        action: ADMIN_LOGIN_ACTION,
        outcome: 'succeeded',
      });

      res.setHeader('Set-Cookie', serializeAdminSessionCookie(created.sessionToken, cookieOptions));
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json({
        userId: candidate.id,
        username: candidate.username,
        csrfToken: created.csrfToken,
        expiresAt: created.session.expiresAt,
        reauthenticatedUntil: created.session.reauthenticatedUntil,
      });
    }),
  );

  // Everything below this line is session-authenticated.
  router.use(requireAdminSession(pool));
  router.use(requireCsrf({ allowedOrigin }));

  router.get(
    '/',
    asyncHandler(async (req: AdminSessionRequest, res: Response) => {
      const session = req.adminSession!;
      const username = await loadUsername(pool, session.userId);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        userId: session.userId,
        username,
        reauthenticatedUntil: session.reauthenticatedUntil,
      });
    }),
  );

  router.delete(
    '/',
    asyncHandler(async (req: AdminSessionRequest, res: Response) => {
      const session = req.adminSession!;
      await revokeAdminSession(pool, session.id);
      await recordAdminAuthAuditEvent(pool, {
        actorUserId: session.userId,
        action: ADMIN_LOGOUT_ACTION,
        outcome: 'succeeded',
      });
      res.setHeader('Set-Cookie', serializeClearedAdminSessionCookie(cookieOptions));
      res.status(204).end();
    }),
  );

  router.post(
    '/reauthenticate',
    asyncHandler(async (req: AdminSessionRequest, res: Response) => {
      const session = req.adminSession!;
      const parsed = reauthenticateSchema.safeParse(req.body);
      if (!parsed.success) {
        const err = new ApiError(400, 'invalid_request', 'Invalid request body');
        res.status(err.status).json(errorBody(err));
        return;
      }

      const username = await loadUsername(pool, session.userId);
      const key = rateLimiterKey(username ?? session.userId, req.ip);
      const decision = rateLimiter.check(key);
      if (!decision.allowed) {
        await recordAdminAuthAuditEvent(pool, {
          actorUserId: session.userId,
          action: ADMIN_REAUTHENTICATION_ACTION,
          outcome: 'failed',
          reason: 'rate_limited',
        });
        sendRateLimited(res, decision.retryAfterSeconds);
        return;
      }

      const { rows } = await pool.query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id = $1',
        [session.userId],
      );
      const passwordHash = rows[0]?.password_hash ?? DUMMY_PASSWORD_HASH;
      if (!(await verifyPassword(parsed.data.password, passwordHash))) {
        rateLimiter.recordFailure(key);
        await recordAdminAuthAuditEvent(pool, {
          actorUserId: session.userId,
          action: ADMIN_REAUTHENTICATION_ACTION,
          outcome: 'failed',
          reason: 'invalid_credentials',
        });
        const err = INVALID_CREDENTIALS();
        res.status(err.status).json(errorBody(err));
        return;
      }

      rateLimiter.reset(key);
      const reauthenticatedUntil = await markAdminSessionReauthenticated(pool, session.id);
      await recordAdminAuthAuditEvent(pool, {
        actorUserId: session.userId,
        action: ADMIN_REAUTHENTICATION_ACTION,
        outcome: 'succeeded',
      });

      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ reauthenticatedUntil });
    }),
  );

  return router;
}
