/**
 * Environment-driven configuration for the sync server. Kept as a single
 * small module (rather than a config library) matching this monorepo's
 * general preference for minimal dependencies.
 */
import path from 'node:path';

export interface SyncServerConfig {
  databaseUrl: string;
  encryptionKeyDir: string;
  jwtSecret: string;
  host: string;
  port: number;
  /** Absolute Unix socket path of the privileged operator service, when deployed. */
  operatorSocketPath: string | null;
  /**
   * Absolute path of the shared credential the root operator uses to report
   * results. `null` disables the callback route entirely.
   */
  operatorCallbackTokenPath: string | null;
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
  if (!path.isAbsolute(encryptionKeyDir)) {
    throw new SyncServerConfigError(
      'ENCRYPTION_KEY_DIR must be an absolute path (e.g. /etc/ariadne/keys)',
    );
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

  const operatorSocketPath = env.OPERATOR_SOCKET_PATH ?? null;
  if (operatorSocketPath !== null && !path.isAbsolute(operatorSocketPath)) {
    throw new SyncServerConfigError(
      'OPERATOR_SOCKET_PATH must be an absolute path (e.g. /run/ariadne/operator.sock)',
    );
  }

  const operatorCallbackTokenPath = env.OPERATOR_CALLBACK_TOKEN_PATH ?? null;
  if (operatorCallbackTokenPath !== null && !path.isAbsolute(operatorCallbackTokenPath)) {
    throw new SyncServerConfigError(
      'OPERATOR_CALLBACK_TOKEN_PATH must be an absolute path (e.g. /run/ariadne/operator-callback-token)',
    );
  }

  return {
    databaseUrl,
    encryptionKeyDir,
    jwtSecret,
    host,
    port,
    operatorSocketPath,
    operatorCallbackTokenPath,
  };
}
