import type Database from 'better-sqlite3';
import { KNOWLEDGE_SCHEMA_SQL, KNOWLEDGE_SCHEMA_VERSION } from './knowledgeSchema.js';
import { foldSearchText, trigramsOf } from './KnowledgeSearchTokens.js';

export { KNOWLEDGE_SCHEMA_VERSION } from './knowledgeSchema.js';

const KNOWLEDGE_COMPLETION_BACKFILL_BATCH_SIZE = 250;

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
    (entry) => entry.name === column,
  );
}

function hasTable(db: Database.Database, table: string): boolean {
  return (
    db.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as
      | { present: number }
      | undefined
  )?.present === 1;
}

function tableSql(db: Database.Database, table: string): string | null {
  return (
    db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as
      | { sql: string | null }
      | undefined
  )?.sql ?? null;
}

function knowledgeJobsNeedsConstraintUpgrade(db: Database.Database): boolean {
  const sql = tableSql(db, 'knowledge_jobs');
  return sql !== null && sql.includes('result_processing_mode') && !sql.includes(`'unknown'`);
}

function createKnowledgeJobsSupportingObjects(db: Database.Database): void {
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_knowledge_jobs_project_status
     ON knowledge_jobs(project_id, status, requested_at)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_knowledge_jobs_project_completed_mode
     ON knowledge_jobs(project_id, status, result_processing_mode, id)`,
  );
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_jobs_source_version
     ON knowledge_jobs(project_id, job_kind, source_version_id)
     WHERE source_version_id IS NOT NULL`,
  );
}

function createKnowledgeJobEventsTable(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS knowledge_job_events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id, job_id) REFERENCES knowledge_jobs(project_id, id) ON DELETE CASCADE
    )`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_knowledge_job_events_job_created
     ON knowledge_job_events(job_id, created_at)`,
  );
}

function recreateKnowledgeJobsWithUnknownCompletionMode(db: Database.Database): void {
  if (!knowledgeJobsNeedsConstraintUpgrade(db)) {
    return;
  }

  db.exec(`
    DROP INDEX IF EXISTS idx_knowledge_jobs_project_status;
    DROP INDEX IF EXISTS idx_knowledge_jobs_project_completed_mode;
    DROP INDEX IF EXISTS idx_knowledge_jobs_source_version;
  `);
  if (hasTable(db, 'knowledge_job_events')) {
    db.exec(`
      DROP TABLE IF EXISTS knowledge_job_events_backup;
      CREATE TABLE knowledge_job_events_backup AS
      SELECT id, project_id, job_id, event_kind, detail_json, created_at
      FROM knowledge_job_events;
      DROP TABLE knowledge_job_events;
    `);
  }
  db.exec(`
    CREATE TABLE knowledge_jobs_next (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
      job_kind TEXT NOT NULL,
      source_version_id TEXT,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      result_json TEXT,
      result_processing_mode TEXT CHECK (result_processing_mode IN ('deterministic', 'enriched', 'unknown') OR result_processing_mode IS NULL),
      requested_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      failure_code TEXT,
      failure_message TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      worker_id TEXT,
      lease_expires_at TEXT,
      UNIQUE (project_id, id)
    );
    INSERT INTO knowledge_jobs_next (
      id,
      project_id,
      job_kind,
      source_version_id,
      status,
      payload_json,
      result_json,
      result_processing_mode,
      requested_at,
      started_at,
      completed_at,
      failure_code,
      failure_message,
      retry_count,
      max_retries,
      worker_id,
      lease_expires_at
    )
    SELECT
      id,
      project_id,
      job_kind,
      source_version_id,
      status,
      payload_json,
      result_json,
      result_processing_mode,
      requested_at,
      started_at,
      completed_at,
      failure_code,
      failure_message,
      retry_count,
      max_retries,
      worker_id,
      lease_expires_at
    FROM knowledge_jobs;
    DROP TABLE knowledge_jobs;
    ALTER TABLE knowledge_jobs_next RENAME TO knowledge_jobs;
  `);
  createKnowledgeJobsSupportingObjects(db);
  createKnowledgeJobEventsTable(db);
  if (hasTable(db, 'knowledge_job_events_backup')) {
    db.exec(`
      INSERT INTO knowledge_job_events (id, project_id, job_id, event_kind, detail_json, created_at)
      SELECT id, project_id, job_id, event_kind, detail_json, created_at
      FROM knowledge_job_events_backup;
      DROP TABLE knowledge_job_events_backup;
    `);
  }
}

