import type Database from 'better-sqlite3';
import { KnowledgeAnalysisCoverageStore } from './KnowledgeAnalysisCoverageStore.js';
import { KnowledgeAnalyticsSettingsStore } from './KnowledgeHostSettingsStore.js';

export interface KnowledgeSurfaceStatus {
  coverage: {
    supported: number;
    partial: number;
    unsupported: number;
    failed: number;
    legacyUnknown: number;
    deferredRelationships: number;
  };
  graph: {
    nodeCount: number;
    edgeCount: number;
  };
  synthesis: {
    summaryCount: number;
    deterministic: number;
    providerRefined: number;
    fallbackWarning: number;
  };
  analytics: {
    enabled: boolean;
  };
}

interface SummaryStrategyCount {
  strategy: string;
  count: number;
}

function countProjectRows(db: Database.Database, table: 'knowledge_graph_nodes' | 'knowledge_graph_edges', projectId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`).get(projectId) as { count: number }).count;
}

export function getKnowledgeSurfaceStatus(db: Database.Database, projectId: string): KnowledgeSurfaceStatus {
  const scopedProjectId = projectId.trim();
  if (!scopedProjectId) {
    throw new Error('Knowledge surface status project ID must not be empty');
  }
  if (db.prepare('SELECT 1 AS present FROM knowledge_projects WHERE id = ?').get(scopedProjectId) === undefined) {
    throw new Error(`Knowledge project not found: ${scopedProjectId}`);
  }

  const summaryRows = db
    .prepare(
      `SELECT strategy, COUNT(*) AS count
       FROM knowledge_semantic_summaries
       WHERE project_id = ?
       GROUP BY strategy`,
    )
    .all(scopedProjectId) as SummaryStrategyCount[];
  const summaryCounts = new Map(summaryRows.map((row) => [row.strategy, row.count]));

  return {
    coverage: new KnowledgeAnalysisCoverageStore(db).summarize(scopedProjectId),
    graph: {
      nodeCount: countProjectRows(db, 'knowledge_graph_nodes', scopedProjectId),
      edgeCount: countProjectRows(db, 'knowledge_graph_edges', scopedProjectId),
    },
    synthesis: {
      summaryCount: summaryRows.reduce((total, row) => total + row.count, 0),
      deterministic: summaryCounts.get('deterministic') ?? 0,
      providerRefined: summaryCounts.get('provider_refined') ?? 0,
      fallbackWarning: summaryCounts.get('fallback_warning') ?? 0,
    },
    analytics: {
      enabled: new KnowledgeAnalyticsSettingsStore(db).isEnabled(scopedProjectId),
    },
  };
}
