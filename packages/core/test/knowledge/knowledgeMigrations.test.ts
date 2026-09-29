import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../../src/db.js';
import {
  applyKnowledgeMigrations,
  applyKnowledgeJobResultSchemaMigration,
  applyKnowledgeAnalysisCoverageMigration,
  applyKnowledgeGraphReportMigration,
  applyKnowledgeFreshnessMigration,
  applyKnowledgeSemanticMigration,
  applyKnowledgeSearchIndexMigration,
  applyKnowledgeReviewDeduplicationMigration,
  KNOWLEDGE_SCHEMA_VERSION,
} from '../../src/knowledge/knowledgeMigrations.js';
import { MIGRATIONS } from '../../src/migrations.js';
import { SCHEMA_SQL } from '../../src/schema.js';

const KNOWLEDGE_TABLES = [
  'knowledge_projects',
  'knowledge_project_roots',
  'knowledge_settings',
  'knowledge_provider_profiles',
  'knowledge_schema_versions',
  'knowledge_sources',
  'knowledge_source_versions',
  'knowledge_source_assets',
  'knowledge_source_spans',
  'knowledge_extractions',
  'knowledge_pages',
  'knowledge_page_versions',
  'knowledge_page_sources',
  'knowledge_page_provenance',
  'knowledge_page_aliases',
  'knowledge_page_links',
  'knowledge_graph_nodes',
  'knowledge_graph_edges',
  'knowledge_graph_snapshots',
  'knowledge_communities',
  'knowledge_insights',
  'knowledge_jobs',
  'knowledge_job_events',
  'knowledge_reviews',
  'knowledge_review_actions',
  'knowledge_research_runs',
  'knowledge_research_results',
  'knowledge_conversations',
  'knowledge_messages',
  'knowledge_outputs',
  'knowledge_operation_log',
] as const;

const REQUIRED_INDEXES = [
  'idx_knowledge_sources_project_hash',
  'idx_knowledge_pages_project_type',
  'idx_knowledge_jobs_project_status',
  'idx_knowledge_jobs_project_completed_mode',
  'idx_knowledge_reviews_project_status',
  'idx_knowledge_reviews_pending_page_identity',
  'idx_knowledge_reviews_pending_project_identity',
  'idx_knowledge_graph_edges_project_source_target',
] as const;

const temporaryDirectories: string[] = [];

function tableNames(db: Database.Database): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map(
    ({ name }) => name,
  );
}

function indexNames(db: Database.Database): string[] {
  return (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>).map(
    ({ name }) => name,
  );
}

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
}

