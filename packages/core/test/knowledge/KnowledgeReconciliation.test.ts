import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../src/schema.js';
import { KnowledgeGraph } from '../../src/knowledge/graph/KnowledgeGraph.js';
import { applyKnowledgeMigrations } from '../../src/knowledge/knowledgeMigrations.js';
import { KnowledgePageStore } from '../../src/knowledge/KnowledgePageStore.js';
import { KnowledgeReconciliation } from '../../src/knowledge/KnowledgeReconciliation.js';
import { KnowledgeSourceStore } from '../../src/knowledge/KnowledgeSourceStore.js';
import type { KnowledgeGraphNodeId, KnowledgePageId, KnowledgeSourceId } from '../../src/knowledge/KnowledgeTypes.js';

interface TestContext {
  db: Database.Database;
  pages: KnowledgePageStore;
  reconciliation: KnowledgeReconciliation;
  sources: KnowledgeSourceStore;
  graph: KnowledgeGraph;
}

function createContext(): TestContext {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  applyKnowledgeMigrations(db);
  db.prepare(
    `INSERT INTO knowledge_projects (id, workspace_root, name, status, created_at, updated_at)
     VALUES ('project-1', '/workspace', 'Workspace', 'active', ?, ?)`,
  ).run('2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z');
  return {
    db,
    pages: new KnowledgePageStore(db),
    reconciliation: new KnowledgeReconciliation(db, { now: () => '2026-09-24T01:00:00.000Z' }),
    sources: new KnowledgeSourceStore(db),
    graph: new KnowledgeGraph(db),
  };
}

