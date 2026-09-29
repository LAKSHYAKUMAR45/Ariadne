import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../../src/db.js';
import {
  applyKnowledgeMigrations,
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
    expect(KNOWLEDGE_SCHEMA_VERSION).toBe(7);
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
