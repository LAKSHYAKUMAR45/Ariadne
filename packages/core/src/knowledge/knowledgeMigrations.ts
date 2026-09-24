import type Database from 'better-sqlite3';
import { KNOWLEDGE_SCHEMA_SQL, KNOWLEDGE_SCHEMA_VERSION } from './knowledgeSchema.js';

export { KNOWLEDGE_SCHEMA_VERSION } from './knowledgeSchema.js';

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
    (entry) => entry.name === column,
  );
}

export function applyKnowledgeQueueMigration(db: Database.Database): void {
  for (const [column, definition] of [
    ['source_version_id', 'TEXT'],
    ['retry_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['max_retries', 'INTEGER NOT NULL DEFAULT 3'],
    ['worker_id', 'TEXT'],
    ['lease_expires_at', 'TEXT'],
  ] as const) {
    if (!hasColumn(db, 'knowledge_jobs', column)) {
      db.exec(`ALTER TABLE knowledge_jobs ADD COLUMN ${column} ${definition}`);
    }
  }
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_jobs_source_version
     ON knowledge_jobs(project_id, job_kind, source_version_id)
     WHERE source_version_id IS NOT NULL`,
  );
}

/**
 * Creates the additive knowledge schema atomically. It is idempotent so it
 * can be called safely by the shared migration runner on every database open.
 */
export function applyKnowledgeMigrations(db: Database.Database): void {
  db.transaction(() => {
    db.exec(KNOWLEDGE_SCHEMA_SQL);
    applyKnowledgeQueueMigration(db);
  })();
}
