import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { TaskStore } from '../../src/TaskStore.js';
import { openDatabase } from '../../src/db.js';
import type { DeterministicExtraction } from '../../src/knowledge/KnowledgeExtraction.js';
import { KnowledgeExtractionStore } from '../../src/knowledge/KnowledgeExtractionStore.js';
import { searchWorkspace } from '../../src/Search.js';
import { applyKnowledgeMigrations } from '../../src/knowledge/knowledgeMigrations.js';
import { KnowledgePageStore } from '../../src/knowledge/KnowledgePageStore.js';
import { KnowledgeSourceStore } from '../../src/knowledge/KnowledgeSourceStore.js';
import { KnowledgeSearchIndex } from '../../src/knowledge/KnowledgeSearchIndex.js';
import {
  buildKnowledgeSearchContext,
  lexicalScore,
  searchKnowledge,
  type KnowledgeSearchGraphExpansion,
} from '../../src/knowledge/KnowledgeSearch.js';

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

describe('searchKnowledge', () => {
  let db: Database.Database;
  let taskStore: TaskStore;
  let sourceStore: KnowledgeSourceStore;
  let pageStore: KnowledgePageStore;
  let extractionStore: KnowledgeExtractionStore;

  beforeEach(() => {
    db = createKnowledgeDatabase();
    taskStore = new TaskStore(':memory:');
    sourceStore = new KnowledgeSourceStore(db);
    pageStore = new KnowledgePageStore(db);
    extractionStore = new KnowledgeExtractionStore(db);
  });

  afterEach(() => {
    taskStore.close();
    db.close();
  });

  it('searches active generated knowledge pages and returns source-backed citations', () => {
    const source = sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path: 'docs/auth.md',
      content: 'OAuth token refresh flow',
      format: 'markdown',
    });
    const sourceVersion = sourceStore.listVersions(PROJECT_ID, source.id)[0];
    const page = pageStore.createPageVersion({
      projectId: PROJECT_ID,
      type: 'concept',
      title: 'OAuth token refresh',
      slug: 'oauth-token-refresh',
      content: 'Generated page content',
      summary: 'Explains OAuth refresh token rotation.',
      sourceVersionIds: [sourceVersion.id],
    });
    const spanId = 'span_auth_flow';
    db.prepare(
      `INSERT INTO knowledge_source_spans
       (id, project_id, source_version_id, start_offset, end_offset, label, created_at)
       VALUES (?, ?, ?, 0, 11, 'heading', ?)`,
    ).run(spanId, PROJECT_ID, sourceVersion.id, CREATED_AT);
    db.prepare(
      `INSERT INTO knowledge_page_provenance
       (id, project_id, page_version_id, source_kind, source_id, source_span_id, confidence, created_at)
       VALUES ('prov_auth_flow', ?, ?, 'source', ?, ?, 0.9, ?)`,
    ).run(PROJECT_ID, page.id, source.id, spanId, CREATED_AT);

    const results = searchKnowledge('refresh token', { db, projectId: PROJECT_ID, mode: 'knowledge' });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      mode: 'knowledge',
      kind: 'page',
      id: page.pageId,
      title: 'OAuth token refresh',
    });
    expect(results[0].citations).toEqual([
      {
        pageId: page.pageId,
        sourceId: source.id,
        path: 'docs/auth.md',
        url: null,
        span: { id: spanId, startOffset: 0, endOffset: 11, label: 'heading' },
      },
    ]);
  });

  it('searches source records without returning generated pages in read-sources-only mode', () => {
    const source = sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path: 'docs/secrets-policy.md',
      content: 'Secret redaction policy',
      format: 'markdown',
    });
    const version = sourceStore.listVersions(PROJECT_ID, source.id)[0];
    pageStore.createPageVersion({
      projectId: PROJECT_ID,
      type: 'source',
      title: 'Generated secrets policy',
      slug: 'generated-secrets-policy',
      content: 'Generated source page',
      summary: 'Generated summary mentioning secrets policy.',
      sourceVersionIds: [version.id],
    });

    const results = searchKnowledge('secrets policy', { db, projectId: PROJECT_ID, mode: 'read-sources-only' });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      mode: 'read-sources-only',
      kind: 'source',
      id: source.id,
      title: 'docs/secrets-policy.md',
    });
    expect(results[0].citations).toEqual([
      {
        pageId: null,
        sourceId: source.id,
        path: 'docs/secrets-policy.md',
        url: null,
        span: null,
      },
    ]);
  });

  it('supports task-only and hybrid search without changing searchWorkspace semantics', () => {
    const task = taskStore.createTask({ title: 'Fix retry backoff', goal: 'Retry failed sync jobs' });
    taskStore.createTodo({ taskId: task.id, text: 'Tune retry jitter' });
    sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path: 'docs/retry.md',
      content: 'Retry design',
      format: 'markdown',
    });

    const taskOnly = searchKnowledge('retry', { db, projectId: PROJECT_ID, taskStore, mode: 'tasks' });
    const hybrid = searchKnowledge('retry', { db, projectId: PROJECT_ID, taskStore, mode: 'hybrid' });

    expect(taskOnly.map((result) => result.kind)).toEqual(['task']);
    expect(hybrid.map((result) => result.kind).sort()).toEqual(['source', 'task']);
    expect(searchWorkspace(taskStore, 'retry')[0].matches.map((match) => match.category).sort()).toEqual([
      'goal',
      'title',
      'todo',
    ]);
  });

  it('redacts task-mode titles and snippets before returning task-backed search results', () => {
    const task = taskStore.createTask({
      title: 'Rotate ghp_abcdefghijklmnopqrstuvwxyz0123456789 token',
      goal: 'Remove leaked token',
    });
    taskStore.createTodo({
      taskId: task.id,
      text: 'Replace ghp_abcdefghijklmnopqrstuvwxyz0123456789 in rollout notes',
    });

    const results = searchKnowledge('ghp_abcdefghijklmnopqrstuvwxyz0123456789', {
      db,
      projectId: PROJECT_ID,
      taskStore,
      mode: 'tasks',
    });

    expect(results).toEqual([
      expect.objectContaining({
        kind: 'task',
        title: expect.not.stringContaining('ghp_abcdefghijklmnopqrstuvwxyz0123456789'),
        snippet: expect.not.stringContaining('ghp_abcdefghijklmnopqrstuvwxyz0123456789'),
        taskResult: expect.objectContaining({
          taskTitle: expect.not.stringContaining('ghp_abcdefghijklmnopqrstuvwxyz0123456789'),
          matches: expect.arrayContaining([
            expect.objectContaining({
              text: expect.not.stringContaining('ghp_abcdefghijklmnopqrstuvwxyz0123456789'),
            }),
          ]),
        }),
      }),
    ]);
  });

  it('ranks lexically relevant results ahead of weaker matches and deduplicates page/source pairs', () => {
    const strong = sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path: 'docs/auth-refresh-token.md',
      content: 'refresh token',
    });
    const weak = sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path: 'docs/token.md',
      content: 'token',
    });
    pageStore.createPageVersion({
      projectId: PROJECT_ID,
      type: 'concept',
      title: 'Refresh token refresh token',
      slug: 'refresh-token',
      content: 'Generated',
      summary: 'refresh token rotation',
      sourceVersionIds: [sourceStore.listVersions(PROJECT_ID, strong.id)[0].id],
    });
    pageStore.createPageVersion({
      projectId: PROJECT_ID,
      type: 'concept',
      title: 'Token',
      slug: 'token',
      content: 'Generated',
      summary: 'token only',
      sourceVersionIds: [sourceStore.listVersions(PROJECT_ID, weak.id)[0].id],
    });

    const results = searchKnowledge('refresh token', { db, projectId: PROJECT_ID, mode: 'hybrid' });

    expect(results[0].title).toBe('Refresh token refresh token');
    const ids = results.map((result) => result.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('matches inflected query terms against identifier-style source text without stopword inflation', () => {
    const relevant = lexicalScore('What is deleting configlets?', [
      { text: 'delete_configlet cleanup', weight: 8 },
    ]);
    const noisy = lexicalScore('What is deleting configlets?', [
      { text: 'what is the behavior when a test run is complete', weight: 8 },
    ]);

    expect(relevant).toBeGreaterThan(noisy);
    expect(lexicalScore('design', [{ text: 'descriptive metadata', weight: 1 }])).toBe(0);
    expect(lexicalScore('allocated routing', [{ text: 'allocate_route', weight: 1 }])).toBeGreaterThanOrEqual(2);
    expect(lexicalScore('task-manager', [{ text: 'TaskManager', weight: 1 }])).toBeGreaterThan(0);
    expect(lexicalScore('use case', [{ text: 'CloudRouterUsecase', weight: 1 }])).toBeGreaterThan(0);
  });

  it('ignores stale pages, handles empty and Unicode queries, and tolerates missing source rows', () => {
    const active = pageStore.createPageVersion({
      projectId: PROJECT_ID,
      type: 'concept',
      title: 'Unicode café runbook',
      slug: 'unicode-cafe',
      content: 'Generated',
      summary: 'Handles café imports.',
    });
    const stale = pageStore.createPageVersion({
      projectId: PROJECT_ID,
      type: 'concept',
      title: 'Stale café runbook',
      slug: 'stale-cafe',
      content: 'Generated',
      summary: 'Stale café summary.',
    });
    pageStore.markPageStale(PROJECT_ID, stale.pageId);

    expect(searchKnowledge('   ', { db, projectId: PROJECT_ID, mode: 'hybrid', taskStore })).toEqual([]);
    const results = searchKnowledge('CAFÉ', { db, projectId: PROJECT_ID, mode: 'knowledge' });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(active.pageId);
    expect(results[0].citations).toEqual([]);
  });

  it('applies token budgets and bounded graph expansion hooks during context assembly', () => {
    const source = sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path: 'docs/graph.md',
      content: 'Graph expansion budget',
    });

    const page = pageStore.createPageVersion({
      projectId: PROJECT_ID,
      type: 'architecture',
      title: 'Graph expansion budget',
      slug: 'graph-expansion-budget',
      content: 'Generated',
      summary: 'Graph expansion should stay bounded by token budget.',
      sourceVersionIds: [sourceStore.listVersions(PROJECT_ID, source.id)[0].id],
    });
    const expansions: KnowledgeSearchGraphExpansion[] = [
      { id: 'neighbor-1', title: 'Useful neighbor', text: 'short graph note', tokens: 4 },
      { id: 'neighbor-2', title: 'Too large neighbor', text: 'x'.repeat(200), tokens: 50 },
    ];

    const results = searchKnowledge('graph budget', {
      db,
      projectId: PROJECT_ID,
      mode: 'knowledge',
      graphExpansion: () => expansions,
      maxGraphExpansions: 1,
    });
    const context = buildKnowledgeSearchContext(results, { tokenBudget: 100 });

    expect(results[0].graphExpansions).toEqual([expansions[0]]);
    expect(context.results).toHaveLength(1);
    expect(context.results[0].id).toBe(page.pageId);
    expect(context.results[0].graphExpansions).toEqual([expansions[0]]);
    expect(context.truncated.results).toBeUndefined();
    expect(context.truncated.graphExpansions).toBeUndefined();
  });


  it('redacts graph expansion text before returning or budgeting it', () => {
    const source = sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path: 'docs/graph-secrets.md',
      content: 'Graph expansion secrets',
    });
    pageStore.createPageVersion({
      projectId: PROJECT_ID,
      type: 'architecture',
      title: 'Graph expansion secrets',
      slug: 'graph-expansion-secrets',
      content: 'Generated',
      summary: 'Graph expansion should redact secrets.',
      sourceVersionIds: [sourceStore.listVersions(PROJECT_ID, source.id)[0].id],
    });

    const results = searchKnowledge('graph expansion secrets', {
      db,
      projectId: PROJECT_ID,
      mode: 'knowledge',
      graphExpansion: () => [
        {
          id: 'neighbor-secret',
          title: 'Deploy ghp_abcdefghijklmnopqrstuvwxyz0123456789',
          text: 'password=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
        },
      ],
    });
    const context = buildKnowledgeSearchContext(results, { tokenBudget: 200 });

    expect(results[0]?.graphExpansions).toEqual([
      expect.objectContaining({
        title: expect.not.stringContaining('ghp_abcdefghijklmnopqrstuvwxyz0123456789'),
        text: expect.not.stringContaining('ghp_abcdefghijklmnopqrstuvwxyz0123456789'),
      }),
    ]);
    expect(JSON.stringify(context)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('reports budget truncation when results do not fit', () => {
    sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path: 'docs/very-long-knowledge.md',
      content: 'Long knowledge',
    });

    const results = searchKnowledge('knowledge', { db, projectId: PROJECT_ID, mode: 'sources' });
    const context = buildKnowledgeSearchContext(results, { tokenBudget: 1 });

    expect(context.results).toEqual([]);
    expect(context.truncated.results).toBe(1);
  });

  it('counts citation text against the context token budget', () => {
    const source = sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path: 'docs/'.padEnd(180, 'a') + '.md',
      content: 'Budgeted citation',
    });
    const version = sourceStore.listVersions(PROJECT_ID, source.id)[0];
    pageStore.createPageVersion({
      projectId: PROJECT_ID,
      type: 'concept',
      title: 'Citation budget',
      slug: 'citation-budget',
      content: 'Generated',
      summary: 'Tiny',
      sourceVersionIds: [version.id],
    });

    const results = searchKnowledge('citation budget', { db, projectId: PROJECT_ID, mode: 'knowledge' });
    const context = buildKnowledgeSearchContext(results, { tokenBudget: 10 });

    expect(context.results).toEqual([]);
    expect(context.truncated.results).toBe(1);
  });

  it('redacts page titles, summaries, and content metadata before returning knowledge-mode results', () => {
    const page = pageStore.createPageVersion({
      projectId: PROJECT_ID,
      type: 'concept',
      title: 'Secret policy ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      slug: 'secret-policy-ghp-abcdefghijklmnopqrstuvwxyz0123456789',
      content: 'Generated',
      contentPath: 'pages/concept/secret-policy-ghp_abcdefghijklmnopqrstuvwxyz0123456789.md',
      summary: 'password=hunter2 rotation policy',
    });

    const results = searchKnowledge('secret policy', { db, projectId: PROJECT_ID, mode: 'knowledge' });

    expect(results[0]).toMatchObject({
      id: page.pageId,
      title: expect.not.stringContaining('ghp_abcdefghijklmnopqrstuvwxyz0123456789'),
      snippet: expect.stringContaining('password=***'),
      metadata: expect.objectContaining({
        contentPath: expect.not.stringContaining('ghp_abcdefghijklmnopqrstuvwxyz0123456789'),
      }),
    });
  });

  it('ranks extraction-backed symbol and section matches ahead of path-only metadata, with bounded snippets and exact span coordinates', () => {
    const source = sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path: 'src/security_group_index.py',
      content: 'def allocate_index_for_sg(security_group):\n    return security_group.index\n',
      format: 'python',
      mimeType: 'text/x-python',
    });
    const sourceVersionId = sourceStore.listVersions(PROJECT_ID, source.id)[0].id;
    const extraction: DeterministicExtraction = {
      analyzerId: 'python-lezer',
      analyzerVersion: '1',
      sourceVersionId,
      title: 'src/security_group_index.py',
      summary: 'Allocates security group indexes.',
      sections: [
        {
          id: 'section:function',
          kind: 'code',
          title: 'allocate_index_for_sg',
          text: 'def allocate_index_for_sg(security_group):\n    return security_group.index\n'.repeat(4),
          span: {
            startOffset: 0,
            endOffset: 74,
            startLine: 1,
            startColumn: 1,
            endLine: 2,
            endColumn: 32,
          },
          confidence: 1,
        },
      ],
      symbols: [
        {
          id: 'symbol:allocate',
          kind: 'function',
          name: 'allocate_index_for_sg',
          qualifiedName: 'contrail.security.allocate_index_for_sg',
          span: {
            startOffset: 4,
            endOffset: 25,
            startLine: 1,
            startColumn: 5,
            endLine: 1,
            endColumn: 26,
          },
          confidence: 1,
        },
      ],
      relationships: [],
      links: [],
      diagnostics: [],
    };
    extractionStore.save({ projectId: PROJECT_ID, extraction });

    sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path: 'docs/security-group-index-notes.md',
      content: 'metadata only',
      format: 'markdown',
    });
    db.prepare(
      `INSERT INTO knowledge_projects
       (id, workspace_root, name, status, created_at, updated_at)
       VALUES ('project_2', '/workspace/other', 'Other', 'active', ?, ?)`,
    ).run(CREATED_AT, CREATED_AT);
    const otherSourceStore = new KnowledgeSourceStore(db);
    const otherExtractionStore = new KnowledgeExtractionStore(db);
    const otherSource = otherSourceStore.register({
      projectId: 'project_2',
      kind: 'file',
      path: 'src/security_group_index.py',
      content: 'def allocate_index_for_sg(other):\n    return other\n',
      format: 'python',
      mimeType: 'text/x-python',
    });
    otherExtractionStore.save({
      projectId: 'project_2',
      extraction: {
        ...extraction,
        sourceVersionId: otherSourceStore.listVersions('project_2', otherSource.id)[0].id,
      },
    });

    const results = searchKnowledge('allocate security group index', {
      db,
      projectId: PROJECT_ID,
      mode: 'hybrid',
    });

    expect(results[0]).toMatchObject({
      kind: 'source',
      id: source.id,
      snippet: expect.stringContaining('allocate_index_for_sg'),
      metadata: expect.objectContaining({
        sourceVersionId,
      }),
    });
    expect(results[0]?.snippet.length).toBeLessThanOrEqual(180);
    expect(results[0]?.citations[0]?.span).toMatchObject({
      startOffset: expect.any(Number),
      endOffset: expect.any(Number),
      startLine: expect.any(Number),
      startColumn: expect.any(Number),
      endLine: expect.any(Number),
      endColumn: expect.any(Number),
    });
    expect(results.some((result) => result.projectId === 'project_2')).toBe(false);
    const metadataOnlyIndex = results.findIndex((result) => result.title === 'docs/security-group-index-notes.md');
    expect(metadataOnlyIndex).toBeGreaterThan(0);
  });

  it('safely omits malformed or legacy extraction rows and falls back to bounded metadata search results', () => {
    const source = sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path: 'docs/legacy-search.md',
      content: 'legacy search content',
      format: 'markdown',
    });
    const sourceVersionId = sourceStore.listVersions(PROJECT_ID, source.id)[0].id;
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
         created_at,
         updated_at,
         completed_at
       ) VALUES (?, ?, ?, 'deterministic', 'markdown', '1', 'knowledge/extractions/legacy.json', 'content-hash', 'hash', '{not-json}', '[]', 'completed', ?, ?, ?)`,
    ).run('extraction_legacy', PROJECT_ID, sourceVersionId, CREATED_AT, CREATED_AT, CREATED_AT);

    const results = searchKnowledge('legacy search', { db, projectId: PROJECT_ID, mode: 'sources' });

    expect(results).toEqual([
      expect.objectContaining({
        kind: 'source',
        id: source.id,
        title: 'docs/legacy-search.md',
        snippet: expect.stringContaining('legacy-search'),
        citations: [
          expect.objectContaining({
            sourceId: source.id,
            span: null,
          }),
        ],
      }),
    ]);
  });

  it('keeps extraction-backed matches ahead of repeated path-only metadata matches', () => {
    const strongSource = sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path: 'src/search-ranking.ts',
      content: 'export function allocateIndexForGroup() { return "group-index"; }',
      format: 'typescript',
      mimeType: 'text/typescript',
    });
    const strongVersionId = sourceStore.listVersions(PROJECT_ID, strongSource.id)[0].id;
    extractionStore.save({
      projectId: PROJECT_ID,
      extraction: {
        analyzerId: 'typescript-lezer',
        analyzerVersion: '1',
        sourceVersionId: strongVersionId,
        title: 'src/search-ranking.ts',
        summary: 'Handles group index allocation.',
        sections: [
          {
            id: 'section:allocate',
            kind: 'code',
            title: 'allocate index',
            text: 'export function allocateIndexForGroup() { return "group-index"; }',
            span: {
              startOffset: 0,
              endOffset: 63,
              startLine: 1,
              startColumn: 1,
              endLine: 1,
              endColumn: 64,
            },
            confidence: 1,
          },
        ],
        symbols: [
          {
            id: 'symbol:allocate',
            kind: 'function',
            name: 'allocateIndexForGroup',
            qualifiedName: 'wiki.allocateIndexForGroup',
            span: {
              startOffset: 16,
              endOffset: 37,
              startLine: 1,
              startColumn: 17,
              endLine: 1,
              endColumn: 38,
            },
            confidence: 1,
          },
        ],
        relationships: [],
        links: [],
        diagnostics: [],
      },
    });

    const metadataOnlySource = sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path: `docs/${'allocate-index-'.repeat(20)}notes.md`,
      content: 'metadata only',
      format: 'markdown',
    });

    const results = searchKnowledge('allocate index', { db, projectId: PROJECT_ID, mode: 'sources' });

    expect(results[0]).toMatchObject({
      kind: 'source',
      id: strongSource.id,
      snippet: expect.stringContaining('allocate index'),
    });
    expect(results.findIndex((result) => result.id === metadataOnlySource.id)).toBeGreaterThan(0);
  });

  it('treats spanless extraction titles as metadata so they cannot outrank span-backed content matches', () => {
    const repeatedPath = `src/${'security_group_index_'.repeat(18)}notes.py`;
    const metadataOnlySource = sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path: repeatedPath,
      content: 'path metadata only',
      format: 'python',
      mimeType: 'text/x-python',
    });
    const metadataOnlyVersionId = sourceStore.listVersions(PROJECT_ID, metadataOnlySource.id)[0].id;
    extractionStore.save({
      projectId: PROJECT_ID,
      extraction: {
        analyzerId: 'python-lezer',
        analyzerVersion: '1',
        sourceVersionId: metadataOnlyVersionId,
        title: repeatedPath,
        summary: 'Path-like source metadata only.',
        sections: [
          {
            id: 'section:metadata',
            kind: 'code',
            title: 'helper',
            text: 'def helper():\n    return "metadata"\n',
            span: {
              startOffset: 0,
              endOffset: 35,
              startLine: 1,
              startColumn: 1,
              endLine: 2,
              endColumn: 22,
            },
            confidence: 1,
          },
        ],
        symbols: [],
        relationships: [],
        links: [],
        diagnostics: [],
      },
    });

    const contentSource = sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path: 'src/group_allocator.py',
      content: 'def allocate_security_group_index(group):\n    return group.index\n',
      format: 'python',
      mimeType: 'text/x-python',
    });
    const contentVersionId = sourceStore.listVersions(PROJECT_ID, contentSource.id)[0].id;
    extractionStore.save({
      projectId: PROJECT_ID,
      extraction: {
        analyzerId: 'python-lezer',
        analyzerVersion: '1',
        sourceVersionId: contentVersionId,
        title: 'src/group_allocator.py',
        summary: 'Allocates security group indexes.',
        sections: [
          {
            id: 'section:allocate',
            kind: 'code',
            title: 'allocate security group index',
            text: 'def allocate_security_group_index(group):\n    return group.index\n',
            span: {
              startOffset: 0,
              endOffset: 65,
              startLine: 1,
              startColumn: 1,
              endLine: 2,
              endColumn: 23,
            },
            confidence: 1,
          },
        ],
        symbols: [
          {
            id: 'symbol:allocate',
            kind: 'function',
            name: 'allocate_security_group_index',
            qualifiedName: 'allocator.allocate_security_group_index',
            span: {
              startOffset: 4,
              endOffset: 33,
              startLine: 1,
              startColumn: 5,
              endLine: 1,
              endColumn: 34,
            },
            confidence: 1,
          },
        ],
        relationships: [],
        links: [],
        diagnostics: [],
      },
    });

    const results = searchKnowledge('security group index', { db, projectId: PROJECT_ID, mode: 'sources' });

    expect(results[0]).toMatchObject({
      kind: 'source',
      id: contentSource.id,
      citations: [
        expect.objectContaining({
          sourceId: contentSource.id,
          span: expect.objectContaining({
            startLine: 1,
            endLine: 2,
          }),
        }),
      ],
    });
    expect(results.findIndex((result) => result.id === metadataOnlySource.id)).toBeGreaterThan(0);
    expect(results.find((result) => result.id === metadataOnlySource.id)?.citations).toEqual([
      expect.objectContaining({
        sourceId: metadataOnlySource.id,
        span: null,
      }),
    ]);
  });

  it('uses source structure to prefer a task-manager class over a broad workflow section', () => {
    const taskManagerSource = sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path: 'naas/test/Libs/TaskManagers/JCNR/jcnr_config.py',
      content: 'class TaskManagerConfig:\n    pass\n',
      format: 'python',
      mimeType: 'text/x-python',
    });
    const taskManagerVersion = sourceStore.listVersions(PROJECT_ID, taskManagerSource.id)[0];
    extractionStore.save({
      projectId: PROJECT_ID,
      extraction: {
        analyzerId: 'python-lezer',
        analyzerVersion: '1',
        sourceVersionId: taskManagerVersion.id,
        title: 'naas/test/Libs/TaskManagers/JCNR/jcnr_config.py',
        summary: 'JCNR configuration task manager.',
        sections: [],
        symbols: [
          {
            id: 'symbol:config',
            kind: 'class',
            name: 'TaskManagerConfig',
            qualifiedName: 'jcnr_config.TaskManagerConfig',
            span: {
              startOffset: 0,
              endOffset: 28,
              startLine: 1,
              startColumn: 1,
              endLine: 2,
              endColumn: 9,
            },
            confidence: 1,
          },
        ],
        relationships: [],
        links: [],
        diagnostics: [],
      },
    });

    const broadWorkflowSource = sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path: 'naas/test/Libs/Workflows/JCNR/solution_resources_workflow.py',
      content: 'task manager classes configure deployment workflows\n',
      format: 'python',
      mimeType: 'text/x-python',
    });
    const broadWorkflowVersion = sourceStore.listVersions(PROJECT_ID, broadWorkflowSource.id)[0];
    extractionStore.save({
      projectId: PROJECT_ID,
      extraction: {
        analyzerId: 'python-lezer',
        analyzerVersion: '1',
        sourceVersionId: broadWorkflowVersion.id,
        title: 'naas/test/Libs/Workflows/JCNR/solution_resources_workflow.py',
        summary: 'task manager classes configure deployment workflows',
        sections: [
          {
            id: 'section:workflow',
            kind: 'code',
            title: 'task manager classes',
            text: 'task manager classes configure deployment workflows',
            span: {
              startOffset: 0,
              endOffset: 51,
              startLine: 1,
              startColumn: 1,
              endLine: 1,
              endColumn: 52,
            },
            confidence: 1,
          },
        ],
        symbols: [],
        relationships: [],
        links: [],
        diagnostics: [],
      },
    });

    const results = searchKnowledge('main task-manager classes', {
      db,
      projectId: PROJECT_ID,
      mode: 'sources',
    });

    expect(results[0]).toMatchObject({
      kind: 'source',
      id: taskManagerSource.id,
    });
  });

  it('prefers an exact pytest hook source over a broadly matching workflow', () => {
    const bootstrapSource = sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path: 'naas/test/Tests/conftest.py',
      content: 'def pytest_configure(config):\n    pass\n',
      format: 'python',
      mimeType: 'text/x-python',
    });
    const bootstrapVersion = sourceStore.listVersions(PROJECT_ID, bootstrapSource.id)[0];
    extractionStore.save({
      projectId: PROJECT_ID,
      extraction: {
        analyzerId: 'python-lezer',
        analyzerVersion: '1',
        sourceVersionId: bootstrapVersion.id,
        title: 'naas/test/Tests/conftest.py',
        summary: 'pytest bootstrap configuration',
        sections: [],
        symbols: [
          {
            id: 'symbol:pytest-configure',
            kind: 'function',
            name: 'pytest_configure',
            qualifiedName: 'conftest.pytest_configure',
            span: {
              startOffset: 0,
              endOffset: 39,
              startLine: 1,
              startColumn: 1,
              endLine: 2,
              endColumn: 9,
            },
            confidence: 1,
          },
        ],
        relationships: [],
        links: [],
        diagnostics: [],
      },
    });

    const noisyWorkflow = sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path: 'naas/test/Libs/Workflows/JCNR/security_group_workflow.py',
      content: 'pytest bootstrap defaults configuration pytest bootstrap defaults\n',
      format: 'python',
      mimeType: 'text/x-python',
    });
    const noisyVersion = sourceStore.listVersions(PROJECT_ID, noisyWorkflow.id)[0];
    extractionStore.save({
      projectId: PROJECT_ID,
      extraction: {
        analyzerId: 'python-lezer',
        analyzerVersion: '1',
        sourceVersionId: noisyVersion.id,
        title: 'naas/test/Libs/Workflows/JCNR/security_group_workflow.py',
        summary: 'pytest bootstrap defaults configuration',
        sections: [
          {
            id: 'section:noisy',
            kind: 'code',
            title: 'pytest bootstrap defaults',
            text: 'pytest bootstrap defaults configuration pytest bootstrap defaults',
            span: {
              startOffset: 0,
              endOffset: 65,
              startLine: 1,
              startColumn: 1,
              endLine: 1,
              endColumn: 66,
            },
            confidence: 1,
          },
        ],
        symbols: [],
        relationships: [],
        links: [],
        diagnostics: [],
      },
    });

    const results = searchKnowledge('pytest bootstrap defaults', {
      db,
      projectId: PROJECT_ID,
      mode: 'sources',
    });

    expect(results[0]).toMatchObject({
      kind: 'source',
      id: bootstrapSource.id,
    });
  });

  it('does not apply structural bonuses when only extraction metadata matches', () => {
    const contentSource = sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path: 'src/config.py',
      content: 'def load_config():\n    return {"loader": True}\n',
      format: 'python',
      mimeType: 'text/x-python',
    });
    const contentVersion = sourceStore.listVersions(PROJECT_ID, contentSource.id)[0];
    extractionStore.save({
      projectId: PROJECT_ID,
      extraction: {
        analyzerId: 'python-lezer',
        analyzerVersion: '1',
        sourceVersionId: contentVersion.id,
        title: 'src/config.py',
        summary: 'Configuration values.',
        sections: [
          {
            id: 'section:loader',
            kind: 'code',
            title: 'configuration',
            text: 'The loader initializes configuration.',
            span: {
              startOffset: 0,
              endOffset: 44,
              startLine: 1,
              startColumn: 1,
              endLine: 2,
              endColumn: 1,
            },
            confidence: 1,
          },
        ],
        symbols: [
          {
            id: 'symbol:load-config',
            kind: 'function',
            name: 'load_config',
            qualifiedName: 'load_config',
            span: {
              startOffset: 0,
              endOffset: 48,
              startLine: 1,
              startColumn: 1,
              endLine: 2,
              endColumn: 44,
            },
            confidence: 1,
          },
        ],
        relationships: [],
        links: [],
        diagnostics: [],
      },
    });

    const metadataSource = sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path: 'naas/Libs/loader/config_notes.py',
      content: 'No implementation details here.',
      format: 'python',
      mimeType: 'text/x-python',
    });
    const metadataVersion = sourceStore.listVersions(PROJECT_ID, metadataSource.id)[0];
    extractionStore.save({
      projectId: PROJECT_ID,
      extraction: {
        analyzerId: 'python-lezer',
        analyzerVersion: '1',
        sourceVersionId: metadataVersion.id,
        title: 'naas/Libs/loader/config_notes.py',
        summary: 'Loader metadata only.',
        sections: [],
        symbols: [],
        relationships: [],
        links: [],
        diagnostics: [],
      },
    });

    const results = searchKnowledge('loader', {
      db,
      projectId: PROJECT_ID,
      mode: 'sources',
    });

    expect(results[0]).toMatchObject({
      kind: 'source',
      id: contentSource.id,
    });
    expect(results.findIndex((result) => result.id === metadataSource.id)).toBeGreaterThan(0);
  });

  it('redacts extraction-backed snippets before returning source-backed excerpts and exact citations', () => {
    const source = sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path: 'src/secrets.ts',
      content: 'export const config = "production";',
      format: 'typescript',
      mimeType: 'text/typescript',
    });
    const sourceVersionId = sourceStore.listVersions(PROJECT_ID, source.id)[0].id;
    extractionStore.save({
      projectId: PROJECT_ID,
      extraction: {
        analyzerId: 'typescript-lezer',
        analyzerVersion: '1',
        sourceVersionId,
        title: 'src/secrets.ts',
        summary: 'Production config with secrets.',
        sections: [
          {
            id: 'section:config',
            kind: 'code',
            title: 'production config',
            text: [
              'const apiKey = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";',
              'const github = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";',
              'const password = "hunter2";',
              'const aws = "AKIA1234567890ABCDEF";',
            ].join('\n'),
            span: {
              startOffset: 0,
              endOffset: 180,
              startLine: 1,
              startColumn: 1,
              endLine: 4,
              endColumn: 45,
            },
            confidence: 1,
          },
        ],
        symbols: [],
        relationships: [],
        links: [],
        diagnostics: [],
      },
    });

    const results = searchKnowledge('apiKey password', { db, projectId: PROJECT_ID, mode: 'sources' });

    expect(results[0]).toMatchObject({
      kind: 'source',
      id: source.id,
      citations: [
        expect.objectContaining({
          sourceId: source.id,
          span: expect.objectContaining({
            startLine: 1,
            endLine: 4,
          }),
        }),
      ],
    });
    expect(results[0]?.snippet).toContain('***');
    expect(results[0]?.snippet).not.toContain('sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456');
    expect(results[0]?.snippet).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(results[0]?.snippet).not.toContain('hunter2');
    expect(results[0]?.snippet).not.toContain('AKIA1234567890ABCDEF');
  });

  it('skips oversized extraction payloads and overlong queries without crashing source search', () => {
    const source = sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path: 'docs/oversized-search-knowledge.md',
      content: 'oversized knowledge',
      format: 'markdown',
    });
    const sourceVersionId = sourceStore.listVersions(PROJECT_ID, source.id)[0].id;
    const oversizedExtraction = JSON.stringify({
      analyzerId: 'markdown',
      analyzerVersion: '1',
      sourceVersionId,
      title: 'docs/oversized-search-knowledge.md',
      summary: 'Oversized summary',
      sections: [
        {
          id: 'section:oversized',
          kind: 'paragraph',
          title: 'oversized knowledge',
          text: 'x'.repeat(1_500_000),
          span: {
            startOffset: 0,
            endOffset: 1_500_000,
            startLine: 1,
            startColumn: 1,
            endLine: 1,
            endColumn: 1_500_001,
          },
          confidence: 1,
        },
      ],
      symbols: [],
      relationships: [],
      links: [],
      diagnostics: [],
    });
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
         created_at,
         updated_at,
         completed_at
       ) VALUES (?, ?, ?, 'deterministic', 'markdown', '1', 'knowledge/extractions/oversized.json', 'content-hash', 'hash', ?, '[]', 'completed', ?, ?, ?)`,
    ).run('extraction_oversized', PROJECT_ID, sourceVersionId, oversizedExtraction, CREATED_AT, CREATED_AT, CREATED_AT);

    expect(searchKnowledge('query '.repeat(80), { db, projectId: PROJECT_ID, mode: 'sources' })).toEqual([]);

    const results = searchKnowledge('oversized search knowledge', { db, projectId: PROJECT_ID, mode: 'sources' });

    expect(results).toEqual([
      expect.objectContaining({
        kind: 'source',
        id: source.id,
        title: 'docs/oversized-search-knowledge.md',
        snippet: expect.stringContaining('oversized-search-knowledge'),
        citations: [
          expect.objectContaining({
            sourceId: source.id,
            span: null,
          }),
        ],
      }),
    ]);
  });

  it('skips extraction rows when persisted spans overflow the bounded lookup window', () => {
    const source = sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path: 'docs/overflow-spans.md',
      content: 'overflow spans metadata',
      format: 'markdown',
    });
    const sourceVersionId = sourceStore.listVersions(PROJECT_ID, source.id)[0].id;
    extractionStore.save({
      projectId: PROJECT_ID,
      extraction: {
        analyzerId: 'markdown',
        analyzerVersion: '1',
        sourceVersionId,
        title: 'docs/overflow-spans.md',
        summary: 'Overflow spans summary.',
        sections: [
          {
            id: 'section:overflow',
            kind: 'paragraph',
            title: 'overflow spans',
            text: 'overflow spans content',
            span: {
              startOffset: 0,
              endOffset: 22,
              startLine: 1,
              startColumn: 1,
              endLine: 1,
              endColumn: 23,
            },
            confidence: 1,
          },
        ],
        symbols: [],
        relationships: [],
        links: [],
        diagnostics: [],
      },
    });

    const insertSpan = db.prepare(
      `INSERT INTO knowledge_source_spans
       (id, project_id, source_version_id, start_offset, end_offset, start_line, start_column, end_line, end_column, label, created_at)
       VALUES (?, ?, ?, ?, ?, 1, 1, 1, 2, ?, ?)`,
    );
    for (let index = 0; index < 2_100; index += 1) {
      insertSpan.run(
        `span_overflow_${index}`,
        PROJECT_ID,
        sourceVersionId,
        10_000 + index * 2,
        10_001 + index * 2,
        `overflow-${index}`,
        CREATED_AT,
      );
    }

    const results = searchKnowledge('overflow spans', { db, projectId: PROJECT_ID, mode: 'sources' });

    expect(results).toEqual([
      expect.objectContaining({
        kind: 'source',
        id: source.id,
        snippet: expect.stringContaining('overflow-spans'),
        citations: [
          expect.objectContaining({
            sourceId: source.id,
            span: null,
          }),
        ],
        metadata: expect.objectContaining({
          extractionId: null,
          analyzerId: null,
          analyzerVersion: null,
        }),
      }),
    ]);
  });

  it('rejects Unicode-heavy queries by UTF-8 byte length before source search runs', () => {
    sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path: 'docs/unicode-heavy.md',
      content: 'unicode heavy',
      format: 'markdown',
    });

    expect(searchKnowledge('🙂'.repeat(100), { db, projectId: PROJECT_ID, mode: 'sources' })).toEqual([]);
  });
});