function indexColumns(db: Database.Database, index: string): string[] {
  return (db.prepare(`PRAGMA index_info(${index})`).all() as Array<{ name: string }>).map(({ name }) => name);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('knowledge schema migrations', () => {
  it('creates every knowledge table and required index on a fresh database', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);

    applyKnowledgeMigrations(db);

    expect(tableNames(db)).toEqual(expect.arrayContaining(KNOWLEDGE_TABLES));
    expect(indexNames(db)).toEqual(expect.arrayContaining(REQUIRED_INDEXES));
    expect(KNOWLEDGE_SCHEMA_VERSION).toBe(12);
    expect(columns(db, 'knowledge_jobs')).toContain('result_schema_version');
    expect(columns(db, 'knowledge_extractions')).toEqual(
      expect.arrayContaining([
        'analyzer_id',
        'analyzer_version',
        'extraction_hash',
        'result_json',
        'diagnostics_json',
        'completed_at',
      ]),
    );
    expect(columns(db, 'knowledge_source_spans')).toEqual(
      expect.arrayContaining([
        'start_line',
        'start_column',
        'end_line',
        'end_column',
      ]),
    );
    expect(columns(db, 'knowledge_graph_nodes')).toEqual(
      expect.arrayContaining([
        'qualified_name',
        'source_version_id',
        'start_offset',
        'end_offset',
        'start_line',
        'start_column',
        'end_line',
        'end_column',
        'span_label',
      ]),
    );
    expect(columns(db, 'knowledge_jobs')).toEqual(
      expect.arrayContaining([
        'result_json',
        'result_processing_mode',
      ]),
    );

    db.close();
  });

  it('upgrades a pre-v5 knowledge jobs schema, backfills explicit completion modes, and reruns idempotently', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    db.exec(`
      CREATE TABLE knowledge_projects (
        id TEXT PRIMARY KEY,
        workspace_root TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE knowledge_jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES knowledge_projects(id) ON DELETE CASCADE,
        job_kind TEXT NOT NULL,
        source_version_id TEXT,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result_json TEXT,
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
      CREATE INDEX idx_knowledge_jobs_project_status ON knowledge_jobs(project_id, status, requested_at);
      CREATE UNIQUE INDEX idx_knowledge_jobs_source_version
        ON knowledge_jobs(project_id, job_kind, source_version_id)
        WHERE source_version_id IS NOT NULL;
    `);

    const createdAt = '2026-09-24T00:00:00.000Z';
    db.prepare(
      `INSERT INTO knowledge_projects (id, workspace_root, name, created_at, updated_at)
       VALUES ('project-1', '/workspace/one', 'One', ?, ?),
              ('project-2', '/workspace/two', 'Two', ?, ?)`,
    ).run(createdAt, createdAt, createdAt, createdAt);

    const insertLegacyJob = db.prepare(
      `INSERT INTO knowledge_jobs
       (id, project_id, job_kind, status, payload_json, result_json, requested_at, started_at, completed_at, retry_count, max_retries)
       VALUES (?, ?, 'analyze', ?, '{}', ?, ?, ?, ?, 0, 3)`,
    );
    for (let index = 0; index < 120; index += 1) {
      const suffix = index.toString().padStart(3, '0');
      insertLegacyJob.run(
        `job-det-${suffix}`,
        'project-1',
        'completed',
        '{"processingMode":"deterministic","warnings":[]}',
        createdAt,
        createdAt,
        createdAt,
      );
    }
    for (let index = 0; index < 75; index += 1) {
      const suffix = index.toString().padStart(3, '0');
      insertLegacyJob.run(
        `job-enriched-${suffix}`,
        'project-1',
        'completed',
        '{"processingMode":"enriched","warnings":[]}',
        createdAt,
        createdAt,
        createdAt,
      );
    }
    insertLegacyJob.run('job-malformed', 'project-1', 'completed', '{not-json', createdAt, createdAt, createdAt);
    insertLegacyJob.run('job-missing-mode', 'project-1', 'completed', '{"warnings":[]}', createdAt, createdAt, createdAt);
    insertLegacyJob.run('job-missing-result', 'project-1', 'completed', null, createdAt, createdAt, createdAt);
    insertLegacyJob.run(
      'job-project-2',
      'project-2',
      'completed',
      '{"processingMode":"deterministic","warnings":[]}',
      createdAt,
      createdAt,
      createdAt,
    );
    insertLegacyJob.run('job-failed', 'project-1', 'failed', null, createdAt, createdAt, createdAt);

    applyKnowledgeMigrations(db);
    applyKnowledgeMigrations(db);

    expect(columns(db, 'knowledge_jobs')).toContain('result_processing_mode');
    expect(indexNames(db)).toContain('idx_knowledge_jobs_project_completed_mode');
    expect(indexColumns(db, 'idx_knowledge_jobs_project_completed_mode')).toEqual([
      'project_id',
      'status',
      'result_processing_mode',
      'id',
    ]);
    expect(
      db.prepare(
        `SELECT result_processing_mode AS mode, COUNT(*) AS count
         FROM knowledge_jobs
         WHERE project_id = 'project-1' AND status = 'completed'
         GROUP BY result_processing_mode
         ORDER BY mode`,
      ).all(),
    ).toEqual([
      { mode: 'deterministic', count: 120 },
      { mode: 'enriched', count: 75 },
      { mode: 'unknown', count: 3 },
    ]);
    expect(
      db.prepare(`SELECT result_processing_mode FROM knowledge_jobs WHERE id = 'job-project-2'`).get(),
    ).toEqual({ result_processing_mode: 'deterministic' });
    expect(
      db.prepare(`SELECT result_processing_mode FROM knowledge_jobs WHERE id = 'job-failed'`).get(),
    ).toEqual({ result_processing_mode: null });

    db.close();
  });

  it('rolls back completion-mode backfill when a row update fails', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    applyKnowledgeMigrations(db);

    const createdAt = '2026-09-24T00:00:00.000Z';
    db.exec(`DROP INDEX IF EXISTS idx_knowledge_jobs_project_completed_mode`);
    db.prepare(
      `INSERT INTO knowledge_projects (id, workspace_root, name, created_at, updated_at)
       VALUES ('project-1', '/workspace/one', 'One', ?, ?)`,
    ).run(createdAt, createdAt);
    db.prepare(
      `INSERT INTO knowledge_jobs
       (id, project_id, job_kind, status, payload_json, result_json, result_processing_mode, requested_at, started_at, completed_at, retry_count, max_retries)
       VALUES
       ('job-det', 'project-1', 'analyze', 'completed', '{}', '{"processingMode":"deterministic"}', NULL, ?, ?, ?, 0, 3),
       ('job-unknown', 'project-1', 'analyze', 'completed', '{}', NULL, NULL, ?, ?, ?, 0, 3)`,
    ).run(createdAt, createdAt, createdAt, createdAt, createdAt, createdAt);
    db.exec(`
      CREATE TRIGGER trg_abort_unknown_completion_mode
      BEFORE UPDATE OF result_processing_mode ON knowledge_jobs
      WHEN NEW.id = 'job-unknown'
      BEGIN
        SELECT RAISE(ABORT, 'blocked completion-mode backfill');
      END;
    `);

    expect(() => applyKnowledgeMigrations(db)).toThrow(/blocked completion-mode backfill/);
    expect(
      db.prepare(
        `SELECT id, result_processing_mode
         FROM knowledge_jobs
         WHERE id IN ('job-det', 'job-unknown')
         ORDER BY id`,
      ).all(),
    ).toEqual([
      { id: 'job-det', result_processing_mode: null },
      { id: 'job-unknown', result_processing_mode: null },
    ]);
    expect(indexNames(db)).not.toContain('idx_knowledge_jobs_project_completed_mode');

    db.close();
  });

  it('registers knowledge migrations with the shared database initializer and is safe to reopen', () => {
    const directory = mkdtempSync(join(process.cwd(), '.knowledge-migrations-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'state.db');

    const first = openDatabase(databasePath);
    expect(tableNames(first)).toEqual(expect.arrayContaining(KNOWLEDGE_TABLES));
    first.close();

    const reopened = openDatabase(databasePath);
    expect(tableNames(reopened)).toEqual(expect.arrayContaining(KNOWLEDGE_TABLES));
    reopened.close();
  });

  it('preserves existing task records and schema metadata', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    db.prepare(
      `INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run('task-1', 'Existing task', 'active', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z');
    db.prepare(`INSERT INTO schema_meta (key, value) VALUES (?, ?)`).run('existing_key', 'existing_value');

    applyKnowledgeMigrations(db);

    expect(db.prepare(`SELECT id, title FROM tasks WHERE id = 'task-1'`).get()).toEqual({
      id: 'task-1',
      title: 'Existing task',
    });
    expect(db.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get()).toEqual({ value: '1' });
    expect(db.prepare(`SELECT value FROM schema_meta WHERE key = 'existing_key'`).get()).toEqual({
      value: 'existing_value',
    });

    db.close();
  });

  it('rejects source versions scoped to a different project than their source', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    applyKnowledgeMigrations(db);

    const createdAt = '2026-09-24T00:00:00.000Z';
    db.prepare(
      `INSERT INTO knowledge_projects (id, workspace_root, name, created_at, updated_at)
       VALUES ('project-1', '/workspace/one', 'One', ?, ?)`,
    ).run(createdAt, createdAt);
    db.prepare(
      `INSERT INTO knowledge_projects (id, workspace_root, name, created_at, updated_at)
       VALUES ('project-2', '/workspace/two', 'Two', ?, ?)`,
    ).run(createdAt, createdAt);
    db.prepare(
      `INSERT INTO knowledge_sources (id, project_id, source_kind, source_path, created_at, updated_at)
       VALUES ('source-1', 'project-1', 'file', 'notes.md', ?, ?)`,
    ).run(createdAt, createdAt);

    expect(() =>
      db.prepare(
        `INSERT INTO knowledge_source_versions (
          id, project_id, source_id, version_number, content_hash, content_path, byte_length, created_at
        ) VALUES ('source-version-1', 'project-2', 'source-1', 1, 'hash', 'content/hash', 4, ?)`,
      ).run(createdAt),
    ).toThrow(/FOREIGN KEY/);

    db.close();
  });

  it('enforces analyzer uniqueness for extraction persistence identity', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    applyKnowledgeMigrations(db);

    const createdAt = '2026-09-24T00:00:00.000Z';
    db.prepare(
      `INSERT INTO knowledge_projects (id, workspace_root, name, created_at, updated_at)
       VALUES ('project-1', '/workspace/one', 'One', ?, ?)`,
    ).run(createdAt, createdAt);
    db.prepare(
      `INSERT INTO knowledge_sources (id, project_id, source_kind, source_path, created_at, updated_at)
       VALUES ('source-1', 'project-1', 'file', 'notes.md', ?, ?)`,
    ).run(createdAt, createdAt);
    db.prepare(
      `INSERT INTO knowledge_source_versions (
           id, project_id, source_id, version_number, content_hash, content_path, byte_length, created_at
         ) VALUES ('source-version-1', 'project-1', 'source-1', 1, 'hash', 'content/hash', 4, ?)`,
    ).run(createdAt);
    db.prepare(
      `INSERT INTO knowledge_extractions (
         id,
         project_id,
         source_version_id,
         extractor_kind,
         analyzer_id,
         analyzer_version,
         result_path,
         content_hash,
         extraction_hash,
         result_json,
         diagnostics_json,
         status,
         completed_at,
         created_at,
         updated_at
       ) VALUES (?, 'project-1', 'source-version-1', 'deterministic', 'python-lezer', '1', 'result.json', 'hash', 'hash', '{}', '[]', 'completed', ?, ?, ?)`,
    ).run('extraction-1', createdAt, createdAt, createdAt);

    expect(() =>
      db.prepare(
        `INSERT INTO knowledge_extractions (
           id,
           project_id,
           source_version_id,
           extractor_kind,
           analyzer_id,
           analyzer_version,
           result_path,
           content_hash,
           extraction_hash,
           result_json,
           diagnostics_json,
           status,
           completed_at,
           created_at,
           updated_at
         ) VALUES (?, 'project-1', 'source-version-1', 'deterministic', 'python-lezer', '1', 'result-2.json', 'hash-2', 'hash-2', '{}', '[]', 'completed', ?, ?, ?)`,
      ).run('extraction-2', createdAt, createdAt, createdAt),
    ).toThrow(/UNIQUE/);

    db.close();
  });

  it('reparents duplicate pending review actions onto the deterministic survivor without losing audit history', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    applyKnowledgeMigrations(db);

    const createdAt = '2026-09-24T00:00:00.000Z';
    db.prepare(
      `INSERT INTO knowledge_projects (id, workspace_root, name, created_at, updated_at)
       VALUES ('project-1', '/workspace/one', 'One', ?, ?)`,
    ).run(createdAt, createdAt);
    db.prepare(
      `INSERT INTO knowledge_pages (id, project_id, page_type, title, slug, status, created_at, updated_at)
       VALUES ('page-1', 'project-1', 'source', 'src/app.py', 'source-src-app-py', 'active', ?, ?)`,
    ).run(createdAt, createdAt);
    db.prepare(
      `INSERT INTO knowledge_page_versions
       (id, project_id, page_id, version_number, content_hash, content_path, created_at)
       VALUES ('page-version-1', 'project-1', 'page-1', 1, 'hash', 'pages/source/source-src-app-py.md', ?)`,
    ).run(createdAt);
    db.exec(`
      DROP INDEX IF EXISTS idx_knowledge_reviews_pending_page_identity;
      DROP INDEX IF EXISTS idx_knowledge_reviews_pending_project_identity;
    `);

    db.prepare(
      `INSERT INTO knowledge_reviews
       (id, project_id, page_version_id, status, requested_at, summary)
       VALUES (?, 'project-1', 'page-version-1', 'pending', ?, 'Contradiction review')`,
    ).run('review-earliest', '2026-09-24T01:00:00.000Z');
    db.prepare(
      `INSERT INTO knowledge_reviews
       (id, project_id, page_version_id, status, requested_at, summary)
       VALUES (?, 'project-1', 'page-version-1', 'pending', ?, 'Contradiction review')`,
    ).run('review-latest', '2026-09-24T02:00:00.000Z');
    db.prepare(
      `INSERT INTO knowledge_review_actions
       (id, project_id, review_id, action_kind, comment, created_at)
       VALUES (?, 'project-1', ?, ?, ?, ?)`,
    ).run('action-1', 'review-earliest', 'accept', '{"actorId":"a"}', '2026-09-24T01:10:00.000Z');
    db.prepare(
      `INSERT INTO knowledge_review_actions
       (id, project_id, review_id, action_kind, comment, created_at)
       VALUES (?, 'project-1', ?, ?, ?, ?)`,
    ).run('action-2', 'review-earliest', 'reopen', '{"actorId":"b"}', '2026-09-24T01:20:00.000Z');
    db.prepare(
      `INSERT INTO knowledge_review_actions
       (id, project_id, review_id, action_kind, comment, created_at)
       VALUES (?, 'project-1', ?, ?, ?, ?)`,
    ).run('action-3', 'review-latest', 'research', '{"actorId":"c"}', '2026-09-24T02:10:00.000Z');
    db.prepare(
      `INSERT INTO knowledge_review_actions
       (id, project_id, review_id, action_kind, comment, created_at)
       VALUES (?, 'project-1', ?, ?, ?, ?)`,
    ).run('action-4', 'review-latest', 'label', '{"actorId":"d"}', '2026-09-24T02:20:00.000Z');

    applyKnowledgeReviewDeduplicationMigration(db);
    applyKnowledgeReviewDeduplicationMigration(db);

    expect(
      db.prepare(
        `SELECT id, requested_at
         FROM knowledge_reviews
         WHERE project_id = 'project-1'
         ORDER BY requested_at, id`,
      ).all(),
    ).toEqual([
      {
        id: 'review-earliest',
        requested_at: '2026-09-24T01:00:00.000Z',
      },
    ]);
    expect(
      db.prepare(
        `SELECT id, review_id, action_kind, created_at
         FROM knowledge_review_actions
         WHERE project_id = 'project-1'
         ORDER BY created_at, id`,
      ).all(),
    ).toEqual([
      { id: 'action-1', review_id: 'review-earliest', action_kind: 'accept', created_at: '2026-09-24T01:10:00.000Z' },
      { id: 'action-2', review_id: 'review-earliest', action_kind: 'reopen', created_at: '2026-09-24T01:20:00.000Z' },
      { id: 'action-3', review_id: 'review-earliest', action_kind: 'research', created_at: '2026-09-24T02:10:00.000Z' },
      { id: 'action-4', review_id: 'review-earliest', action_kind: 'label', created_at: '2026-09-24T02:20:00.000Z' },
    ]);

    db.close();
  });
});


describe('knowledge search index migration (global version 11, knowledge revision 7)', () => {
  it('registers contiguous ladder versions with search index at 11', () => {
    const versions = MIGRATIONS.map((migration) => migration.version);
    expect(versions).toEqual(Array.from({ length: versions.length }, (_, index) => index + 2));
    expect(MIGRATIONS.find((migration) => migration.version === 11)?.description).toMatch(/search index/i);
  });

  it('creates the derived index tables, columns, and lookup indexes on a fresh database', () => {
    const db = openDatabase(':memory:');

    expect(tableNames(db)).toEqual(
      expect.arrayContaining(['knowledge_search_indexes', 'knowledge_search_index_fields']),
    );
    expect(columns(db, 'knowledge_search_indexes')).toEqual([
      'id',
      'project_id',
      'source_version_id',
      'index_version',
      'status',
      'coverage',
      'extraction_id',
      'field_count',
      'created_at',
      'updated_at',
    ]);
    expect(columns(db, 'knowledge_search_index_fields')).toEqual([
      'id',
      'project_id',
      'index_id',
      'field_order',
      'field_kind',
      'field_text',
      'field_weight',
      'rank_class',
      'span_id',
      'symbol_kind',
      'symbol_name',
      'created_at',
    ]);
    expect(columns(db, 'knowledge_search_index_tokens')).toEqual(['project_id', 'token', 'index_id', 'field_order']);
    expect(indexNames(db)).toEqual(
      expect.arrayContaining([
        'idx_knowledge_search_indexes_project_status',
        'idx_knowledge_search_index_tokens_index_field',
      ]),
    );
    expect(indexColumns(db, 'idx_knowledge_search_index_tokens_index_field')).toEqual([
      'project_id',
      'index_id',
      'field_order',
    ]);
    db.close();
  });

  it('enforces coverage, status, and extraction-id consistency constraints', () => {
    const db = openDatabase(':memory:');
    applyKnowledgeMigrations(db);
    const now = '2026-09-29T00:00:00.000Z';
    db.prepare(
      `INSERT INTO knowledge_projects (id, workspace_root, name, status, created_at, updated_at)
       VALUES ('p', '/w', 'P', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO knowledge_sources (id, project_id, source_kind, source_path, status, created_at, updated_at)
       VALUES ('s', 'p', 'file', 'a.md', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO knowledge_source_versions (id, project_id, source_id, version_number, content_hash, content_path, byte_length, created_at)
       VALUES ('v', 'p', 's', 1, 'h', 'a.md', 1, ?)`,
    ).run(now);
    const insert = db.prepare(
      `INSERT INTO knowledge_search_indexes
       (id, project_id, source_version_id, index_version, status, coverage, extraction_id, field_count, created_at, updated_at)
       VALUES (?, 'p', 'v', 1, ?, ?, ?, 0, ?, ?)`,
    );
    expect(() => insert.run('i1', 'active', 'extraction', null, now, now)).toThrow();
    expect(() => insert.run('i2', 'active', 'metadata_only', 'e', now, now)).toThrow();
    expect(() => insert.run('i3', 'bogus', 'metadata_only', null, now, now)).toThrow();
    insert.run('i4', 'active', 'metadata_only', null, now, now);
    expect(() => insert.run('i5', 'active', 'metadata_only', null, now, now)).toThrow();
    db.close();
  });

  it('cascades index rows when the source version is deleted', () => {
    const db = openDatabase(':memory:');
    const now = '2026-09-29T00:00:00.000Z';
    db.prepare(
      `INSERT INTO knowledge_projects (id, workspace_root, name, status, created_at, updated_at)
       VALUES ('p', '/w', 'P', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO knowledge_sources (id, project_id, source_kind, source_path, status, created_at, updated_at)
       VALUES ('s', 'p', 'file', 'a.md', 'active', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO knowledge_source_versions (id, project_id, source_id, version_number, content_hash, content_path, byte_length, created_at)
       VALUES ('v', 'p', 's', 1, 'h', 'a.md', 1, ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO knowledge_search_indexes
       (id, project_id, source_version_id, index_version, status, coverage, extraction_id, field_count, created_at, updated_at)
       VALUES ('i', 'p', 'v', 1, 'active', 'metadata_only', NULL, 1, ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO knowledge_search_index_fields
       (id, project_id, index_id, field_order, field_kind, field_text, field_weight, rank_class, created_at)
       VALUES ('f', 'p', 'i', 0, 'path', 'a.md', 0, 1, ?)`,
    ).run(now);

    db.prepare(`DELETE FROM knowledge_sources WHERE id = 's'`).run();

    expect(db.prepare('SELECT COUNT(*) AS c FROM knowledge_search_indexes').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM knowledge_search_index_fields').get()).toEqual({ c: 0 });
    db.close();
  });

  it('upgrades a version-10 database, keeps data, and reopens idempotently', () => {
    const directory = mkdtempSync(join(process.cwd(), '.test-knowledge-index-migration-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'state.db');

    const first = openDatabase(databasePath);
    first.exec('DROP TABLE knowledge_search_index_fields; DROP TABLE knowledge_search_indexes;');
    first.prepare(`UPDATE schema_meta SET value = '10' WHERE key = 'schema_version'`).run();
    first.close();

    const upgraded = openDatabase(databasePath);
    expect(tableNames(upgraded)).toEqual(
      expect.arrayContaining(['knowledge_search_indexes', 'knowledge_search_index_fields']),
    );
    expect(
      Number((upgraded.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as { value: string }).value),
    ).toBeGreaterThanOrEqual(11);
    upgraded.close();

    const reopened = openDatabase(databasePath);
    expect(tableNames(reopened)).toEqual(
      expect.arrayContaining(['knowledge_search_indexes', 'knowledge_search_index_fields']),
    );
    reopened.close();
  });

  it('relaxes a legacy RESTRICT span reference and backfills tokens without losing fields', () => {
    const directory = mkdtempSync(join(process.cwd(), '.test-knowledge-index-restrict-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'state.db');
    const now = '2026-09-29T00:00:00.000Z';

    const first = openDatabase(databasePath);
    first.prepare(
      `INSERT INTO knowledge_projects (id, workspace_root, name, status, created_at, updated_at)
       VALUES ('p', '/w', 'P', 'active', ?, ?)`,
    ).run(now, now);
    first.prepare(
      `INSERT INTO knowledge_sources (id, project_id, source_kind, source_path, status, created_at, updated_at)
       VALUES ('s', 'p', 'file', 'a.md', 'active', ?, ?)`,
    ).run(now, now);
    first.prepare(
      `INSERT INTO knowledge_source_versions (id, project_id, source_id, version_number, content_hash, content_path, byte_length, created_at)
       VALUES ('v', 'p', 's', 1, 'h', 'a.md', 1, ?)`,
    ).run(now);
    first.prepare(
      `INSERT INTO knowledge_search_indexes
       (id, project_id, source_version_id, index_version, status, coverage, extraction_id, field_count, created_at, updated_at)
       VALUES ('i', 'p', 'v', 1, 'active', 'metadata_only', NULL, 1, ?, ?)`,
    ).run(now, now);
    first.prepare(
      `INSERT INTO knowledge_search_index_fields
       (id, project_id, index_id, field_order, field_kind, field_text, field_weight, rank_class, created_at)
       VALUES ('f', 'p', 'i', 0, 'path', 'Alpha.md', 0, 1, ?)`,
    ).run(now);
    first.exec(`
      DROP TABLE knowledge_search_index_tokens;
      ALTER TABLE knowledge_search_index_fields RENAME TO fields_old;
      CREATE TABLE knowledge_search_index_fields (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, index_id TEXT NOT NULL, field_order INTEGER NOT NULL,
        field_kind TEXT NOT NULL, field_text TEXT NOT NULL, field_weight REAL NOT NULL, rank_class INTEGER NOT NULL,
        span_id TEXT, symbol_kind TEXT, symbol_name TEXT, created_at TEXT NOT NULL,
        UNIQUE (project_id, index_id, field_order),
        FOREIGN KEY (project_id, index_id) REFERENCES knowledge_search_indexes(project_id, id) ON DELETE CASCADE,
        FOREIGN KEY (project_id, span_id) REFERENCES knowledge_source_spans(project_id, id) ON DELETE RESTRICT
      );
      INSERT INTO knowledge_search_index_fields SELECT * FROM fields_old;
      DROP TABLE fields_old;
    `);
    first.close();

    const upgraded = openDatabase(databasePath);
    applyKnowledgeSearchIndexMigration(upgraded);
    const references = upgraded.prepare('PRAGMA foreign_key_list(knowledge_search_index_fields)').all() as Array<{
      table: string;
      on_delete: string;
    }>;
    expect(references.find((reference) => reference.table === 'knowledge_source_spans')?.on_delete).toBe('NO ACTION');
    expect(upgraded.prepare('SELECT field_text FROM knowledge_search_index_fields').all()).toEqual([{ field_text: 'Alpha.md' }]);
    expect(
      (upgraded.prepare('SELECT token FROM knowledge_search_index_tokens ORDER BY token').all() as Array<{ token: string }>).map(
        (row) => row.token,
      ),
    ).toEqual(['.md', 'a.m', 'alp', 'ha.', 'lph', 'pha'].sort());
    upgraded.close();
  });
});

describe('knowledge job result schema migration (global version 12, knowledge revision 8)', () => {
  it('registers version 12 after the search index migration', () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 12);
    expect(migration?.description).toMatch(/result schema version/i);
    expect(MIGRATIONS.map((entry) => entry.version).filter((version) => version >= 11)).toEqual([11, 12, 13, 14, 15, 16]);
  });

  it('adds a nullable integer column on a fresh database without touching other jobs columns', () => {
    const db = openDatabase(':memory:');
    const info = db.prepare('PRAGMA table_info(knowledge_jobs)').all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    expect(info.find((column) => column.name === 'result_schema_version')).toMatchObject({
      type: 'INTEGER',
      notnull: 0,
      dflt_value: null,
    });
    db.close();
  });

  it('upgrades a version-11 database in place, keeps rows with NULL versions, and reopens idempotently', () => {
    const directory = mkdtempSync(join(process.cwd(), '.test-knowledge-result-version-migration-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'state.db');

    const first = openDatabase(databasePath);
    first.prepare(
      `INSERT INTO knowledge_projects (id, workspace_root, name, status, created_at, updated_at)
       VALUES ('project_1', 'workspace', 'Wiki', 'active', 'now', 'now')`,
    ).run();
    first.prepare(
      `INSERT INTO knowledge_jobs
       (id, project_id, job_kind, status, payload_json, requested_at, retry_count, max_retries, result_json, result_processing_mode)
       VALUES ('job_legacy', 'project_1', 'extract', 'completed', '{}', 'now', 0, 3, '{"processingMode":"deterministic"}', 'deterministic')`,
    ).run();
    const before = first.prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_knowledge_jobs_project_completed_mode'`).get();
    first.exec('ALTER TABLE knowledge_jobs DROP COLUMN result_schema_version');
    first.prepare(`UPDATE schema_meta SET value = '11' WHERE key = 'schema_version'`).run();
    first.close();

    const upgraded = openDatabase(databasePath);
    expect(columns(upgraded, 'knowledge_jobs')).toContain('result_schema_version');
    expect(upgraded.prepare(`SELECT result_processing_mode, result_schema_version FROM knowledge_jobs WHERE id = 'job_legacy'`).get()).toEqual({
      result_processing_mode: 'deterministic',
      result_schema_version: null,
    });
    expect(upgraded.prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_knowledge_jobs_project_completed_mode'`).get()).toEqual(before);
    expect(Number((upgraded.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as { value: string }).value)).toBe(16);
    upgraded.close();

    const reopened = openDatabase(databasePath);
    expect(columns(reopened, 'knowledge_jobs').filter((name) => name === 'result_schema_version')).toHaveLength(1);
    applyKnowledgeJobResultSchemaMigration(reopened);
    applyKnowledgeMigrations(reopened);
    expect(columns(reopened, 'knowledge_jobs').filter((name) => name === 'result_schema_version')).toHaveLength(1);
    reopened.close();
  });

  it('does not recreate knowledge_jobs when the column is added', () => {
    const db = openDatabase(':memory:');
    db.exec('ALTER TABLE knowledge_jobs DROP COLUMN result_schema_version');
    const rootPageBefore = (db.prepare(`SELECT rootpage FROM sqlite_master WHERE name = 'knowledge_jobs'`).get() as { rootpage: number }).rootpage;
    applyKnowledgeJobResultSchemaMigration(db);
    const rootPageAfter = (db.prepare(`SELECT rootpage FROM sqlite_master WHERE name = 'knowledge_jobs'`).get() as { rootpage: number }).rootpage;
    expect(rootPageAfter).toBe(rootPageBefore);
    db.close();
  });
});

describe('knowledge analysis coverage migration (global version 13, knowledge revision 9)', () => {
  function seedSourceVersion(db: Database.Database): void {
    db.prepare(
      `INSERT INTO knowledge_projects (id, workspace_root, name, status, created_at, updated_at)
       VALUES ('project_1', 'workspace', 'Wiki', 'active', 'now', 'now')`,
    ).run();
    db.prepare(
      `INSERT INTO knowledge_sources (id, project_id, source_kind, source_path, status, created_at, updated_at)
       VALUES ('source_1', 'project_1', 'file', 'a.rb', 'active', 'now', 'now')`,
    ).run();
    db.prepare(
      `INSERT INTO knowledge_source_versions (id, project_id, source_id, version_number, content_hash, content_path, byte_length, created_at)
       VALUES ('version_1', 'project_1', 'source_1', 1, 'hash', 'sources/a.txt', 1, 'now')`,
    ).run();
  }

  it('registers version 13 after the job result migration', () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 13);
    expect(migration?.description).toMatch(/analysis coverage/i);
    expect(MIGRATIONS.map((entry) => entry.version).filter((version) => version >= 11)).toEqual([11, 12, 13, 14, 15, 16]);
  });

  it('creates both tables with the specified columns and constraints on a fresh database', () => {
    const db = openDatabase(':memory:');
    expect(columns(db, 'knowledge_analysis_coverage')).toEqual([
      'id', 'project_id', 'source_version_id', 'status', 'analyzer_id', 'analyzer_version', 'generated_code',
      'generated_reason', 'unsupported_reason', 'supported_features_json', 'missing_features_json',
      'diagnostics_json', 'created_at', 'updated_at',
    ]);
    expect(columns(db, 'knowledge_deferred_relationships')).toEqual([
      'id', 'project_id', 'source_version_id', 'relationship_type', 'source_symbol_id', 'target_symbol_id',
      'target_reference', 'resolution_kind', 'evidence_kind', 'confidence', 'span_id', 'metadata_json', 'created_at',
    ]);
    seedSourceVersion(db);
    const insertCoverage = (id: string, status: string) =>
      db.prepare(
        `INSERT INTO knowledge_analysis_coverage
         (id, project_id, source_version_id, status, supported_features_json, missing_features_json, diagnostics_json, created_at, updated_at)
         VALUES (?, 'project_1', 'version_1', ?, '[]', '[]', '[]', 'now', 'now')`,
      ).run(id, status);
    expect(() => insertCoverage('c_bad', 'bogus')).toThrow(/CHECK/);
    insertCoverage('c1', 'unsupported');
    expect(() => insertCoverage('c2', 'supported')).toThrow(/UNIQUE/);
    const insertDeferred = (id: string, kind: string) =>
      db.prepare(
        `INSERT INTO knowledge_deferred_relationships
         (id, project_id, source_version_id, relationship_type, target_reference, resolution_kind, evidence_kind, confidence, metadata_json, created_at)
         VALUES (?, 'project_1', 'version_1', 'calls', 'x', ?, 'syntax', 0.5, '{}', 'now')`,
      ).run(id, kind);
    expect(() => insertDeferred('d_bad', 'made_up')).toThrow(/CHECK/);
    insertDeferred('d1', 'dynamic_runtime');
    db.prepare(`DELETE FROM knowledge_source_versions WHERE id = 'version_1'`).run();
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_analysis_coverage').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_deferred_relationships').get()).toEqual({ count: 0 });
    db.close();
  });

  it('lets a span referenced by a deferred relationship be removed with its source version', () => {
    const db = openDatabase(':memory:');
    seedSourceVersion(db);
    db.prepare(
      `INSERT INTO knowledge_source_spans (id, project_id, source_version_id, start_offset, end_offset, created_at)
       VALUES ('span_1', 'project_1', 'version_1', 0, 1, 'now')`,
    ).run();
    db.prepare(
      `INSERT INTO knowledge_deferred_relationships
       (id, project_id, source_version_id, relationship_type, target_reference, resolution_kind, evidence_kind, confidence, span_id, metadata_json, created_at)
       VALUES ('d1', 'project_1', 'version_1', 'calls', 'x', 'dynamic_runtime', 'syntax', 0.5, 'span_1', '{}', 'now')`,
    ).run();
    expect(() => db.prepare(`DELETE FROM knowledge_projects WHERE id = 'project_1'`).run()).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_deferred_relationships').get()).toEqual({ count: 0 });
    db.close();
  });

  it('upgrades a version-12 database in place, treats existing sources as coverage-less, and reopens idempotently', () => {
    const directory = mkdtempSync(join(process.cwd(), '.test-knowledge-coverage-migration-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'state.db');

    const first = openDatabase(databasePath);
    seedSourceVersion(first);
    first.exec('DROP TABLE knowledge_deferred_relationships; DROP TABLE knowledge_analysis_coverage;');
    first.prepare(`UPDATE schema_meta SET value = '12' WHERE key = 'schema_version'`).run();
    first.close();

    const upgraded = openDatabase(databasePath);
    expect(tableNames(upgraded)).toEqual(
      expect.arrayContaining(['knowledge_analysis_coverage', 'knowledge_deferred_relationships']),
    );
    expect(upgraded.prepare('SELECT COUNT(*) AS count FROM knowledge_analysis_coverage').get()).toEqual({ count: 0 });
    expect(upgraded.prepare(`SELECT COUNT(*) AS count FROM knowledge_source_versions`).get()).toEqual({ count: 1 });
    expect(Number((upgraded.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as { value: string }).value)).toBe(16);
    upgraded.close();

    const reopened = openDatabase(databasePath);
    applyKnowledgeAnalysisCoverageMigration(reopened);
    applyKnowledgeMigrations(reopened);
    expect(tableNames(reopened).filter((name) => name === 'knowledge_analysis_coverage')).toHaveLength(1);
    reopened.close();
  });
});

describe('knowledge graph report migration (global version 14, knowledge revision 10)', () => {
  function seedProject(db: Database.Database): void {
    db.prepare(
      `INSERT INTO knowledge_projects (id, workspace_root, name, status, created_at, updated_at)
       VALUES ('project_1', 'workspace', 'Wiki', 'active', 'now', 'now')`,
    ).run();
    db.prepare(
      `INSERT INTO knowledge_graph_snapshots (id, project_id, snapshot_number, content_hash, content_path, created_at)
       VALUES ('snapshot_1', 'project_1', 1, 'hash', 'graph/1.json', 'now')`,
    ).run();
  }

  it('registers version 14 after the analysis coverage migration', () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 14);
    expect(migration?.description).toMatch(/graph (completeness|report)/i);
    expect(MIGRATIONS.map((entry) => entry.version).filter((version) => version >= 13)).toEqual([13, 14, 15, 16]);
  });

  it('creates both tables with the specified columns and constraints on a fresh database', () => {
    const db = openDatabase(':memory:');
    expect(columns(db, 'knowledge_graph_reports')).toEqual([
      'id', 'project_id', 'graph_snapshot_id', 'report_json', 'created_at',
    ]);
    expect(columns(db, 'knowledge_graph_ambiguities')).toEqual([
      'id', 'project_id', 'graph_snapshot_id', 'source_version_id', 'source_node_id', 'target_node_id',
      'ambiguity_kind', 'severity', 'detail_json', 'created_at',
    ]);
    seedProject(db);
    const insertAmbiguity = (id: string, kind: string, severity: string, snapshot: string | null) =>
      db.prepare(
        `INSERT INTO knowledge_graph_ambiguities
         (id, project_id, graph_snapshot_id, ambiguity_kind, severity, detail_json, created_at)
         VALUES (?, 'project_1', ?, ?, ?, '{}', 'now')`,
      ).run(id, snapshot, kind, severity);
    expect(() => insertAmbiguity('a_bad_kind', 'made_up', 'info', 'snapshot_1')).toThrow(/CHECK/);
    expect(() => insertAmbiguity('a_bad_severity', 'provenance_missing', 'loud', 'snapshot_1')).toThrow(/CHECK/);
    expect(() => insertAmbiguity('a_orphan', 'provenance_missing', 'info', 'snapshot_missing')).toThrow(/FOREIGN KEY/);
    insertAmbiguity('a1', 'provenance_missing', 'info', 'snapshot_1');
    insertAmbiguity('a_live', 'multiple_candidate_targets', 'review', null);
    expect(() =>
      db.prepare(
        `INSERT INTO knowledge_graph_reports (id, project_id, graph_snapshot_id, report_json, created_at)
         VALUES ('r_bad', 'project_1', NULL, 'not json', 'now')`,
      ).run(),
    ).toThrow(/CHECK/);
    db.prepare(
      `INSERT INTO knowledge_graph_reports (id, project_id, graph_snapshot_id, report_json, created_at)
       VALUES ('r_live', 'project_1', NULL, '{}', 'now'), ('r_snap', 'project_1', 'snapshot_1', '{}', 'now')`,
    ).run();
    db.prepare(`DELETE FROM knowledge_graph_snapshots WHERE id = 'snapshot_1'`).run();
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_graph_ambiguities').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_graph_reports').get()).toEqual({ count: 1 });
    db.prepare(`DELETE FROM knowledge_projects WHERE id = 'project_1'`).run();
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_graph_ambiguities').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_graph_reports').get()).toEqual({ count: 0 });
    db.close();
  });

  it('opens a version-13 database without the tables until migrations run, then upgrades idempotently', () => {
    const directory = mkdtempSync(join(process.cwd(), '.test-knowledge-graph-report-migration-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'state.db');

    const first = openDatabase(databasePath);
    seedProject(first);
    first.exec('DROP TABLE knowledge_graph_ambiguities; DROP TABLE knowledge_graph_reports;');
    first.prepare(`UPDATE schema_meta SET value = '13' WHERE key = 'schema_version'`).run();
    expect(tableNames(first)).not.toContain('knowledge_graph_reports');
    first.close();

    const upgraded = openDatabase(databasePath);
    expect(tableNames(upgraded)).toEqual(expect.arrayContaining(['knowledge_graph_reports', 'knowledge_graph_ambiguities']));
    expect(upgraded.prepare('SELECT COUNT(*) AS count FROM knowledge_graph_reports').get()).toEqual({ count: 0 });
    expect(upgraded.prepare('SELECT COUNT(*) AS count FROM knowledge_graph_snapshots').get()).toEqual({ count: 1 });
    expect(Number((upgraded.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as { value: string }).value)).toBe(16);
    upgraded.close();

    const reopened = openDatabase(databasePath);
    applyKnowledgeGraphReportMigration(reopened);
    applyKnowledgeMigrations(reopened);
    expect(tableNames(reopened).filter((name) => name === 'knowledge_graph_reports')).toHaveLength(1);
    reopened.close();
  });
});

