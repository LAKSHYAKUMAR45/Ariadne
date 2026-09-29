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
