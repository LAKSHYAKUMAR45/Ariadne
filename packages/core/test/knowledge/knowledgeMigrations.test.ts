import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db.js';
import { applyKnowledgeMigrations, KNOWLEDGE_SCHEMA_VERSION } from '../../src/knowledge/knowledgeMigrations.js';
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
  'idx_knowledge_reviews_project_status',
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
    expect(KNOWLEDGE_SCHEMA_VERSION).toBe(2);
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
    expect(columns(db, 'knowledge_jobs')).toContain('result_json');

    db.close();
  });

  it('registers knowledge migrations with the shared database initializer and is safe to reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ariadne-knowledge-migrations-'));
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
});