describe('searchKnowledge with the materialized search index', () => {
  let db: Database.Database;
  let sourceStore: KnowledgeSourceStore;
  let extractionStore: KnowledgeExtractionStore;
  let index: KnowledgeSearchIndex;
  const versions = new Map<string, string>();
  const extractionIds = new Map<string, string>();

  function fixtureSpan(start: number, end: number) {
    return { startOffset: start, endOffset: end, startLine: 1, startColumn: start + 1, endLine: 1, endColumn: end + 1 };
  }

  function addSource(path: string, name: string | null, options: { pending?: boolean } = {}): string {
    const source = sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path,
      content: `content of ${path}`,
      format: 'typescript',
      mimeType: 'text/typescript',
    });
    const list = sourceStore.listVersions(PROJECT_ID, source.id);
    const versionId = list[list.length - 1].id;
    versions.set(path, versionId);
    if (name !== null && !options.pending) {
      const saved = extractionStore.save({
        projectId: PROJECT_ID,
        extraction: {
          analyzerId: 'typescript-lezer',
          analyzerVersion: '1',
          sourceVersionId: versionId,
          title: path,
          summary: `Handles ${name} behavior.`,
          sections: [
            {
              id: 'section:1',
              kind: 'code',
              title: `${name} section`,
              text: `export function ${name}() { return '${name}'; }`,
              span: fixtureSpan(0, 40),
              confidence: 1,
            },
          ],
          symbols: [
            { id: 'symbol:1', kind: 'function', name, qualifiedName: `lib.${name}`, span: fixtureSpan(16, 30), confidence: 1 },
          ],
          relationships: [],
          links: [],
          diagnostics: [],
        },
      });
      extractionIds.set(path, saved.id);
    }
    return source.id;
  }

  function run(query: string, projectId = PROJECT_ID, extra: Record<string, unknown> = {}) {
    return searchKnowledge(query, { db, projectId, mode: 'sources', limit: 50, ...extra });
  }

  const QUERIES = ['allocate index', 'loader', 'widget handler', 'docs notes', 'export function', 'no such thing'];

  function snapshot() {
    return QUERIES.map((query) => run(query));
  }

  beforeEach(() => {
    db = createKnowledgeDatabase();
    sourceStore = new KnowledgeSourceStore(db);
    extractionStore = new KnowledgeExtractionStore(db);
    index = new KnowledgeSearchIndex(db);
    versions.clear();
    extractionIds.clear();
    addSource('src/allocate_index.ts', 'allocateIndex');
    addSource('src/loader.ts', 'loadWidget');
    addSource('src/widget_handler.ts', 'handleWidget');
    addSource('src/other_loader.ts', 'otherLoader');
    addSource('docs/notes.md', null);
    addSource('docs/index-notes.md', null);
    addSource('src/unrelated.ts', 'zzz');
  });

  afterEach(() => {
    db.close();
  });

  it('returns identical results before and after a full index rebuild (ranking and citation parity)', () => {
    const legacy = snapshot();
    expect(legacy.some((results) => results.length > 0)).toBe(true);

    const report = index.rebuildProject(PROJECT_ID);
    expect(report.failed).toBe(0);
    expect(index.getStatus(PROJECT_ID).unindexedCount).toBe(0);

    expect(snapshot()).toEqual(legacy);
  });

  it('serves results from the index rather than re-parsing persisted extraction JSON', () => {
    index.rebuildProject(PROJECT_ID);
    const legacy = index.getStatus(PROJECT_ID);
    expect(legacy.indexedCount).toBe(7);
    db.prepare('UPDATE knowledge_extractions SET result_json = ?').run('{not-json}');

    const results = run('loadWidget');

    expect(results[0]).toMatchObject({ title: 'src/loader.ts', snippet: expect.stringContaining('loadWidget') });
    expect(results[0].citations[0].span).not.toBeNull();
  });

  it('matches the legacy scan for a partial index of indexed, stale, failed, unindexed, and pending sources', () => {
    const pendingSourceId = addSource('src/pending_loader.ts', 'pendingLoader');
    sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path: 'src/pending_loader.ts',
      content: 'a newer unanalyzed version with loader',
      format: 'typescript',
    });
    const legacy = snapshot();

    index.replaceForSourceVersion({ projectId: PROJECT_ID, sourceVersionId: versions.get('src/allocate_index.ts')!, coverage: 'extraction', extractionId: extractionIds.get('src/allocate_index.ts')! });
    index.replaceForSourceVersion({ projectId: PROJECT_ID, sourceVersionId: versions.get('src/loader.ts')!, coverage: 'extraction', extractionId: extractionIds.get('src/loader.ts')! });
    index.replaceForSourceVersion({ projectId: PROJECT_ID, sourceVersionId: versions.get('src/widget_handler.ts')!, coverage: 'extraction', extractionId: extractionIds.get('src/widget_handler.ts')! });
    index.replaceForSourceVersion({ projectId: PROJECT_ID, sourceVersionId: versions.get('docs/notes.md')!, coverage: 'metadata_only' });
    index.replaceForSourceVersion({ projectId: PROJECT_ID, sourceVersionId: versions.get('src/other_loader.ts')!, coverage: 'extraction', extractionId: extractionIds.get('src/other_loader.ts')! });
    const staleSource = sourceStore.list(PROJECT_ID).find((source) => source.canonicalPath === 'src/other_loader.ts')!;
    index.markSourceStale(PROJECT_ID, staleSource.id);
    db.prepare(`UPDATE knowledge_search_indexes SET status = 'failed' WHERE source_version_id = ?`).run(versions.get('src/widget_handler.ts')!);
    expect(index.getStatus(PROJECT_ID)).toMatchObject({ indexedCount: 3, failedCount: 1, staleCount: 1 });
    expect(pendingSourceId).toBeTruthy();

    const partial = snapshot();

    expect(partial).toEqual(legacy);
    for (const results of partial) {
      const ids = results.map((result) => result.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('serves a pending newer source version by fallback and never by the older version index', () => {
    index.rebuildProject(PROJECT_ID);
    const older = run('loadWidget');
    expect(older[0]).toMatchObject({ title: 'src/loader.ts' });

    sourceStore.register({
      projectId: PROJECT_ID,
      kind: 'file',
      path: 'src/loader.ts',
      content: 'brand new content without extraction',
      format: 'typescript',
      mimeType: 'text/typescript',
    });

    const results = run('loadWidget');
    expect(results.find((result) => result.title === 'src/loader.ts')).toBeUndefined();
    const byPath = run('loader');
    const loader = byPath.find((result) => result.title === 'src/loader.ts');
    expect(loader?.metadata.extractionId).toBeNull();
    expect(loader?.metadata.sourceVersionId).not.toBe(older[0].metadata.sourceVersionId);
  });

  it('finds path-only sources through metadata_only indexes exactly like the scan', () => {
    const legacy = run('index notes');
    index.rebuildProject(PROJECT_ID);
    const indexed = run('index notes');
    expect(indexed).toEqual(legacy);
    expect(indexed.map((result) => result.title)).toContain('docs/index-notes.md');
  });

  it('keeps candidate lookup isolated per project', () => {
    db.prepare(
      `INSERT INTO knowledge_projects (id, workspace_root, name, status, created_at, updated_at)
       VALUES ('project_2', '/workspace/other', 'Other', 'active', ?, ?)`,
    ).run(CREATED_AT, CREATED_AT);
    sourceStore.register({ projectId: 'project_2', kind: 'file', path: 'src/loader.ts', content: 'other project loader', format: 'typescript' });
    index.rebuildProject(PROJECT_ID);
    index.rebuildProject('project_2');

    const results = run('loader');

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.projectId === PROJECT_ID)).toBe(true);
    expect(run('loader', 'project_2').every((result) => result.projectId === 'project_2')).toBe(true);
  });

  it('falls back to the full scan and reports a diagnostic when the index status query fails', () => {
    const legacy = snapshot();
    db.exec('DROP TABLE knowledge_search_index_fields; DROP TABLE knowledge_search_indexes;');
    const diagnostics: Array<{ code: string; message: string }> = [];

    const results = QUERIES.map((query) =>
      run(query, PROJECT_ID, { onDiagnostic: (diagnostic: { code: string; message: string }) => diagnostics.push(diagnostic) }),
    );

    expect(results).toEqual(legacy);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0].code).toBe('search_index_unavailable');
  });

  it('throws instead of returning an empty success when both the index and the fallback fail', () => {
    db.exec('DROP TABLE knowledge_search_index_fields; DROP TABLE knowledge_search_indexes;');
    db.exec('ALTER TABLE knowledge_extractions RENAME TO knowledge_extractions_broken');

    expect(() => run('loader', PROJECT_ID, { onDiagnostic: () => undefined })).toThrow();
  });

  it('bounds fallback scanning to unindexed sources when most of the project is indexed', () => {
    index.rebuildProject(PROJECT_ID);
    const late = addSource('src/late_loader.ts', 'lateLoader');
    expect(late).toBeTruthy();
    expect(index.getUnindexedSourceIds(PROJECT_ID)).toEqual([late]);

    const results = run('lateLoader');

    expect(results[0]).toMatchObject({ id: late, title: 'src/late_loader.ts' });
  });
});

