import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { hashPassword, signToken, verifyPassword } from '../auth.js';
import { ApiError, errorBody } from '../errors.js';
import { asyncHandler } from '../middleware.js';
import { registerIntoSingletonTeam } from '../teamAccess.js';

const credentialsSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

/**
 * A bcrypt hash of a value no caller can supply. Verifying against it keeps
 * the "no such user" path as expensive as the real one, and prevents crashes
 * when a user has NULL password_hash (e.g., SSO-provisioned accounts).
 */
const DUMMY_PASSWORD_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEe.Vw1AM7bJmWpQrXbFNu4SeL9r7Fg3lKa';

export function createAuthRouter(pool: Pool, jwtSecret: string): Router {
  const router = Router();

  router.post('/register', asyncHandler(async (req, res, next) => {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      const err = new ApiError(400, 'invalid_request', parsed.error.message);
      res.status(err.status).json(errorBody(err));
      return;
    }
    const { username, password } = parsed.data;

    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) {
      const err = new ApiError(409, 'username_taken', `Username "${username}" is already registered`);
      res.status(err.status).json(errorBody(err));
      return;
    }

    try {
      const passwordHash = await hashPassword(password);
      const registration = await registerIntoSingletonTeam(pool, username, passwordHash);
      res.status(201).json({ userId: registration.userId, username, role: registration.role });
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        res.status(error.status).json(errorBody(error));
        return;
      }
      next(error);
    }
  }));

  router.post('/login', asyncHandler(async (req, res) => {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      const err = new ApiError(400, 'invalid_request', parsed.error.message);
      res.status(err.status).json(errorBody(err));
      return;
    }
    const { username, password } = parsed.data;

    const { rows } = await pool.query<{ id: string; password_hash: string | null }>(
      'SELECT id, password_hash FROM users WHERE username = $1',
      [username]
    );
    const user = rows[0];
    const passwordHash = user?.password_hash ?? DUMMY_PASSWORD_HASH;
    const valid = user ? await verifyPassword(password, passwordHash) : false;
    if (!user || !valid) {
      const err = new ApiError(401, 'invalid_credentials', 'Invalid username or password');
      res.status(err.status).json(errorBody(err));
      return;
    }

    const token = signToken({ sub: user.id, username }, jwtSecret);
    res.status(200).json({ token, userId: user.id, username });
  }));

  return router;
}
