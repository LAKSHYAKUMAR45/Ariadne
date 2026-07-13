import fs from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import { loadConfig } from './config.js';
import { createPool } from './db.js';

/**
 * Runs any `.sql` files under packages/sync-server/migrations/ that haven't
 * been applied yet, in filename order (`0001_init.sql`, `0002_...sql`, ...).
 * Applied migrations are tracked in a `migrations_applied` table (separate
 * from `schema_meta`, which just records the logical schema version) so
 * this is safe to run repeatedly / idempotently on startup.
 */
export async function runMigrations(pool: Pool, migrationsDir: string = path.join(__dirname, '..', 'migrations')): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migrations_applied (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await pool.query<{ filename: string }>('SELECT filename FROM migrations_applied');
  const applied = new Set(rows.map((r) => r.filename));

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO migrations_applied (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      newlyApplied.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return newlyApplied;
}

/** CLI entrypoint: `node dist/migrate.js` (also exposed as `pnpm run migrate`). */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  try {
    const applied = await runMigrations(pool);
    if (applied.length === 0) {
      console.log('No new migrations to apply.');
    } else {
      console.log(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}