function completionModeForStoredResult(resultJson: string | null): 'deterministic' | 'enriched' | 'unknown' {
  if (resultJson === null) {
    return 'unknown';
  }
  try {
    const parsed = JSON.parse(resultJson) as { processingMode?: unknown };
    return parsed.processingMode === 'deterministic' || parsed.processingMode === 'enriched'
      ? parsed.processingMode
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

function backfillKnowledgeJobCompletionModes(db: Database.Database): void {
  if (!hasColumn(db, 'knowledge_jobs', 'result_processing_mode')) {
    return;
  }
  const selectBatch = db.prepare(
    `SELECT id, result_json
     FROM knowledge_jobs
     WHERE status = 'completed'
       AND result_processing_mode IS NULL
       AND id > ?
     ORDER BY id ASC
     LIMIT ?`,
  );
  const updateMode = db.prepare(
    `UPDATE knowledge_jobs
     SET result_processing_mode = @resultProcessingMode
     WHERE id = @id
       AND status = 'completed'
       AND result_processing_mode IS NULL`,
  );

  let afterId = '';
  while (true) {
    const rows = selectBatch.all(afterId, KNOWLEDGE_COMPLETION_BACKFILL_BATCH_SIZE) as Array<{
      id: string;
      result_json: string | null;
    }>;
    if (rows.length === 0) {
      return;
    }
    for (const row of rows) {
      const result = updateMode.run({
        id: row.id,
        resultProcessingMode: completionModeForStoredResult(row.result_json),
      });
      if (result.changes !== 1) {
        throw new Error(`Knowledge job completion-mode backfill could not update ${row.id}`);
      }
    }
    afterId = rows.at(-1)?.id ?? afterId;
  }
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
    ['result_processing_mode', 'TEXT'],
  ] as const) {
    if (!hasColumn(db, 'knowledge_jobs', column)) {
      db.exec(`ALTER TABLE knowledge_jobs ADD COLUMN ${column} ${definition}`);
    }
  }
  recreateKnowledgeJobsWithUnknownCompletionMode(db);
  backfillKnowledgeJobCompletionModes(db);
  createKnowledgeJobsSupportingObjects(db);
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
 * Creates the derived search-index tables (global migration 11, knowledge revision 7). The rows are rebuildable
 * from extractions, so they are never exported in archives.
 */
export function applyKnowledgeSearchIndexMigration(db: Database.Database): void {
  if (!hasTable(db, 'knowledge_search_indexes')) {
    db.exec(`
      CREATE TABLE knowledge_search_indexes (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        source_version_id TEXT NOT NULL,
        index_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        coverage TEXT NOT NULL,
        extraction_id TEXT,
        field_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (status IN ('active', 'stale', 'failed')),
        CHECK (coverage IN ('extraction', 'metadata_only')),
        CHECK ((coverage = 'extraction') = (extraction_id IS NOT NULL)),
        UNIQUE (project_id, id),
        UNIQUE (project_id, source_version_id),
        FOREIGN KEY (project_id, source_version_id)
          REFERENCES knowledge_source_versions(project_id, id)
          ON DELETE CASCADE
      )
    `);
  }
  if (!hasTable(db, 'knowledge_search_index_fields')) {
    db.exec(`
      CREATE TABLE knowledge_search_index_fields (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        index_id TEXT NOT NULL,
        field_order INTEGER NOT NULL,
        field_kind TEXT NOT NULL,
        field_text TEXT NOT NULL,
        field_weight REAL NOT NULL,
        rank_class INTEGER NOT NULL,
        span_id TEXT,
        symbol_kind TEXT,
        symbol_name TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (project_id, index_id, field_order),
        FOREIGN KEY (project_id, index_id)
          REFERENCES knowledge_search_indexes(project_id, id)
          ON DELETE CASCADE,
        FOREIGN KEY (project_id, span_id)
          REFERENCES knowledge_source_spans(project_id, id)
          ON DELETE NO ACTION
          DEFERRABLE INITIALLY DEFERRED
      )
    `);
  } else {
    relaxSearchIndexSpanForeignKey(db);
  }
  const hadTokenTable = hasTable(db, 'knowledge_search_index_tokens');
  if (!hadTokenTable) {
    db.exec(`
      CREATE TABLE knowledge_search_index_tokens (
        project_id TEXT NOT NULL,
        token TEXT NOT NULL,
        index_id TEXT NOT NULL,
        field_order INTEGER NOT NULL,
        PRIMARY KEY (project_id, token, index_id, field_order),
        FOREIGN KEY (project_id, index_id)
          REFERENCES knowledge_search_indexes(project_id, id)
          ON DELETE CASCADE
      ) WITHOUT ROWID
    `);
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_knowledge_search_indexes_project_status
     ON knowledge_search_indexes(project_id, status)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_knowledge_search_index_tokens_index_field
     ON knowledge_search_index_tokens(project_id, index_id, field_order)`,
  );
  if (!hadTokenTable) backfillSearchIndexTokens(db);
}

/**
 * The span reference used to be an immediate RESTRICT, which made a cascaded project or source-version delete fail
 * when span-backed fields were still present. Index fields are derived, so the reference is now a deferred check that
 * the same cascade satisfies before the statement completes.
 */
function relaxSearchIndexSpanForeignKey(db: Database.Database): void {
  const references = db.prepare('PRAGMA foreign_key_list(knowledge_search_index_fields)').all() as Array<{
    table: string;
    on_delete: string;
  }>;
  const strict = references.some((reference) => reference.table === 'knowledge_source_spans' && reference.on_delete === 'RESTRICT');
  if (!strict) return;
  db.exec(`
    CREATE TABLE knowledge_search_index_fields_next (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      index_id TEXT NOT NULL,
      field_order INTEGER NOT NULL,
      field_kind TEXT NOT NULL,
      field_text TEXT NOT NULL,
      field_weight REAL NOT NULL,
      rank_class INTEGER NOT NULL,
      span_id TEXT,
      symbol_kind TEXT,
      symbol_name TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (project_id, index_id, field_order),
      FOREIGN KEY (project_id, index_id)
        REFERENCES knowledge_search_indexes(project_id, id)
        ON DELETE CASCADE,
      FOREIGN KEY (project_id, span_id)
        REFERENCES knowledge_source_spans(project_id, id)
        ON DELETE NO ACTION
        DEFERRABLE INITIALLY DEFERRED
    );
    INSERT INTO knowledge_search_index_fields_next
      SELECT id, project_id, index_id, field_order, field_kind, field_text, field_weight, rank_class,
             span_id, symbol_kind, symbol_name, created_at
      FROM knowledge_search_index_fields;
    DROP TABLE knowledge_search_index_fields;
    ALTER TABLE knowledge_search_index_fields_next RENAME TO knowledge_search_index_fields;
  `);
}

function backfillSearchIndexTokens(db: Database.Database): void {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO knowledge_search_index_tokens (project_id, token, index_id, field_order) VALUES (?, ?, ?, ?)',
  );
  const fields = db
    .prepare('SELECT project_id, index_id, field_order, field_text FROM knowledge_search_index_fields')
    .all() as Array<{ project_id: string; index_id: string; field_order: number; field_text: string }>;
  for (const field of fields) {
    for (const gram of trigramsOf(foldSearchText(field.field_text))) {
      insert.run(field.project_id, gram, field.index_id, field.field_order);
    }
  }
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
    applyKnowledgeSearchIndexMigration(db);
  })();
}
