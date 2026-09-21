import express, { type Express } from 'express';
import type { Pool } from 'pg';
import type { EncryptionKeyring } from './encryption.js';
import { createMembersRouter } from './routes/members.js';
import { handleUnexpectedError, requireAuth } from './middleware.js';
import { createAuthRouter } from './routes/auth.js';
import { createSyncRouter } from './routes/sync.js';

export interface CreateAppOptions {
  encryptionKeyring?: EncryptionKeyring;
}

/** Builds the Express app (unstarted) — used directly by tests, wrapped by index.ts for the real server. */
export function createApp(pool: Pool, jwtSecret: string, options: CreateAppOptions = {}): Express {
  const app = express();
  app.locals.encryptionKeyring = options.encryptionKeyring ?? null;
  app.use(express.json());

  app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

  app.use('/api/v1/auth', createAuthRouter(pool, jwtSecret));
  app.use('/api/v1/admin', requireAuth(jwtSecret), createMembersRouter(pool));
  app.use('/api/v1/sync', requireAuth(jwtSecret), createSyncRouter(pool));
  app.use(handleUnexpectedError);

  return app;
}
