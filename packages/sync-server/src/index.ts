#!/usr/bin/env node
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { loadEncryptionKeyring } from './encryption.js';
import { runMigrations } from './migrate.js';
import { createOperatorClient } from './operatorClient.js';

/**
 * Entry point for `ariadne-sync-server`: runs any pending migrations, then
 * starts the HTTP API described in docs/07-CLOUD-SYNC-API-CONTRACT.md.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const encryptionKeyring = loadEncryptionKeyring(config.encryptionKeyDir);
  const pool = createPool(config.databaseUrl);

  const applied = await runMigrations(pool);
  if (applied.length > 0) {
    console.log(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
  }

  const operatorClient = config.operatorSocketPath
    ? createOperatorClient({ socketPath: config.operatorSocketPath })
    : null;

  const app = createApp(pool, config.jwtSecret, { encryptionKeyring, operatorClient });
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
