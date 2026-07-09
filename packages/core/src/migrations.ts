import type Database from 'better-sqlite3';

/**
 * Schema migration runner, closing the "no schema migrations" gap flagged
 * in the architecture review: previously `SCHEMA_SQL` only ever applied the
 * v1 schema (idempotently, via `IF NOT EXISTS`), with no path for
 * evolving an *existing* database (adding columns/tables/indexes,
 * backfilling data) as the schema changes in future releases. Every
 * surface (CLI, MCP server, VS Code extension) opens the same
 * `.ariadne/state.db` via `openDatabase()`, so wiring this in there means
 * migrations run transparently everywhere, with no per-surface work.
 *
 * Usage for future schema changes: bump `schema.ts`'s `SCHEMA_VERSION`,
 * and append a new entry to `MIGRATIONS` below with a `version` one higher
 * than the last and an `up(db)` that applies the delta (e.g.
 * `ALTER TABLE ... ADD COLUMN ...`). Each migration runs at most once, in
 * order, inside its own transaction, tracked via the `schema_meta` table's
 * `schema_version` key.
 */
export interface Migration {
  /** The schema version this migration brings the database *to*. Must be sequential (previous + 1). */
  version: number;
  /** A short description shown in logs/errors if the migration fails. */
  description: string;
  /** Applies the migration. Runs inside a transaction; throwing rolls it back and aborts startup. */
  up: (db: Database.Database) => void;
}

/**
 * Ordered list of migrations beyond the baseline v1 schema (which
 * `SCHEMA_SQL` already applies idempotently on every open). Empty for now —
 * v1 is the only schema version that has shipped — but the runner below is
 * exercised by tests using synthetic migrations, so it's proven to work
 * before it's ever needed for a real schema change.
 */
export const MIGRATIONS: Migration[] = [];

function getSchemaVersion(db: Database.Database): number {
  const row = db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  return row ? parseInt(row.value, 10) : 0;
}

function setSchemaVersion(db: Database.Database, version: number): void {
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(version));
}

/**
 * Applies every migration in `migrations` (defaults to `MIGRATIONS`) whose
 * version is greater than the database's current `schema_version`, in
 * ascending order, each inside its own transaction. Safe to call on every
 * `openDatabase()` — a no-op once a database is already at the latest
 * version. Throws (aborting startup) if a migration fails, rather than
 * risking a half-migrated database.
 */
export function runMigrations(db: Database.Database, migrations: Migration[] = MIGRATIONS): void {
  const pending = migrations.filter((m) => m.version > getSchemaVersion(db)).sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    const apply = db.transaction(() => {
      migration.up(db);
      setSchemaVersion(db, migration.version);
    });
    try {
      apply();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Migration to schema v${migration.version} ("${migration.description}") failed: ${message}`);
    }
  }
}