describe('knowledge freshness migration (global version 15, knowledge revision 11)', () => {
  function seedSource(db: Database.Database): void {
    db.prepare(
      `INSERT INTO knowledge_projects (id, workspace_root, name, status, created_at, updated_at)
       VALUES ('project_1', 'workspace', 'Wiki', 'active', 'now', 'now')`,
    ).run();
    db.prepare(
      `INSERT INTO knowledge_sources (id, project_id, source_kind, source_path, current_hash, status, created_at, updated_at)
       VALUES ('source_1', 'project_1', 'file', 'a.md', 'h', 'active', 'now', 'now')`,
    ).run();
    db.prepare(
      `INSERT INTO knowledge_source_versions
       (id, project_id, source_id, version_number, content_hash, content_path, byte_length, created_at)
       VALUES ('version_1', 'project_1', 'source_1', 1, 'h', 'a.md', 1, 'now')`,
    ).run();
  }

  it('registers version 15 after the graph report migration', () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 15);
    expect(migration?.description).toMatch(/freshness/i);
    expect(MIGRATIONS.map((entry) => entry.version).filter((version) => version >= 14)).toEqual([14, 15, 16]);
    expect(KNOWLEDGE_SCHEMA_VERSION).toBe(12);
  });

  it('creates both host-local tables with the specified columns and cascades', () => {
    const db = openDatabase(':memory:');
    expect(columns(db, 'knowledge_source_freshness')).toEqual([
      'id', 'project_id', 'source_id', 'freshness_state', 'current_source_version_id', 'last_observed_hash',
      'last_scan_at', 'last_event_kind', 'last_event_at', 'last_enqueued_job_id', 'last_error_code',
      'last_error_message', 'created_at', 'updated_at',
    ]);
    expect(columns(db, 'knowledge_project_watchers')).toEqual([
      'project_id', 'watcher_status', 'generation', 'last_scan_at', 'last_successful_scan_at', 'last_event_at',
      'last_restart_at', 'consecutive_error_count', 'last_error_code', 'last_error_message', 'updated_at',
    ]);
    seedSource(db);
    const insertFreshness = (id: string, state: string, sourceId = 'source_1', versionId: string | null = 'version_1') =>
      db.prepare(
        `INSERT INTO knowledge_source_freshness
         (id, project_id, source_id, freshness_state, current_source_version_id, created_at, updated_at)
         VALUES (?, 'project_1', ?, ?, ?, 'now', 'now')`,
      ).run(id, sourceId, state, versionId);
    expect(() => insertFreshness('f_bad', 'sparkly')).toThrow(/CHECK/);
    expect(() => insertFreshness('f_orphan', 'fresh', 'source_missing', null)).toThrow(/FOREIGN KEY/);
    insertFreshness('f1', 'pending');
    expect(() => insertFreshness('f2', 'fresh')).toThrow(/UNIQUE/);
    expect(() =>
      db.prepare(
        `INSERT INTO knowledge_project_watchers (project_id, watcher_status, generation, consecutive_error_count, updated_at)
         VALUES ('project_1', 'melting', 0, 0, 'now')`,
      ).run(),
    ).toThrow(/CHECK/);
    db.prepare(
      `INSERT INTO knowledge_project_watchers (project_id, watcher_status, generation, consecutive_error_count, updated_at)
       VALUES ('project_1', 'idle', 0, 0, 'now')`,
    ).run();
    db.prepare(`DELETE FROM knowledge_projects WHERE id = 'project_1'`).run();
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_source_freshness').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM knowledge_project_watchers').get()).toEqual({ count: 0 });
    db.close();
  });

  it('opens a version-14 database without the tables, upgrades, and reopens idempotently', () => {
    const directory = mkdtempSync(join(process.cwd(), '.test-knowledge-freshness-migration-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'state.db');

    const first = openDatabase(databasePath);
    seedSource(first);
    first.exec('DROP TABLE knowledge_source_freshness; DROP TABLE knowledge_project_watchers;');
    first.prepare(`UPDATE schema_meta SET value = '14' WHERE key = 'schema_version'`).run();
    expect(tableNames(first)).not.toContain('knowledge_source_freshness');
    first.close();

    const upgraded = openDatabase(databasePath);
    expect(tableNames(upgraded)).toEqual(
      expect.arrayContaining(['knowledge_source_freshness', 'knowledge_project_watchers']),
    );
    expect(upgraded.prepare('SELECT COUNT(*) AS count FROM knowledge_sources').get()).toEqual({ count: 1 });
    expect(Number((upgraded.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as { value: string }).value)).toBe(16);
    upgraded.close();

    const reopened = openDatabase(databasePath);
    applyKnowledgeFreshnessMigration(reopened);
    applyKnowledgeMigrations(reopened);
    expect(tableNames(reopened).filter((name) => name === 'knowledge_source_freshness')).toHaveLength(1);
    reopened.close();
  });
});

