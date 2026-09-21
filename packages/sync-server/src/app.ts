import express, { type Express } from 'express';
import type { Pool } from 'pg';
import { SyncServerConfigError } from './config.js';
import type { EncryptionKeyring } from './encryption.js';
import { createMembersRouter } from './routes/members.js';
import { handleUnexpectedError, requireAuth } from './middleware.js';
import { createOperationsStore } from './operationsStore.js';
import type { OperatorClient } from './operatorClient.js';
import { createAdminOperationsRouter } from './routes/adminOperations.js';
import { createAdminTasksRouter } from './routes/adminTasks.js';
import { createAuthRouter } from './routes/auth.js';
import { createSyncRouter } from './routes/sync.js';
import { createTaskHistoryRouter } from './routes/taskHistory.js';
import { createTaskHistoryStore } from './taskHistoryStore.js';

export interface CreateAppOptions {
  /** Required: the server must never run without a loaded keyring. */
  encryptionKeyring: EncryptionKeyring;
  /** Omitted or `null` when no privileged operator socket is configured. */
  operatorClient?: OperatorClient | null;
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
  const taskHistoryStore = createTaskHistoryStore(pool, encryptionKeyring);

  app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

  // Capture uploads are mounted ahead of the global JSON parser so they can use
  // their own larger, route-scoped body limit (see CAPTURE_REQUEST_BODY_LIMIT)
  // without raising the 100 KB default for any other route. Requests that this
  // router does not match fall through to the parser and routers below.
  app.use('/api/v1/sync', requireAuth(jwtSecret), createTaskHistoryRouter(pool, taskHistoryStore));

  app.use(express.json());

  app.use('/api/v1/auth', createAuthRouter(pool, jwtSecret));
  app.use('/api/v1/admin', requireAuth(jwtSecret), createMembersRouter(pool));
  app.use('/api/v1/admin', requireAuth(jwtSecret), createAdminTasksRouter(pool, taskHistoryStore));
  app.use(
    '/api/v1/admin',
    requireAuth(jwtSecret),
    createAdminOperationsRouter(pool, {
      operationsStore: createOperationsStore(pool),
      operatorClient: options?.operatorClient ?? null,
    }),
  );
  app.use('/api/v1/sync', requireAuth(jwtSecret), createSyncRouter(pool));
  app.use(handleUnexpectedError);

  return app;
}
