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
 * `SCHEMA_SQL` already applies idempotently on every open). The runner is
 * also exercised by tests using synthetic migrations independent of this
 * list, so it was proven to work before it was ever needed for a real
 * schema change.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 2,
    description: 'Add remote_id/synced_at columns to tasks and checkpoints for cloud sync support',
    up: (db) => {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN remote_id TEXT;
        ALTER TABLE tasks ADD COLUMN synced_at TEXT;
        ALTER TABLE checkpoints ADD COLUMN remote_id TEXT;
        ALTER TABLE checkpoints ADD COLUMN synced_at TEXT;
        CREATE INDEX IF NOT EXISTS idx_tasks_remote_id ON tasks(remote_id);
        CREATE INDEX IF NOT EXISTS idx_checkpoints_remote_id ON checkpoints(remote_id);
      `);
    },
  },
  {
    version: 3,
    description: 'Add remote_id/synced_at columns to todos/decisions/errors/open_questions/commands for cloud sync support',
    up: (db) => {
      db.exec(`
        ALTER TABLE todos ADD COLUMN remote_id TEXT;
        ALTER TABLE todos ADD COLUMN synced_at TEXT;
        ALTER TABLE decisions ADD COLUMN remote_id TEXT;
        ALTER TABLE decisions ADD COLUMN synced_at TEXT;
        ALTER TABLE errors ADD COLUMN remote_id TEXT;
        ALTER TABLE errors ADD COLUMN synced_at TEXT;
        ALTER TABLE open_questions ADD COLUMN remote_id TEXT;
        ALTER TABLE open_questions ADD COLUMN synced_at TEXT;
        ALTER TABLE commands ADD COLUMN remote_id TEXT;
        ALTER TABLE commands ADD COLUMN synced_at TEXT;
        CREATE INDEX IF NOT EXISTS idx_todos_remote_id ON todos(remote_id);
        CREATE INDEX IF NOT EXISTS idx_decisions_remote_id ON decisions(remote_id);
        CREATE INDEX IF NOT EXISTS idx_errors_remote_id ON errors(remote_id);
        CREATE INDEX IF NOT EXISTS idx_open_questions_remote_id ON open_questions(remote_id);
        CREATE INDEX IF NOT EXISTS idx_commands_remote_id ON commands(remote_id);
      `);
    },
  },
  {
    version: 4,
    description: 'Add updated_at columns to decisions/errors/open_questions/commands and backfill from created_at',
    up: (db) => {
      db.exec(`
        ALTER TABLE decisions ADD COLUMN updated_at TEXT;
        ALTER TABLE errors ADD COLUMN updated_at TEXT;
        ALTER TABLE open_questions ADD COLUMN updated_at TEXT;
        ALTER TABLE commands ADD COLUMN updated_at TEXT;
        UPDATE decisions SET updated_at = created_at WHERE updated_at IS NULL;
        UPDATE errors SET updated_at = created_at WHERE updated_at IS NULL;
        UPDATE open_questions SET updated_at = created_at WHERE updated_at IS NULL;
        UPDATE commands SET updated_at = created_at WHERE updated_at IS NULL;
      `);
    },
  },
  {
    version: 5,
    description: 'Add immutable task file capture tables with same-task reference integrity',
    up: (db) => {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_commits_sha_task_id
          ON commits(sha, task_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_checkpoints_id_task_id
          ON checkpoints(id, task_id);

        CREATE TABLE IF NOT EXISTS task_file_captures (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          trigger TEXT NOT NULL CHECK (trigger IN ('git_commit', 'checkpoint', 'explicit')),
          git_commit_sha TEXT,
          checkpoint_id TEXT,
          created_at TEXT NOT NULL,
          synced_at TEXT,
          CHECK (
            (trigger = 'git_commit' AND git_commit_sha IS NOT NULL AND checkpoint_id IS NULL) OR
            (trigger = 'checkpoint' AND checkpoint_id IS NOT NULL AND git_commit_sha IS NULL) OR
            (trigger = 'explicit' AND git_commit_sha IS NULL AND checkpoint_id IS NULL)
          ),
          FOREIGN KEY (git_commit_sha, task_id) REFERENCES commits(sha, task_id),
          FOREIGN KEY (checkpoint_id, task_id) REFERENCES checkpoints(id, task_id)
        );
        CREATE INDEX IF NOT EXISTS idx_task_file_captures_task_created
          ON task_file_captures(task_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_task_file_captures_task_pending
          ON task_file_captures(task_id, synced_at, created_at);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_task_file_captures_git_commit_once
          ON task_file_captures(task_id, git_commit_sha)
          WHERE trigger = 'git_commit' AND git_commit_sha IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_task_file_captures_checkpoint_once
          ON task_file_captures(task_id, checkpoint_id)
          WHERE trigger = 'checkpoint' AND checkpoint_id IS NOT NULL;

        CREATE TABLE IF NOT EXISTS task_file_capture_entries (
          capture_id TEXT NOT NULL REFERENCES task_file_captures(id) ON DELETE CASCADE,
          path TEXT NOT NULL,
          content TEXT NOT NULL,
          unified_diff TEXT NOT NULL,
          byte_length INTEGER NOT NULL,
          content_sha256 TEXT NOT NULL,
          PRIMARY KEY (capture_id, path)
        );
        CREATE INDEX IF NOT EXISTS idx_task_file_capture_entries_capture
          ON task_file_capture_entries(capture_id);
      `);
    },
  },
];

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
