/**
 * Environment-driven configuration for the sync server. Kept as a single
 * small module (rather than a config library) matching this monorepo's
 * general preference for minimal dependencies.
 */
export interface SyncServerConfig {
  databaseUrl: string;
  encryptionKeyDir: string;
  jwtSecret: string;
  host: string;
  port: number;
}

export class SyncServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncServerConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SyncServerConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new SyncServerConfigError(
      'DATABASE_URL environment variable is required (e.g. postgresql://user:pass@host:5432/db)',
    );
  }

  const encryptionKeyDir = env.ENCRYPTION_KEY_DIR;
  if (!encryptionKeyDir) {
    throw new SyncServerConfigError('ENCRYPTION_KEY_DIR environment variable is required');
  }

  const jwtSecret = env.SYNC_SERVER_JWT_SECRET;
  if (!jwtSecret) {
    throw new SyncServerConfigError('SYNC_SERVER_JWT_SECRET environment variable is required');
  }

  const host = env.HOST ?? '127.0.0.1';
  const port = env.PORT ? Number(env.PORT) : 4300;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SyncServerConfigError('PORT must be an integer from 1 to 65535');
  }

  return { databaseUrl, encryptionKeyDir, jwtSecret, host, port };
}
