import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { applyKnowledgeMigrations } from '../../src/knowledge/knowledgeMigrations.js';
import { KnowledgeOperationLog } from '../../src/knowledge/KnowledgeOperationLog.js';
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

  return db;
}

describe('KnowledgeOperationLog', () => {
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close();
    }
  });

  it('redacts provider secrets before persisting operation details', () => {
    const db = createDatabase();
    databases.push(db);
    const log = new KnowledgeOperationLog(db);

    const event = log.appendKnowledgeOperation({
      projectId: 'project-1',
      operationKind: 'generate-page',
      status: 'success',
      detail: {
        provider: {
          apiKey: 'sk-abcdefghijklmnopqrstuvwxyz123456',
          token: 'do-not-persist',
        },
        request: 'Authorization: token ghp_1234567890abcdefghij1234567890ABCD',
      },
    });

    expect(event.status).toBe('success');
    expect(JSON.stringify(event.detail)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(JSON.stringify(event.detail)).not.toContain('do-not-persist');
    expect(JSON.stringify(event.detail)).not.toContain('ghp_1234567890abcdefghij1234567890ABCD');
    expect(event.detail).toMatchObject({
      provider: {
        apiKey: '***',
        token: '***',
      },
    });

    const persisted = db.prepare(`SELECT detail_json FROM knowledge_operation_log`).get() as { detail_json: string };
    expect(persisted.detail_json).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(persisted.detail_json).not.toContain('do-not-persist');
  });

  it('preserves success, failure, and cancelled statuses when listing events', () => {
    const db = createDatabase();
    databases.push(db);
    const log = new KnowledgeOperationLog(db);

    log.appendKnowledgeOperation({
      projectId: 'project-1',
      operationKind: 'ingest',
      status: 'success',
      detail: { source: 'docs/one.md' },
    });
    log.appendKnowledgeOperation({
      projectId: 'project-1',
      operationKind: 'generate',
      status: 'failure',
      detail: { reason: 'Provider unavailable' },
    });
    log.appendKnowledgeOperation({
      projectId: 'project-1',
      operationKind: 'research',
      status: 'cancelled',
      detail: {},
    });

    expect(log.listKnowledgeOperations('project-1').map((event) => event.status)).toEqual([
      'cancelled',
      'failure',
      'success',
    ]);
    expect(log.listKnowledgeOperations('project-1', { status: 'failure' })).toMatchObject([
      { operationKind: 'generate', status: 'failure' },
    ]);
  });

  it('rejects unsupported operation statuses before persisting them', () => {
    const db = createDatabase();
    databases.push(db);
    const log = new KnowledgeOperationLog(db);

    expect(() =>
      log.appendKnowledgeOperation({
        projectId: 'project-1',
        operationKind: 'ingest',
        status: 'running' as 'success',
        detail: {},
      }),
    ).toThrow('Unsupported knowledge operation status: running');
    expect(db.prepare(`SELECT COUNT(*) AS count FROM knowledge_operation_log`).get()).toEqual({ count: 0 });
  });
});
