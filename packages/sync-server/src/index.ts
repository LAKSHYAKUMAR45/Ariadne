#!/usr/bin/env node
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { runMigrations } from './migrate.js';

/**
 * Entry point for `ariadne-sync-server`: runs any pending migrations, then
 * starts the HTTP API described in docs/07-CLOUD-SYNC-API-CONTRACT.md.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);

  const applied = await runMigrations(pool);
  if (applied.length > 0) {
    console.log(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
  }

  const app = createApp(pool, config.jwtSecret);
  app.listen(config.port, () => {
    console.log(`ariadne-sync-server listening on port ${config.port}`);
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
export { runMigrations } from './migrate.js';