describe('KnowledgeReconciliation', () => {
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it('archives pages owned only by a deleted source and preserves shared pages with pruned provenance', () => {
    const context = createContext();
    databases.push(context.db);
    const deletedSource = context.sources.register({
      projectId: 'project-1',
      kind: 'file',
      path: 'docs/deleted.md',
      content: 'Deleted source',
    });
    const sharedSource = context.sources.register({
      projectId: 'project-1',
      kind: 'file',
      path: 'docs/shared.md',
      content: 'Shared source',
    });
    const deletedVersion = context.sources.listVersions('project-1', deletedSource.id)[0]!;
    const sharedVersion = context.sources.listVersions('project-1', sharedSource.id)[0]!;
    const sourceOnly = context.pages.createPageVersion({
      projectId: 'project-1',
      type: 'source',
      title: 'Deleted Source Page',
      slug: 'deleted-source',
      content: 'Only deleted source content',
      sourceVersionIds: [deletedVersion.id],
      provenance: [{ kind: 'source', id: deletedSource.id, confidence: 1 }],
    });
    const shared = context.pages.createPageVersion({
      projectId: 'project-1',
      type: 'concept',
      title: 'Shared Concept',
      slug: 'shared-concept',
      content: 'Shared concept content',
      sourceVersionIds: [deletedVersion.id, sharedVersion.id],
      provenance: [
        { kind: 'source', id: deletedSource.id, confidence: 0.4 },
        { kind: 'source', id: sharedSource.id, confidence: 0.9 },
      ],
    });
    context.db.prepare(
      `INSERT INTO knowledge_page_links (id, project_id, source_page_id, target_page_id, target_reference, created_at)
       VALUES ('link-1', 'project-1', ?, ?, 'shared-concept', ?)`,
    ).run(sourceOnly.pageId, shared.pageId, '2026-09-24T00:10:00.000Z');
    context.graph.upsertGraphNode({
      id: 'source-node' as KnowledgeGraphNodeId,
      projectId: 'project-1',
      nodeType: 'source',
      label: 'Deleted source',
      sourceKind: 'source',
      sourceId: deletedSource.id,
    });
    context.graph.upsertGraphNode({
      id: 'source-page-node' as KnowledgeGraphNodeId,
      projectId: 'project-1',
      nodeType: 'page',
      label: 'Deleted Source Page',
      sourceKind: 'page',
      sourceId: sourceOnly.pageId,
    });
    context.graph.upsertGraphNode({
      id: 'shared-page-node' as KnowledgeGraphNodeId,
      projectId: 'project-1',
      nodeType: 'page',
      label: 'Shared Concept',
      sourceKind: 'page',
      sourceId: shared.pageId,
    });
    context.graph.upsertGraphEdge({
      projectId: 'project-1',
      sourceNodeId: 'source-node' as KnowledgeGraphNodeId,
      targetNodeId: 'shared-page-node' as KnowledgeGraphNodeId,
      edgeType: 'supports',
      evidence: 'shared_source',
      provenance: [{ kind: 'source', id: deletedSource.id, confidence: 1 }],
    });

    const result = context.reconciliation.reconcileDeletedSource(deletedSource.id);

    expect(result.archivedPageIds).toEqual([sourceOnly.pageId]);
    expect(result.supersededPageIds).toEqual([shared.pageId]);
    expect(context.pages.getCurrentPage('project-1', sourceOnly.pageId)?.status).toBe('archived');
    const currentShared = context.pages.getCurrentPage('project-1', shared.pageId);
    expect(currentShared).toMatchObject({ status: 'active', currentVersion: 2 });
    expect(currentShared?.sourceVersionIds).toEqual([sharedVersion.id]);
    expect(currentShared?.provenance).toEqual([{ kind: 'source', id: sharedSource.id, confidence: 0.9 }]);
    expect(context.db.prepare('SELECT COUNT(*) AS count FROM knowledge_page_links').get()).toEqual({ count: 0 });
    expect(context.graph.listGraphEdges('project-1')).toEqual([]);
    expect(
      context.db.prepare('SELECT COUNT(*) AS count FROM knowledge_graph_nodes WHERE source_id IN (?, ?)').get(
        deletedSource.id,
        sourceOnly.pageId,
      ),
    ).toEqual({ count: 0 });
  });

  it('marks pages stale, cleans indexes and links, and emits idempotent review insight records for changed sources', () => {
    const context = createContext();
    databases.push(context.db);
    const source = context.sources.register({
      projectId: 'project-1',
      kind: 'file',
      path: 'docs/changing.md',
      content: 'Original source',
    });
    const oldVersion = context.sources.listVersions('project-1', source.id)[0]!;
    context.sources.register({
      projectId: 'project-1',
      kind: 'file',
      path: 'docs/changing.md',
      content: 'Updated source',
    });
    const page = context.pages.createPageVersion({
      projectId: 'project-1',
      type: 'concept',
      title: 'Changing Concept',
      slug: 'changing-concept',
      content: 'Generated from the old version',
      sourceVersionIds: [oldVersion.id],
      provenance: [{ kind: 'source', id: source.id, confidence: 1 }],
    });
    context.db.prepare(
      `INSERT INTO knowledge_page_links (id, project_id, source_page_id, target_reference, created_at)
       VALUES ('link-1', 'project-1', ?, 'missing-target', ?)`,
    ).run(page.pageId, '2026-09-24T00:10:00.000Z');
    context.graph.upsertGraphNode({
      id: 'page-node' as KnowledgeGraphNodeId,
      projectId: 'project-1',
      nodeType: 'page',
      label: 'Changing Concept',
      sourceKind: 'page',
      sourceId: page.pageId,
    });

    const first = context.reconciliation.reconcileChangedSource(source.id);
    const second = context.reconciliation.reconcileChangedSource(source.id);

    expect(first.stalePageIds).toEqual([page.pageId]);
    expect(second).toMatchObject({ stalePageIds: [], reviewIds: [], insightIds: [] });
    expect(context.pages.getCurrentPage('project-1', page.pageId)?.status).toBe('stale');
    expect(context.db.prepare('SELECT COUNT(*) AS count FROM knowledge_page_links').get()).toEqual({ count: 0 });
    expect(context.graph.listGraphEdges('project-1')).toEqual([]);
    expect(context.db.prepare('SELECT COUNT(*) AS count FROM knowledge_graph_nodes').get()).toEqual({ count: 0 });
    expect(context.db.prepare('SELECT status, summary FROM knowledge_reviews').all()).toEqual([
      {
        status: 'pending',
        summary: `Knowledge page ${page.pageId} references a stale version of source ${source.id}`,
      },
    ]);
    expect(context.db.prepare('SELECT insight_type, confidence FROM knowledge_insights').all()).toEqual([
      { insight_type: 'stale', confidence: 1 },
    ]);
  });

  it('rolls back source status, page status, and review side effects when reconciliation fails', () => {
    const context = createContext();
    databases.push(context.db);
    const source = context.sources.register({
      projectId: 'project-1',
      kind: 'file',
      path: 'docs/rollback.md',
      content: 'Rollback source',
    });
    const version = context.sources.listVersions('project-1', source.id)[0]!;
    const page = context.pages.createPageVersion({
      projectId: 'project-1',
      type: 'source',
      title: 'Rollback Page',
      slug: 'rollback-page',
      content: 'Rollback page content',
      sourceVersionIds: [version.id],
      provenance: [{ kind: 'source', id: source.id, confidence: 1 }],
    });

    expect(() =>
      context.reconciliation.reconcileDeletedSource(source.id, {
        beforeCommit: () => {
          throw new Error('forced rollback');
        },
      }),
    ).toThrow('forced rollback');

    expect(
      context.db.prepare('SELECT status FROM knowledge_sources WHERE id = ?').get(source.id),
    ).toEqual({ status: 'active' });
    expect(context.pages.getCurrentPage('project-1', page.pageId)?.status).toBe('active');
    expect(context.db.prepare('SELECT COUNT(*) AS count FROM knowledge_reviews').get()).toEqual({ count: 0 });
    expect(context.db.prepare('SELECT COUNT(*) AS count FROM knowledge_insights').get()).toEqual({ count: 0 });
  });

  it('does not duplicate page versions, reviews, or insights when deleted-source reconciliation is rerun', () => {
    const context = createContext();
    databases.push(context.db);
    const deletedSource = context.sources.register({
      projectId: 'project-1',
      kind: 'file',
      path: 'docs/deleted.md',
      content: 'Deleted source',
    });
    const sharedSource = context.sources.register({
      projectId: 'project-1',
      kind: 'file',
      path: 'docs/shared.md',
      content: 'Shared source',
    });
    const deletedVersion = context.sources.listVersions('project-1', deletedSource.id)[0]!;
    const sharedVersion = context.sources.listVersions('project-1', sharedSource.id)[0]!;
    const shared = context.pages.createPageVersion({
      projectId: 'project-1',
      type: 'concept',
      title: 'Shared Concept',
      slug: 'shared-concept',
      content: 'Shared concept content',
      sourceVersionIds: [deletedVersion.id, sharedVersion.id],
      provenance: [
        { kind: 'source', id: deletedSource.id, confidence: 0.4 },
        { kind: 'source', id: sharedSource.id, confidence: 0.9 },
      ],
    });

    const first = context.reconciliation.reconcileDeletedSource(deletedSource.id);
    const second = context.reconciliation.reconcileDeletedSource(deletedSource.id);

    expect(first.supersededPageIds).toEqual([shared.pageId]);
    expect(second).toMatchObject({ archivedPageIds: [], supersededPageIds: [], reviewIds: [], insightIds: [] });
    expect(context.pages.listVersions('project-1', shared.pageId as KnowledgePageId)).toHaveLength(2);
    expect(context.db.prepare('SELECT COUNT(*) AS count FROM knowledge_reviews').get()).toEqual({ count: 0 });
    expect(context.db.prepare('SELECT COUNT(*) AS count FROM knowledge_insights').get()).toEqual({ count: 0 });
  });

  it('cleans preserved-page links and surfaces malformed graph evidence without aborting deletion', () => {
    const context = createContext();
    databases.push(context.db);
    const deletedSource = context.sources.register({
      projectId: 'project-1',
      kind: 'file',
      path: 'docs/deleted.md',
      content: 'Deleted source',
    });
    const sharedSource = context.sources.register({
      projectId: 'project-1',
      kind: 'file',
      path: 'docs/shared.md',
      content: 'Shared source',
    });
    const deletedVersion = context.sources.listVersions('project-1', deletedSource.id)[0]!;
    const sharedVersion = context.sources.listVersions('project-1', sharedSource.id)[0]!;
    const shared = context.pages.createPageVersion({
      projectId: 'project-1',
      type: 'concept',
      title: 'Shared Concept',
      slug: 'shared-concept',
      content: 'Shared concept content',
      sourceVersionIds: [deletedVersion.id, sharedVersion.id],
      provenance: [
        { kind: 'source', id: deletedSource.id, confidence: 0.4 },
        { kind: 'source', id: sharedSource.id, confidence: 0.9 },
      ],
    });
    context.db.prepare(
      `INSERT INTO knowledge_page_links (id, project_id, source_page_id, target_reference, created_at)
       VALUES ('link-1', 'project-1', ?, 'possibly-stale', ?)`,
    ).run(shared.pageId, '2026-09-24T00:10:00.000Z');
    context.graph.upsertGraphNode({
      id: 'node-a' as KnowledgeGraphNodeId,
      projectId: 'project-1',
      nodeType: 'page',
      label: 'A',
      sourceKind: 'page',
      sourceId: shared.pageId,
    });
    context.graph.upsertGraphNode({
      id: 'node-b' as KnowledgeGraphNodeId,
      projectId: 'project-1',
      nodeType: 'page',
      label: 'B',
      sourceKind: 'page',
      sourceId: 'other-page',
    });
    context.db.prepare(
      `INSERT INTO knowledge_graph_edges
       (id, project_id, source_node_id, target_node_id, edge_type, evidence_json, confidence, created_at, updated_at)
       VALUES ('bad-edge', 'project-1', 'node-a', 'node-b', 'supports', '{bad json', 1, ?, ?)`,
    ).run('2026-09-24T00:15:00.000Z', '2026-09-24T00:15:00.000Z');

    const result = context.reconciliation.reconcileDeletedSource(deletedSource.id);

    expect(result.supersededPageIds).toEqual([shared.pageId]);
    expect(result.reviewIds).toHaveLength(1);
    expect(context.db.prepare('SELECT COUNT(*) AS count FROM knowledge_page_links').get()).toEqual({ count: 0 });
    expect(context.db.prepare('SELECT status, summary FROM knowledge_reviews').all()).toEqual([
      {
        status: 'pending',
        summary: 'Knowledge graph edge bad-edge has invalid evidence JSON during source reconciliation',
      },
    ]);
    expect(context.db.prepare('SELECT id FROM knowledge_graph_edges').all()).toEqual([{ id: 'bad-edge' }]);
  });
  it('treats the reused older version as current after an A→B→A revert and preserves newest-content behavior', () => {
    const context = createContext();
    databases.push(context.db);
    const register = (content: string) =>
      context.sources.register({ projectId: 'project-1', kind: 'file', path: 'docs/revert.md', content });
    const source = register('A');
    register('B');
    register('A');
    const [versionA, versionB] = context.sources.listVersions('project-1', source.id);
    expect(context.sources.currentVersion('project-1', source.id)?.id).toBe(versionA!.id);
    const pageOnA = context.pages.createPageVersion({
      projectId: 'project-1',
      type: 'source',
      title: 'Page on A',
      slug: 'page-on-a',
      content: 'A content',
      sourceVersionIds: [versionA!.id],
      provenance: [{ kind: 'source', id: source.id, confidence: 1 }],
    });
    const pageOnB = context.pages.createPageVersion({
      projectId: 'project-1',
      type: 'source',
      title: 'Page on B',
      slug: 'page-on-b',
      content: 'B content',
      sourceVersionIds: [versionB!.id],
      provenance: [{ kind: 'source', id: source.id, confidence: 1 }],
    });

    const result = context.reconciliation.reconcileChangedSource(source.id);

    expect(result.stalePageIds).toEqual([pageOnB.pageId]);
    expect(context.pages.getCurrentPage('project-1', pageOnA.pageId)?.status).toBe('active');
    expect(context.pages.getCurrentPage('project-1', pageOnB.pageId)?.status).toBe('stale');
    expect(result.reviewIds).toHaveLength(1);
    expect(result.insightIds).toHaveLength(1);

    register('C');
    const versionC = context.sources.currentVersion('project-1', source.id)!;
    expect(versionC.versionNumber).toBe(3);
    const afterNewest = context.reconciliation.reconcileChangedSource(source.id);
    expect(afterNewest.stalePageIds).toEqual([pageOnA.pageId]);
  });

  it('falls back to the highest version for legacy sources with a NULL current_hash', () => {
    const context = createContext();
    databases.push(context.db);
    const register = (content: string) =>
      context.sources.register({ projectId: 'project-1', kind: 'file', path: 'docs/legacy.md', content });
    const source = register('A');
    register('B');
    const [versionA, versionB] = context.sources.listVersions('project-1', source.id);
    context.db.prepare('UPDATE knowledge_sources SET current_hash = NULL WHERE id = ?').run(source.id);
    const pageOnA = context.pages.createPageVersion({
      projectId: 'project-1',
      type: 'source',
      title: 'Legacy A',
      slug: 'legacy-a',
      content: 'A content',
      sourceVersionIds: [versionA!.id],
      provenance: [{ kind: 'source', id: source.id, confidence: 1 }],
    });
    context.pages.createPageVersion({
      projectId: 'project-1',
      type: 'source',
      title: 'Legacy B',
      slug: 'legacy-b',
      content: 'B content',
      sourceVersionIds: [versionB!.id],
      provenance: [{ kind: 'source', id: source.id, confidence: 1 }],
    });

    const result = context.reconciliation.reconcileChangedSource(source.id);

    expect(result.stalePageIds).toEqual([pageOnA.pageId]);
  });
});
