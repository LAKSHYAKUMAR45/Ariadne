import express, { type Express } from 'express';
import type { Pool } from 'pg';
import { SyncServerConfigError } from './config.js';
import type { EncryptionKeyring } from './encryption.js';
import { createMembersRouter } from './routes/members.js';
import { handleUnexpectedError, requireAuth } from './middleware.js';
import { createAuthRouter } from './routes/auth.js';
import { createSyncRouter } from './routes/sync.js';

export interface CreateAppOptions {
  /** Required: the server must never run without a loaded keyring. */
  encryptionKeyring: EncryptionKeyring;
}

function assertKeyring(keyring: EncryptionKeyring | undefined): EncryptionKeyring {
  if (
    !keyring ||
    typeof keyring.activeKeyId !== 'string' ||
    keyring.activeKeyId.length === 0 ||
    typeof keyring.encrypt !== 'function' ||
    typeof keyring.decrypt !== 'function'
  ) {
    throw new SyncServerConfigError(
      'createApp requires a loaded encryptionKeyring; refusing to start without content encryption',
    );
  }

  return keyring;
}

/** Builds the Express app (unstarted) — used directly by tests, wrapped by index.ts for the real server. */
export function createApp(pool: Pool, jwtSecret: string, options: CreateAppOptions): Express {
  const encryptionKeyring = assertKeyring(options?.encryptionKeyring);

  const app = express();
  app.locals.encryptionKeyring = encryptionKeyring;
  app.use(express.json());

  app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

  app.use('/api/v1/auth', createAuthRouter(pool, jwtSecret));
  app.use('/api/v1/admin', requireAuth(jwtSecret), createMembersRouter(pool));
  app.use('/api/v1/sync', requireAuth(jwtSecret), createSyncRouter(pool));
  app.use(handleUnexpectedError);

  return app;
}
