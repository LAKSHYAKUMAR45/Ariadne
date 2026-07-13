import { Pool } from 'pg';
import { TEST_DATABASE_URL } from './testConfig.js';

/**
 * Vitest globalSetup: wipes the test database's schema once before the
 * whole suite runs, so test/migrate.test.ts's "applies migrations once"
 * assertion is reliable regardless of what a previous local run (or a
 * developer's own manual `pnpm run migrate` / `pnpm start` testing) left
 * behind in the same test database.
 */
export default async function globalSetup(): Promise<void> {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  } finally {
    await pool.end();
  }
}
