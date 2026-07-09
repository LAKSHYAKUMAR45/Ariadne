import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SCHEMA_SQL } from './schema.js';
import { runMigrations } from './migrations.js';

/**
 * Opens (creating if necessary) the Ariadne SQLite database at `dbPath` and
 * applies the schema. Safe to call repeatedly — schema statements use
 * `IF NOT EXISTS`. Also runs any pending migrations (see `migrations.ts`)
 * so a database created by an older release of Ariadne gets brought up to
 * the current schema version transparently.
 */
export function openDatabase(dbPath: string): Database.Database {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  if (dbPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  return db;
}
