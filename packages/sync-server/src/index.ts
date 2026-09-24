#!/usr/bin/env node
import { createApp } from './app.js';
import type { CreateAppOptions } from './app.js';
import { loadConfig, SyncServerConfigError } from './config.js';
import type { SyncServerConfig } from './config.js';
import { assertDashboardAssets } from './dashboardStatic.js';
import { createPool } from './db.js';
import { loadEncryptionKeyring } from './encryption.js';
import type { EncryptionKeyring } from './encryption.js';
import { runMigrations } from './migrate.js';
import { createOperatorClient } from './operatorClient.js';
import { createOperatorQueryClient } from './operatorQueryClient.js';
import type { OperatorClient } from './operatorClient.js';
import type { OperatorQueryClient } from './operatorQueryClient.js';

/**
 * Maps the loaded server config (plus the two runtime-constructed clients
 * that aren't part of Config) into the options object createApp expects.
 *
 * Kept as a separate, pure function -- with no Postgres pool, no HTTP
 * server, no process I/O -- specifically so a unit test can assert every
 * config field that's supposed to reach the app (like ssoSharedSecret) is
 * actually wired through, without needing to boot the whole server. A
 * previous version of main() built this object inline and silently dropped
 * ssoSharedSecret, defaulting the SSO handoff to always-fail in production
 * while every test still passed (all existing tests call createApp()
 * directly with the option already supplied, bypassing this exact wiring).
 */
export function buildAppOptions(
  config: SyncServerConfig,
  encryptionKeyring: EncryptionKeyring,
  operatorClient: OperatorClient | null,
  operatorQueryClient: OperatorQueryClient | null,
): CreateAppOptions {
  return {
    encryptionKeyring,
    operatorClient,
    operatorQueryClient,
    operatorCallbackTokenPath: config.operatorCallbackTokenPath,
    adminPublicOrigin: config.adminPublicOrigin,
    adminCookieSecure: config.adminCookieSecure,
    dashboardDistDir: config.dashboardDistDir,
    ssoSharedSecret: config.ssoSharedSecret,
  };
}

/**
 * Entry point for `ariadne-sync-server`: runs any pending migrations, then
 * starts the HTTP API described in docs/07-CLOUD-SYNC-API-CONTRACT.md.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  if (process.env.NODE_ENV === 'production' && !config.dashboardDistDir) {
    throw new SyncServerConfigError(
      'DASHBOARD_DIST_DIR environment variable is required for the production HTTP server',
    );
  }
  if (config.dashboardDistDir) {
    await assertDashboardAssets(config.dashboardDistDir);
  }
  const encryptionKeyring = loadEncryptionKeyring(config.encryptionKeyDir);
  const pool = createPool(config.databaseUrl);

  const applied = await runMigrations(pool);
  if (applied.length > 0) {
    console.log(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
  }

  const operatorClient = config.operatorSocketPath
    ? createOperatorClient({ socketPath: config.operatorSocketPath })
    : null;
  const operatorQueryClient = config.operatorSocketPath
    ? createOperatorQueryClient({ socketPath: config.operatorSocketPath })
    : null;

  const app = createApp(
    pool,
    config.jwtSecret,
    buildAppOptions(config, encryptionKeyring, operatorClient, operatorQueryClient),
  );
  app.listen(config.port, config.host, () => {
    console.log(`ariadne-sync-server listening on ${config.host}:${config.port}`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('ariadne-sync-server failed to start:', err);
    process.exit(1);
  });
}

export { createApp } from './app.js';
export { loadConfig } from './config.js';
export { createPool } from './db.js';
// `createEncryptionKeyring` is intentionally not re-exported: production must
// load key material from a validated key directory, and tests import the raw
// module directly.
export { loadEncryptionKeyring } from './encryption.js';
export { createOperatorClient } from './operatorClient.js';
export { runMigrations } from './migrate.js';
export { createTaskHistoryStore, DEFAULT_SERVER_CAPTURE_LIMITS } from './taskHistoryStore.js';
