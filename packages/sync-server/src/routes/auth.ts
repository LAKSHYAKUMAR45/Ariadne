import { Router } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { hashPassword, signToken, verifyPassword } from '../auth.js';
import { ApiError, errorBody } from '../errors.js';

const credentialsSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

export function createAuthRouter(pool: Pool, jwtSecret: string): Router {
  const router = Router();

  router.post('/register', async (req, res) => {
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

    const passwordHash = await hashPassword(password);
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id',
      [username, passwordHash]
    );
    res.status(201).json({ userId: rows[0].id, username });
  });

  router.post('/login', async (req, res) => {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      const err = new ApiError(400, 'invalid_request', parsed.error.message);
      res.status(err.status).json(errorBody(err));
      return;
    }
    const { username, password } = parsed.data;

    const { rows } = await pool.query<{ id: string; password_hash: string }>(
      'SELECT id, password_hash FROM users WHERE username = $1',
      [username]
    );
    const user = rows[0];
    const valid = user ? await verifyPassword(password, user.password_hash) : false;
    if (!user || !valid) {
      const err = new ApiError(401, 'invalid_credentials', 'Invalid username or password');
      res.status(err.status).json(errorBody(err));
      return;
    }

    const token = signToken({ sub: user.id, username }, jwtSecret);
    res.status(200).json({ token, userId: user.id, username });
  });

  return router;
}
