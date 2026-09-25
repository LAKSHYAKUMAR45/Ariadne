import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db.js';
import {
  KnowledgeExtractionStore,
  offsetToPosition,
  validateDeterministicExtraction,
} from '../../src/knowledge/KnowledgeExtractionStore.js';
import type { DeterministicExtraction } from '../../src/knowledge/KnowledgeExtraction.js';
import { applyKnowledgeMigrations } from '../../src/knowledge/knowledgeMigrations.js';
import { KnowledgeSourceStore } from '../../src/knowledge/KnowledgeSourceStore.js';

const PROJECT_ID = 'project_1';
const CREATED_AT = '2026-09-24T00:00:00.000Z';

function createKnowledgeDatabase(): Database.Database {
  const db = openDatabase(':memory:');
  applyKnowledgeMigrations(db);
  db.prepare(
    `INSERT INTO knowledge_projects
     (id, workspace_root, name, status, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?)`,
  ).run(PROJECT_ID, '/workspace', 'Test', CREATED_AT, CREATED_AT);
  return db;
}

function baseExtraction(sourceVersionId: string): DeterministicExtraction {
  return {
    analyzerId: 'python-lezer',
    analyzerVersion: '1',
    sourceVersionId,
    title: 'jcnr_device.py',
    summary: 'Python module with one class.',
    sections: [
      {
        id: 'section:1',
        kind: 'code',
        title: 'JCNRDevice',
        text: 'class JCNRDevice:',
        span: {
          startOffset: 0,
          endOffset: 17,
          startLine: 1,
          startColumn: 1,
          endLine: 1,
          endColumn: 18,
        },
      },
    ],
    symbols: [],
    relationships: [],
    links: [],
    diagnostics: [],
  };
}

describe('validateDeterministicExtraction', () => {
  it('converts offsets to one-based line and column positions', () => {
    expect(offsetToPosition('alpha\nbeta', 0)).toEqual({ offset: 0, line: 1, column: 1 });
    expect(offsetToPosition('alpha\nbeta', 6)).toEqual({ offset: 6, line: 2, column: 1 });
    expect(offsetToPosition('alpha\nbeta', 10)).toEqual({ offset: 10, line: 2, column: 5 });
  });

  it('rejects invalid offsets, duplicate IDs, missing source IDs, and unknown relationship endpoints', () => {
    expect(() =>
      validateDeterministicExtraction({
        ...baseExtraction('source-version-1'),
        sections: [
          {
            ...baseExtraction('source-version-1').sections[0],
            span: {
              ...baseExtraction('source-version-1').sections[0].span,
              startOffset: 5,
              endOffset: 4,
            },
          },
        ],
      }),
    ).toThrow(/offset/i);

    expect(() =>
      validateDeterministicExtraction({
        ...baseExtraction('source-version-1'),
        sections: [
          baseExtraction('source-version-1').sections[0],
          { ...baseExtraction('source-version-1').sections[0] },
        ],
      }),
    ).toThrow(/duplicate/i);

    expect(() =>
      validateDeterministicExtraction({
        ...baseExtraction(''),
        sourceVersionId: '   ',
      }),
    ).toThrow(/source version/i);

    expect(() =>
      validateDeterministicExtraction({
        ...baseExtraction('source-version-1'),
        relationships: [
          {
            id: 'relationship:1',
            type: 'contains',
            fromId: 'section:1',
            toId: 'symbol:missing',
          },
        ],
      }),
    ).toThrow(/relationship/i);
  });
});

describe('KnowledgeExtractionStore', () => {
  let db: Database.Database;
  let sourceStore: KnowledgeSourceStore;
  let extractionStore: KnowledgeExtractionStore;
  let sourceVersionId: string;

  beforeEach(() => {
    db = createKnowledgeDatabase();
    sourceStore = new KnowledgeSourceStore(db);
    extractionStore = new KnowledgeExtractionStore(db);
    const source = sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path: 'Libs/TaskManagers/JCNR/jcnr_device.py',
      content: 'class JCNRDevice:\n    pass\n',
      mimeType: 'text/x-python',
    });
    sourceVersionId = sourceStore.listVersions(PROJECT_ID, source.id)[0].id;
  });

  it('saves deterministic extractions, reuses identical records, updates changed results, and persists sanitized diagnostics', () => {
    const extraction = validateDeterministicExtraction({
      ...baseExtraction(sourceVersionId),
      diagnostics: [
        {
          code: 'parser-warning',
          message: 'Recovered from indentation error.',
          severity: 'warning',
          span: {
            startOffset: 0,
            endOffset: 17,
            startLine: 1,
            startColumn: 1,
            endLine: 1,
            endColumn: 18,
          },
          sourceContent: 'SECRET=1',
        },
      ],
    });

    const first = extractionStore.save({ projectId: PROJECT_ID, extraction });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM knowledge_source_spans`).get()).toEqual({ count: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM knowledge_extractions`).get()).toEqual({ count: 1 });
    expect(first.sections).toHaveLength(1);
    expect(first.sections[0].span.id).toBeTruthy();
    expect(extractionStore.getCurrent(PROJECT_ID, sourceVersionId, 'python-lezer', '1')).toMatchObject({
      id: first.id,
      extractionHash: first.extractionHash,
      extraction: {
        title: 'jcnr_device.py',
      },
    });
    expect(extractionStore.listSections(PROJECT_ID, sourceVersionId)).toEqual([
      expect.objectContaining({
        extractionId: first.id,
        id: 'section:1',
        title: 'JCNRDevice',
        text: 'class JCNRDevice:',
      }),
    ]);

    const identical = extractionStore.save({ projectId: PROJECT_ID, extraction });
    expect(identical.id).toBe(first.id);
    expect(identical.extractionHash).toBe(first.extractionHash);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM knowledge_source_spans`).get()).toEqual({ count: 1 });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM knowledge_extractions`).get()).toEqual({ count: 1 });

    const changed = extractionStore.save({
      projectId: PROJECT_ID,
      extraction: {
        ...extraction,
        summary: 'Python module with one class and constructor.',
        sections: [
          {
            ...extraction.sections[0],
            text: 'class JCNRDevice:\n    def __init__(self): ...',
          },
        ],
      },
    });
    expect(changed.id).toBe(first.id);
    expect(changed.extractionHash).not.toBe(first.extractionHash);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM knowledge_extractions`).get()).toEqual({ count: 1 });
    expect(extractionStore.getCurrent(PROJECT_ID, sourceVersionId, 'python-lezer', '1')?.extraction.summary).toBe(
      'Python module with one class and constructor.',
    );

    const row = db
      .prepare(
        `SELECT diagnostics_json, result_json
         FROM knowledge_extractions
         WHERE project_id = ? AND source_version_id = ?`,
      )
      .get(PROJECT_ID, sourceVersionId) as { diagnostics_json: string; result_json: string };
    expect(row.result_json).toContain('constructor');
    expect(row.diagnostics_json).not.toContain('SECRET=1');
  });
});
