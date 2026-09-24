import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { applyKnowledgeMigrations } from '../../src/knowledge/knowledgeMigrations.js';
import {
  KnowledgeProvenance,
  type RecordKnowledgeProvenanceInput,
} from '../../src/knowledge/KnowledgeProvenance.js';
import { SCHEMA_SQL } from '../../src/schema.js';

const CREATED_AT = '2026-09-24T00:00:00.000Z';

function createDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  applyKnowledgeMigrations(db);
  db.prepare(
    `INSERT INTO knowledge_projects (id, workspace_root, name, created_at, updated_at)
     VALUES ('project-1', '/workspace', 'Workspace', ?, ?)`,
  ).run(CREATED_AT, CREATED_AT);
  db.prepare(
    `INSERT INTO knowledge_pages (id, project_id, page_type, title, slug, created_at, updated_at)
     VALUES ('page-1', 'project-1', 'concept', 'Architecture', 'architecture', ?, ?)`,
  ).run(CREATED_AT, CREATED_AT);
  db.prepare(
    `INSERT INTO knowledge_page_versions (
      id, project_id, page_id, version_number, content_hash, content_path, created_at
    ) VALUES ('page-version-1', 'project-1', 'page-1', 1, 'hash', 'pages/architecture.md', ?)`,
  ).run(CREATED_AT);

  return db;
}

function provenance(
  kind: RecordKnowledgeProvenanceInput['kind'],
  id: string,
): RecordKnowledgeProvenanceInput {
  return {
    projectId: 'project-1',
    targetId: 'page-version-1',
    kind,
    id,
    confidence: 0.9,
  };
}

describe('KnowledgeProvenance', () => {
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close();
    }
  });

  it('records task, checkpoint, decision, file, commit, source, and page links', () => {
    const db = createDatabase();
    databases.push(db);
    const store = new KnowledgeProvenance(db);

    const references = [
      provenance('task', 'task-1'),
      provenance('checkpoint', 'checkpoint-1'),
      provenance('decision', 'decision-1'),
      provenance('file', 'docs/architecture.md'),
      provenance('commit', 'abc123'),
      provenance('source', 'source-1'),
      provenance('page', 'page-2'),
    ];

    for (const reference of references) {
      store.recordKnowledgeProvenance(reference);
    }

    expect(store.listKnowledgeProvenance('page-version-1')).toEqual(
      references.map(({ projectId: _projectId, targetId: _targetId, ...reference }) => reference),
    );
  });

  it('does not duplicate an existing provenance reference', () => {
    const db = createDatabase();
    databases.push(db);
    const store = new KnowledgeProvenance(db);
    const reference = provenance('file', 'docs/architecture.md');

    store.recordKnowledgeProvenance(reference);
    store.recordKnowledgeProvenance(reference);

    expect(store.listKnowledgeProvenance('page-version-1')).toEqual([
      {
        kind: 'file',
        id: 'docs/architecture.md',
        confidence: 0.9,
      },
    ]);
  });
});
