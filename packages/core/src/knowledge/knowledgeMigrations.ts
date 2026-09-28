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

export function applyKnowledgeGraphMetadataMigration(db: Database.Database): void {
  for (const [column, definition] of [
    ['qualified_name', 'TEXT'],
    ['source_version_id', 'TEXT'],
    ['start_offset', 'INTEGER'],
    ['end_offset', 'INTEGER'],
    ['start_line', 'INTEGER'],
    ['start_column', 'INTEGER'],
    ['end_line', 'INTEGER'],
    ['end_column', 'INTEGER'],
    ['span_label', 'TEXT'],
  ] as const) {
    if (!hasColumn(db, 'knowledge_graph_nodes', column)) {
      db.exec(`ALTER TABLE knowledge_graph_nodes ADD COLUMN ${column} ${definition}`);
    }
  }
}

export function applyKnowledgeReviewDeduplicationMigration(db: Database.Database): void {
  const duplicates = db.prepare(
    `SELECT project_id, page_version_id, summary
     FROM knowledge_reviews
     WHERE status = 'pending' AND summary IS NOT NULL
     GROUP BY project_id, IFNULL(page_version_id, ''), summary
     HAVING COUNT(*) > 1`,
  ).all() as Array<{ project_id: string; page_version_id: string | null; summary: string }>;

  for (const duplicate of duplicates) {
    const reviews = (duplicate.page_version_id === null
      ? db
          .prepare(
            `SELECT id, requested_at
             FROM knowledge_reviews
             WHERE project_id = ? AND page_version_id IS NULL AND status = 'pending' AND summary = ?
             ORDER BY requested_at, id`,
          )
          .all(duplicate.project_id, duplicate.summary)
      : db
          .prepare(
            `SELECT id, requested_at
             FROM knowledge_reviews
             WHERE project_id = ? AND page_version_id = ? AND status = 'pending' AND summary = ?
             ORDER BY requested_at, id`,
          )
          .all(duplicate.project_id, duplicate.page_version_id, duplicate.summary)) as Array<{
      id: string;
      requested_at: string;
    }>;
    const [survivor, ...extras] = reviews;
    if (!survivor) {
      continue;
    }
    for (const extra of extras) {
      const reparented = db.prepare(
        `UPDATE knowledge_review_actions
         SET review_id = @survivorId
         WHERE project_id = @projectId AND review_id = @reviewId`,
      ).run({
        survivorId: survivor.id,
        projectId: duplicate.project_id,
        reviewId: extra.id,
      });
      const remainingActions = db.prepare(
        `SELECT COUNT(*) AS count
         FROM knowledge_review_actions
         WHERE project_id = ? AND review_id = ?`,
      ).get(duplicate.project_id, extra.id) as { count: number };
      if (remainingActions.count !== 0) {
        throw new Error(`Knowledge review dedupe could not move all actions from ${extra.id} to ${survivor.id}`);
      }
      const deleted = db.prepare(
        `DELETE FROM knowledge_reviews
         WHERE id = @id AND project_id = @projectId AND status = 'pending'`,
      ).run({
        id: extra.id,
        projectId: duplicate.project_id,
      });
      if (deleted.changes !== 1) {
        throw new Error(`Knowledge review dedupe could not remove duplicate review ${extra.id}`);
      }
      const mergedActions = db.prepare(
        `SELECT COUNT(*) AS count
         FROM knowledge_review_actions
         WHERE project_id = ? AND review_id = ?`,
      ).get(duplicate.project_id, survivor.id) as { count: number };
      if (mergedActions.count < reparented.changes) {
        throw new Error(`Knowledge review dedupe lost action history while merging ${extra.id} into ${survivor.id}`);
      }
    }
  }

  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_reviews_pending_page_identity
     ON knowledge_reviews(project_id, page_version_id, summary)
     WHERE status = 'pending' AND page_version_id IS NOT NULL AND summary IS NOT NULL`,
  );
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_reviews_pending_project_identity
     ON knowledge_reviews(project_id, summary)
     WHERE status = 'pending' AND page_version_id IS NULL AND summary IS NOT NULL`,
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
    applyKnowledgeGraphMetadataMigration(db);
    applyKnowledgeReviewDeduplicationMigration(db);
  })();
}
