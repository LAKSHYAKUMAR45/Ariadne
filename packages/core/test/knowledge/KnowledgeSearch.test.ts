import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { TaskStore } from '../../src/TaskStore.js';
import { openDatabase } from '../../src/db.js';
import { searchWorkspace } from '../../src/Search.js';
import { applyKnowledgeMigrations } from '../../src/knowledge/knowledgeMigrations.js';
import { KnowledgePageStore } from '../../src/knowledge/KnowledgePageStore.js';
import { KnowledgeSourceStore } from '../../src/knowledge/KnowledgeSourceStore.js';
import {
  buildKnowledgeSearchContext,
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

  beforeEach(() => {
    db = createKnowledgeDatabase();
    taskStore = new TaskStore(':memory:');
    sourceStore = new KnowledgeSourceStore(db);
    pageStore = new KnowledgePageStore(db);
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
});
