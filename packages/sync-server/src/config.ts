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
  /**
   * Exact origin the admin dashboard is served from, e.g.
   * `https://ariadne.example.com` or the approved tunnelled
   * `http://127.0.0.1:4300`. Required in production; `null` only in
   * development, where non-browser clients are the sole callers.
   */
  adminPublicOrigin: string | null;
  /**
   * Whether the admin session cookie carries `Secure`. Derived from the public
   * origin's transport rather than configured independently, so the two can
   * never disagree.
   */
  adminCookieSecure: boolean;
}

export class SyncServerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncServerConfigError';
  }
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

/**
 * Validates `ADMIN_PUBLIC_ORIGIN` and derives the cookie's `Secure` flag from
 * it.
 *
 * HTTPS origins always get `Secure`. Plain HTTP is accepted only for a
 * loopback origin, which is exactly the approved deployment shape: the
 * dashboard is reached through an SSH tunnel that terminates on the operator's
 * machine, so the cleartext hop never leaves the host. Any other HTTP origin
 * would put the session cookie on the wire in the clear and is refused.
 */
function resolveAdminOrigin(env: NodeJS.ProcessEnv): {
  adminPublicOrigin: string | null;
  adminCookieSecure: boolean;
} {
  const raw = env.ADMIN_PUBLIC_ORIGIN?.trim();
  if (!raw) {
    if (env.NODE_ENV === 'production') {
      throw new SyncServerConfigError(
        'ADMIN_PUBLIC_ORIGIN environment variable is required in production (e.g. https://ariadne.example.com)',
      );
    }
    // Without a configured origin the server accepts no browser-issued
    // state-changing request at all (see middleware.isAllowedOrigin), so a
    // non-Secure cookie cannot be used for a cross-site attack here.
    return { adminPublicOrigin: null, adminCookieSecure: false };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SyncServerConfigError(
      'ADMIN_PUBLIC_ORIGIN must be an absolute origin (e.g. https://ariadne.example.com)',
    );
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SyncServerConfigError('ADMIN_PUBLIC_ORIGIN must use http or https');
  }
  if (url.username || url.password) {
    throw new SyncServerConfigError('ADMIN_PUBLIC_ORIGIN must not contain credentials');
  }
  if ((url.pathname !== '' && url.pathname !== '/') || url.search || url.hash) {
    throw new SyncServerConfigError(
      'ADMIN_PUBLIC_ORIGIN must be an origin only, without a path, query or fragment',
    );
  }

  const isLoopback = LOOPBACK_HOSTNAMES.has(url.hostname);
  if (url.protocol === 'http:' && !isLoopback) {
    throw new SyncServerConfigError(
      'ADMIN_PUBLIC_ORIGIN may only use http for a loopback host reached through the approved SSH tunnel',
    );
  }

  return { adminPublicOrigin: url.origin, adminCookieSecure: url.protocol === 'https:' };
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

  const { adminPublicOrigin, adminCookieSecure } = resolveAdminOrigin(env);

  return {
    databaseUrl,
    encryptionKeyDir,
    jwtSecret,
    host,
    port,
    operatorSocketPath,
    operatorCallbackTokenPath,
    adminPublicOrigin,
    adminCookieSecure,
  };
}
