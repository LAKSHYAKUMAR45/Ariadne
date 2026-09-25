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
const GITHUB_TOKEN = 'ghp_1234567890abcdefghij1234567890ABCD';
const OPENAI_KEY = 'sk-abcdefghijklmnopqrstuvwx1234567890';

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

  it('rejects an empty summary when extracted source content is present', () => {
    expect(() =>
      validateDeterministicExtraction({
        ...baseExtraction('source-version-1'),
        summary: '',
      }),
    ).toThrow(/summary must be a non-empty string/i);
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

  it('saves deterministic extractions, redacts persisted secrets without dropping structure, reuses identical records, and updates changed results', () => {
    const extraction = validateDeterministicExtraction({
      ...baseExtraction(sourceVersionId),
      sections: [
        {
          ...baseExtraction(sourceVersionId).sections[0],
          text: `class JCNRDevice:\n    token = "${GITHUB_TOKEN}"`,
        },
      ],
      diagnostics: [
        {
          code: 'parser-warning',
          message: `Recovered from indentation error after seeing OPENAI_API_KEY=${OPENAI_KEY}.`,
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
    expect(first.extraction.sections[0].id).toBe('section:1');
    expect(first.extraction.sections[0].span).toMatchObject({
      startOffset: 0,
      endOffset: 17,
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 18,
    });
    expect(first.extraction.sections[0].text).toContain('***');
    expect(first.extraction.sections[0].text).not.toContain(GITHUB_TOKEN);
    expect(first.diagnostics[0]?.message).toContain('***');
    expect(first.diagnostics[0]?.message).not.toContain(OPENAI_KEY);
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
        text: `class JCNRDevice:\n    token = ***`,
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
    expect(row.result_json).toContain('"id":"section:1"');
    expect(row.result_json).toContain('"startLine":1');
    expect(row.result_json).not.toContain(GITHUB_TOKEN);
    expect(row.diagnostics_json).not.toContain(OPENAI_KEY);
    expect(row.diagnostics_json).not.toContain('SECRET=1');
    expect(row.result_json).toContain('***');
    expect(row.diagnostics_json).toContain('***');
  });

  it('skips legacy migrated rows with null v2 extraction fields when listing sections', () => {
    const saved = extractionStore.save({
      projectId: PROJECT_ID,
      extraction: baseExtraction(sourceVersionId),
    });

    db.prepare(
      `INSERT INTO knowledge_extractions (
         id,
         project_id,
         source_version_id,
         extractor_kind,
         result_path,
         content_hash,
         status,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, 'legacy', 'legacy.json', 'legacy-hash', 'completed', ?, ?)`,
    ).run('legacy-extraction', PROJECT_ID, sourceVersionId, CREATED_AT, CREATED_AT);

    expect(extractionStore.listSections(PROJECT_ID, sourceVersionId)).toEqual([
      expect.objectContaining({
        extractionId: saved.id,
        id: 'section:1',
        title: 'JCNRDevice',
      }),
    ]);
  });

  it('rejects cross-kind analyzer identity collisions for the same project and source version', () => {
    extractionStore.save({
      projectId: PROJECT_ID,
      extractorKind: 'deterministic',
      extraction: baseExtraction(sourceVersionId),
    });

    expect(() =>
      extractionStore.save({
        projectId: PROJECT_ID,
        extractorKind: 'llm',
        extraction: baseExtraction(sourceVersionId),
      }),
    ).toThrow(/analyzer identity collision.*deterministic.*llm/i);
  });

  it('wraps malformed persisted result_json with a contextual KnowledgeExtractionStore error', () => {
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
       ) VALUES (?, ?, ?, 'deterministic', 'python-lezer', '1', 'bad.json', 'hash', 'hash', '{', '[]', 'completed', ?, ?, ?)`,
    ).run('broken-extraction', PROJECT_ID, sourceVersionId, CREATED_AT, CREATED_AT, CREATED_AT);

    expect(() => extractionStore.getCurrent(PROJECT_ID, sourceVersionId, 'python-lezer', '1')).toThrow(
      /KnowledgeExtractionStore could not parse result_json for extraction broken-extraction/,
    );
  });
});
