/**
 * Environment-driven configuration for the sync server. Kept as a single
 * small module (rather than a config library) matching this monorepo's
 * general preference for minimal dependencies.
 */
export interface SyncServerConfig {
  databaseUrl: string;
  jwtSecret: string;
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SyncServerConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required (e.g. postgres://user:pass@host:5432/db)');
  }
  const jwtSecret = env.SYNC_SERVER_JWT_SECRET;
  if (!jwtSecret) {
    throw new Error('SYNC_SERVER_JWT_SECRET environment variable is required');
  }
  const port = env.PORT ? parseInt(env.PORT, 10) : 4300;
  return { databaseUrl, jwtSecret, port };
}
