import express, { type Express } from 'express';
import type { Pool } from 'pg';
import { requireAuth } from './middleware.js';
import { createAuthRouter } from './routes/auth.js';
import { createSyncRouter } from './routes/sync.js';

/** Builds the Express app (unstarted) — used directly by tests, wrapped by index.ts for the real server. */
export function createApp(pool: Pool, jwtSecret: string): Express {
  const app = express();
  app.use(express.json());

  app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

  app.use('/api/v1/auth', createAuthRouter(pool, jwtSecret));
  app.use('/api/v1/sync', requireAuth(jwtSecret), createSyncRouter(pool));

  return app;
}
