import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/db.js';
import { KnowledgeAnalyticsSettingsStore } from '../../src/knowledge/KnowledgeHostSettingsStore.js';
import { KnowledgeSemanticSummaryStore } from '../../src/knowledge/KnowledgeSemanticSummaries.js';
import { getKnowledgeSurfaceStatus } from '../../src/knowledge/KnowledgeSurfaceStatus.js';

describe('getKnowledgeSurfaceStatus', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO knowledge_projects (id, workspace_root, name, status, created_at, updated_at)
       VALUES ('project_a', '/workspace/a', 'A', 'active', ?, ?),
              ('project_b', '/workspace/b', 'B', 'active', ?, ?)`,
    ).run(now, now, now, now);
  });

  afterEach(() => db.close());

  it('returns project-scoped count-only coverage, graph, synthesis, and analytics status', async () => {
    const summaries = new KnowledgeSemanticSummaryStore({ db });
    await summaries.build({ projectId: 'project_a', scopeKind: 'project', scopeId: 'project_a' });
    const fallbackSummary = await summaries.build({
      projectId: 'project_a',
      scopeKind: 'project',
      scopeId: 'project_a',
      providerMode: 'if-available',
    });
    expect(fallbackSummary.strategy).toBe('fallback_warning');
    expect(fallbackSummary.warnings).toEqual([expect.objectContaining({ reason: 'no_profile' })]);
    await summaries.build({ projectId: 'project_b', scopeKind: 'project', scopeId: 'project_b' });
    new KnowledgeAnalyticsSettingsStore(db).enable('project_a');

    expect(getKnowledgeSurfaceStatus(db, 'project_a')).toEqual({
      coverage: {
        supported: 0,
        partial: 0,
        unsupported: 0,
        failed: 0,
        legacyUnknown: 0,
        deferredRelationships: 0,
      },
      graph: { nodeCount: 0, edgeCount: 0 },
      synthesis: {
        summaryCount: 2,
        deterministic: 1,
        providerRefined: 0,
        fallbackWarning: 1,
      },
      analytics: { enabled: true },
    });
    expect(getKnowledgeSurfaceStatus(db, 'project_b').synthesis.summaryCount).toBe(1);
  });

  it('rejects a blank or unknown project rather than reporting empty success', () => {
    expect(() => getKnowledgeSurfaceStatus(db, '  ')).toThrow(/project id/i);
    expect(() => getKnowledgeSurfaceStatus(db, 'project_missing')).toThrow(/not found/i);
  });
});