describe('knowledge local semantic migration (global version 16, knowledge revision 12)', () => {
  function seedVersion(db: Database.Database, projectId = 'project_1', sourceId = 'source_1', versionId = 'version_1'): void {
    db.prepare(
      `INSERT OR IGNORE INTO knowledge_projects (id, workspace_root, name, status, created_at, updated_at)
       VALUES (?, ?, 'Wiki', 'active', 'now', 'now')`,
    ).run(projectId, `workspace-${projectId}`);
    db.prepare(
      `INSERT INTO knowledge_sources (id, project_id, source_kind, source_path, current_hash, status, created_at, updated_at)
       VALUES (?, ?, 'file', 'a.md', 'h', 'active', 'now', 'now')`,
    ).run(sourceId, projectId);
    db.prepare(
      `INSERT INTO knowledge_source_versions
       (id, project_id, source_id, version_number, content_hash, content_path, byte_length, created_at)
       VALUES (?, ?, ?, 1, 'h', 'a.md', 1, 'now')`,
    ).run(versionId, projectId, sourceId);
  }

  function insertModel(db: Database.Database, id: string, status: string, projectId = 'project_1') {
    return db
      .prepare(
        `INSERT INTO knowledge_search_semantic_models
         (id, project_id, model_version, status, source_count, created_at, updated_at)
         VALUES (?, ?, 1, ?, 0, 'now', 'now')`,
      )
      .run(id, projectId, status);
  }

  it('registers version 16 after the freshness migration and bumps the knowledge revision', () => {
    const migration = MIGRATIONS.find((entry) => entry.version === 16);
    expect(migration?.description).toMatch(/semantic/i);
    expect(MIGRATIONS.map((entry) => entry.version).filter((version) => version >= 15)).toEqual([15, 16]);
    expect(KNOWLEDGE_SCHEMA_VERSION).toBe(12);
  });

  it('creates the three derived tables with the specified columns, checks, and partial unique indexes', () => {
    const db = openDatabase(':memory:');
    expect(columns(db, 'knowledge_search_semantic_models')).toEqual([
      'id', 'project_id', 'model_version', 'status', 'source_count', 'built_at', 'lease_expires_at', 'created_at', 'updated_at',
    ]);
    expect(columns(db, 'knowledge_search_semantic_vectors')).toEqual([
      'id', 'project_id', 'model_id', 'source_version_id', 'vector_json', 'norm', 'created_at',
    ]);
    expect(columns(db, 'knowledge_search_semantic_neighbors')).toEqual([
      'id', 'project_id', 'model_id', 'term', 'neighbor_term', 'neighbor_rank', 'weight',
    ]);
    expect(indexNames(db)).toEqual(
      expect.arrayContaining([
        'idx_semantic_models_one_active',
        'idx_semantic_models_one_building',
        'idx_semantic_neighbors_term',
      ]),
    );
    seedVersion(db);
    expect(() => insertModel(db, 'm_bad', 'sparkly')).toThrow(/CHECK/);
    insertModel(db, 'm_active', 'active');
    expect(() => insertModel(db, 'm_active_2', 'active')).toThrow(/UNIQUE/);
    insertModel(db, 'm_stale_1', 'stale');
    insertModel(db, 'm_stale_2', 'stale');
    insertModel(db, 'm_building', 'building');
    expect(() => insertModel(db, 'm_building_2', 'building')).toThrow(/UNIQUE/);
    db.close();
  });

  it('cascades vectors and neighbors from models, source versions, and projects', () => {
    const db = openDatabase(':memory:');
    seedVersion(db);
    seedVersion(db, 'project_2', 'source_2', 'version_2');
    insertModel(db, 'm1', 'active');
    insertModel(db, 'm2', 'active', 'project_2');
    const vector = (id: string, projectId: string, modelId: string, versionId: string) =>
      db
        .prepare(
          `INSERT INTO knowledge_search_semantic_vectors
           (id, project_id, model_id, source_version_id, vector_json, norm, created_at)
           VALUES (?, ?, ?, ?, '[1]', 1, 'now')`,
        )
        .run(id, projectId, modelId, versionId);
    const neighbor = (id: string, projectId: string, modelId: string) =>
      db
        .prepare(
          `INSERT INTO knowledge_search_semantic_neighbors
           (id, project_id, model_id, term, neighbor_term, neighbor_rank, weight)
           VALUES (?, ?, ?, 'a', 'b', 0, 0.5)`,
        )
        .run(id, projectId, modelId);
    vector('v1', 'project_1', 'm1', 'version_1');
    vector('v2', 'project_2', 'm2', 'version_2');
    neighbor('n1', 'project_1', 'm1');
    neighbor('n2', 'project_2', 'm2');
    expect(() => vector('v_cross', 'project_1', 'm1', 'version_2')).toThrow(/FOREIGN KEY/);
    expect(() => vector('v_dup', 'project_1', 'm1', 'version_1')).toThrow(/UNIQUE/);

    db.prepare(`DELETE FROM knowledge_source_versions WHERE id = 'version_1'`).run();
    expect(db.prepare('SELECT id FROM knowledge_search_semantic_vectors').all()).toEqual([{ id: 'v2' }]);
    db.prepare(`DELETE FROM knowledge_search_semantic_models WHERE id = 'm1'`).run();
    expect(db.prepare('SELECT id FROM knowledge_search_semantic_neighbors').all()).toEqual([{ id: 'n2' }]);
    db.prepare(`DELETE FROM knowledge_projects WHERE id = 'project_2'`).run();
    for (const table of ['models', 'vectors', 'neighbors']) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM knowledge_search_semantic_${table}`).get()).toEqual({ count: 0 });
    }
    db.close();
  });

  it('opens a version-15 database without the tables, upgrades, and reopens idempotently', () => {
    const directory = mkdtempSync(join(process.cwd(), '.test-knowledge-semantic-migration-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'state.db');

    const first = openDatabase(databasePath);
    seedVersion(first);
    first.exec(
      'DROP TABLE knowledge_search_semantic_neighbors; DROP TABLE knowledge_search_semantic_vectors; DROP TABLE knowledge_search_semantic_models;',
    );
    first.prepare(`UPDATE schema_meta SET value = '15' WHERE key = 'schema_version'`).run();
    first.close();

    const upgraded = openDatabase(databasePath);
    expect(tableNames(upgraded)).toEqual(
      expect.arrayContaining([
        'knowledge_search_semantic_models',
        'knowledge_search_semantic_vectors',
        'knowledge_search_semantic_neighbors',
      ]),
    );
    expect(upgraded.prepare('SELECT COUNT(*) AS count FROM knowledge_sources').get()).toEqual({ count: 1 });
    expect(Number((upgraded.prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`).get() as { value: string }).value)).toBe(16);
    upgraded.close();

    const reopened = openDatabase(databasePath);
    applyKnowledgeSemanticMigration(reopened);
    applyKnowledgeMigrations(reopened);
    expect(tableNames(reopened).filter((name) => name === 'knowledge_search_semantic_models')).toHaveLength(1);
    reopened.close();
  });
});