describe('searchKnowledge top-one confidence and ambiguity', () => {
  let db: Database.Database;

  function span(end: number) {
    return { startOffset: 0, endOffset: end, startLine: 1, startColumn: 1, endLine: 1, endColumn: end + 1 };
  }

  interface FixtureOptions {
    text: string;
    symbol?: { name: string; kind: 'class' | 'function' };
    spanBacked?: boolean;
    database?: Database.Database;
    projectId?: string;
  }

  function addSource(path: string, options: FixtureOptions): string {
    const target = options.database ?? db;
    const projectId = options.projectId ?? PROJECT_ID;
    const source = new KnowledgeSourceStore(target).register({
      projectId,
      kind: 'file',
      path,
      content: `content of ${path}`,
      format: 'python',
      mimeType: 'text/x-python',
    });
    const versions = new KnowledgeSourceStore(target).listVersions(projectId, source.id);
    if (options.spanBacked === false) return source.id;
    new KnowledgeExtractionStore(target).save({
      projectId,
      extraction: {
        analyzerId: 'python-lezer',
        analyzerVersion: '1',
        sourceVersionId: versions[versions.length - 1].id,
        title: path,
        summary: 'fixture',
        sections: [{ id: 'section:1', kind: 'code', title: 'section', text: options.text, span: span(options.text.length), confidence: 1 }],
        symbols: options.symbol
          ? [{ id: 'symbol:1', kind: options.symbol.kind, name: options.symbol.name, qualifiedName: options.symbol.name, span: span(10), confidence: 1 }]
          : [],
        relationships: [],
        links: [],
        diagnostics: [],
      },
    });
    return source.id;
  }

  function search(query: string, database = db, projectId = PROJECT_ID, mode: 'sources' | 'hybrid' = 'sources') {
    return searchKnowledge(query, { db: database, projectId, mode, limit: 50 });
  }

  beforeEach(() => {
    db = createKnowledgeDatabase();
  });

  afterEach(() => {
    db.close();
  });

  it('marks equal-quality candidates with no shared role as a near tie with a stable winner', () => {
    addSource('src/beta_ledger.py', { text: 'reconcile ledger entries nightly' });
    addSource('src/alpha_ledger.py', { text: 'reconcile ledger entries nightly' });

    const results = search('reconcile ledger entries');

    expect(results.map((result) => result.title)).toEqual(['src/alpha_ledger.py', 'src/beta_ledger.py']);
    expect(results[0]).toMatchObject({ searchConfidence: 'ambiguous', ambiguityReason: 'near_tie', ambiguityAlternatives: 1 });
  });

  it('keeps scanning past a weaker in-band candidate to find a later equivalent alternative', () => {
    // Many entries-only sources lower the weight of "entries", keeping the partial match inside the score band.
    for (let index = 0; index < 50; index += 1) addSource(`src/filler${index}.py`, { text: 'entries' });
    addSource('src/leader_reconcile.py', { text: 'reconcile ledger entries' });
    addSource('src/loader/partial.py', { text: 'ledger' });
    addSource('src/later_ledger.py', { text: 'reconcile ledger entries' });

    const results = search('reconcile ledger entries loader');

    expect(results.slice(0, 3).map((result) => result.title)).toEqual([
      'src/leader_reconcile.py',
      'src/loader/partial.py',
      'src/later_ledger.py',
    ]);
    expect(results[2].score).toBeGreaterThanOrEqual(results[0].score * 0.95);
    expect(results[0]).toMatchObject({ searchConfidence: 'ambiguous', ambiguityReason: 'insufficient_intent', ambiguityAlternatives: 1 });
  });

  it('marks near-equal candidates that share a structural role as shared_role', () => {
    addSource('src/usecases/alpha_deploy.py', { text: 'deployment readiness checks' });
    addSource('src/usecases/beta_deploy.py', { text: 'deployment readiness checks' });

    const results = search('use case deployment readiness');

    expect(results[0]).toMatchObject({
      title: 'src/usecases/alpha_deploy.py',
      searchConfidence: 'ambiguous',
      ambiguityReason: 'shared_role',
      ambiguityAlternatives: 1,
    });
  });

  it('reports insufficient_intent when a single-term query cannot separate close candidates', () => {
    addSource('src/one.py', { text: 'reconcile the ledger' });
    addSource('src/two.py', { text: 'reconcile the ledger' });

    const results = search('reconcile');

    expect(results[0]).toMatchObject({ searchConfidence: 'ambiguous', ambiguityReason: 'insufficient_intent', ambiguityAlternatives: 1 });
  });

  it('reports insufficient_intent when the top result covers only part of the query', () => {
    addSource('src/one.py', { text: 'reconcile ledger' });
    addSource('src/two.py', { text: 'reconcile ledger' });

    const results = search('reconcile ledger settlement');

    expect(results[0]).toMatchObject({ searchConfidence: 'ambiguous', ambiguityReason: 'insufficient_intent' });
  });

  it('keeps winner, reason, and alternatives stable across insertion order and repeated runs', () => {
    const paths = ['src/c_ledger.py', 'src/a_ledger.py', 'src/b_ledger.py'];
    const other = createKnowledgeDatabase();
    try {
      for (const path of paths) addSource(path, { text: 'reconcile ledger entries' });
      for (const path of [...paths].reverse()) addSource(path, { text: 'reconcile ledger entries', database: other });

      const first = search('reconcile ledger entries');
      const reversed = search('reconcile ledger entries', other);

      expect(first[0]).toMatchObject({ title: 'src/a_ledger.py', ambiguityReason: 'near_tie', ambiguityAlternatives: 2 });
      expect(reversed.map((result) => [result.title, result.searchConfidence, result.ambiguityReason, result.ambiguityAlternatives])).toEqual(
        first.map((result) => [result.title, result.searchConfidence, result.ambiguityReason, result.ambiguityAlternatives]),
      );
      expect(search('reconcile ledger entries')).toEqual(first);
    } finally {
      other.close();
    }
  });

  it('bounds the reported alternative count and only annotates the first source result', () => {
    for (let i = 0; i < 25; i += 1) addSource(`src/tie_${String(i).padStart(2, '0')}.py`, { text: 'reconcile ledger entries' });

    const results = search('reconcile ledger entries');

    expect(results).toHaveLength(25);
    expect(results[0].searchConfidence).toBe('ambiguous');
    expect(results[0].ambiguityAlternatives).toBe(10);
    for (const result of results.slice(1)) {
      expect(result).not.toHaveProperty('searchConfidence');
      expect(result).not.toHaveProperty('ambiguityReason');
      expect(result).not.toHaveProperty('ambiguityAlternatives');
    }
  });

  it('reports clear without ambiguity keys for a single result or a clearly stronger top result', () => {
    addSource('src/only.py', { text: 'reconcile ledger entries' });
    const single = search('reconcile ledger entries');
    expect(single[0].searchConfidence).toBe('clear');
    expect(single[0]).not.toHaveProperty('ambiguityReason');
    expect(single[0]).not.toHaveProperty('ambiguityAlternatives');

    addSource('src/weak.py', { text: 'ledger' });
    const results = search('reconcile ledger entries');
    expect(results.map((result) => result.title)).toEqual(['src/only.py', 'src/weak.py']);
    expect(results[0]).toMatchObject({ searchConfidence: 'clear' });
    expect(results[0]).not.toHaveProperty('ambiguityReason');
  });

  it('does not flag ambiguity when an exact symbol match separates otherwise close candidates', () => {
    addSource('src/other_loader.py', { text: 'loader for defaults' });
    addSource('src/loader.py', { text: 'loader for defaults', symbol: { name: 'Loader', kind: 'class' } });

    const results = search('loader defaults');

    expect(results[0]).toMatchObject({ title: 'src/loader.py', searchConfidence: 'clear' });
  });

  it('does not let a metadata-only tie or structural-only path make a span-backed winner ambiguous', () => {
    addSource('src/reconcile_ledger_entries.py', { text: 'unused', spanBacked: false });
    addSource('src/span_backed.py', { text: 'reconcile ledger entries' });

    const results = search('reconcile ledger entries');

    expect(results[0]).toMatchObject({ title: 'src/span_backed.py', searchConfidence: 'clear' });
  });

  it('does not report ambiguity when no source matches and never surfaces a synthetic result', () => {
    addSource('src/one.py', { text: 'reconcile ledger entries' });

    expect(search('zzzz nothing')).toEqual([]);
  });

  it('computes confidence from the project-scoped candidates only', () => {
    addSource('src/one.py', { text: 'reconcile ledger entries' });
    db.prepare(
      `INSERT INTO knowledge_projects (id, workspace_root, name, status, created_at, updated_at)
       VALUES ('project_2', '/other', 'Other', 'active', ?, ?)`,
    ).run(CREATED_AT, CREATED_AT);
    addSource('src/one.py', { text: 'reconcile ledger entries', projectId: 'project_2' });

    expect(search('reconcile ledger entries')[0].searchConfidence).toBe('clear');
  });

  it('attaches identical metadata through the materialized index and the legacy scan', () => {
    addSource('src/beta_ledger.py', { text: 'reconcile ledger entries' });
    addSource('src/alpha_ledger.py', { text: 'reconcile ledger entries' });
    addSource('src/other.py', { text: 'unrelated words' });
    const legacy = search('reconcile ledger entries');

    new KnowledgeSearchIndex(db).rebuildProject(PROJECT_ID);
    const indexed = search('reconcile ledger entries');

    expect(indexed).toEqual(legacy);
    expect(indexed[0]).toMatchObject({ searchConfidence: 'ambiguous', ambiguityReason: 'near_tie' });
  });

  it('annotates the first source result in hybrid mode without touching page or task results', () => {
    addSource('src/beta_ledger.py', { text: 'reconcile ledger entries' });
    addSource('src/alpha_ledger.py', { text: 'reconcile ledger entries' });

    const results = search('reconcile ledger entries', db, PROJECT_ID, 'hybrid');

    expect(results.filter((result) => result.searchConfidence !== undefined)).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: 'source', searchConfidence: 'ambiguous' });
  });

  it('exposes only enumerated values and counts, never source text', () => {
    addSource('src/one.py', { text: 'password = "hunter2-secret-value" reconcile ledger' });
    addSource('src/two.py', { text: 'password = "hunter2-secret-value" reconcile ledger' });

    const [top] = search('reconcile ledger');
    const confidenceKeys = Object.keys(top).filter((key) => key === 'searchConfidence' || key.startsWith('ambiguity'));

    expect(confidenceKeys.sort()).toEqual(['ambiguityAlternatives', 'ambiguityReason', 'searchConfidence']);
    expect(JSON.stringify([top.searchConfidence, top.ambiguityReason, top.ambiguityAlternatives])).not.toContain('hunter2');
  });
});
