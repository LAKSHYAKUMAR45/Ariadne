import type Database from 'better-sqlite3';
import { KNOWLEDGE_SCHEMA_SQL, KNOWLEDGE_SCHEMA_VERSION } from './knowledgeSchema.js';

export { KNOWLEDGE_SCHEMA_VERSION } from './knowledgeSchema.js';

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
    (entry) => entry.name === column,
  );
}

export function applyKnowledgeSchemaV2Migration(db: Database.Database): void {
  for (const [column, definition] of [
    ['start_line', 'INTEGER'],
    ['start_column', 'INTEGER'],
    ['end_line', 'INTEGER'],
    ['end_column', 'INTEGER'],
  ] as const) {
    if (!hasColumn(db, 'knowledge_source_spans', column)) {
      db.exec(`ALTER TABLE knowledge_source_spans ADD COLUMN ${column} ${definition}`);
    }
  }

  for (const [column, definition] of [
    ['analyzer_id', 'TEXT'],
    ['analyzer_version', 'TEXT'],
    ['extraction_hash', 'TEXT'],
    ['result_json', 'TEXT'],
    ['diagnostics_json', 'TEXT'],
    ['completed_at', 'TEXT'],
  ] as const) {
    if (!hasColumn(db, 'knowledge_extractions', column)) {
      db.exec(`ALTER TABLE knowledge_extractions ADD COLUMN ${column} ${definition}`);
    }
  }

  if (!hasColumn(db, 'knowledge_jobs', 'result_json')) {
    db.exec('ALTER TABLE knowledge_jobs ADD COLUMN result_json TEXT');
  }

  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_extractions_analyzer
     ON knowledge_extractions(
       project_id,
       source_version_id,
       extractor_kind,
       analyzer_id,
       analyzer_version
     )`,
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
    applyKnowledgeSchemaV2Migration(db);
    applyKnowledgeQueueMigration(db);
  })();
}
