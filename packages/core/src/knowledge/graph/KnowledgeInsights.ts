import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createKnowledgeId } from '../KnowledgeIds.js';
import type { KnowledgeCommunity, KnowledgeGraphEdge, KnowledgeGraphInput, KnowledgeGraphView } from './KnowledgeCommunities.js';
import { detectKnowledgeCommunities, findBridgeNodes } from './KnowledgeCommunities.js';

export type KnowledgeInsightType = 'bridge' | 'sparse' | 'orphan' | 'contradiction' | 'stale';
export type KnowledgeInsightAction = 'review' | 'merge' | 'regenerate' | 'research' | 'create_task';

export interface KnowledgeInsight {
  id?: string;
  type: KnowledgeInsightType;
  confidence: number;
  nodeIds: string[];
  evidence: Array<{ kind: string; id: string; detail?: string }>;
  actions: KnowledgeInsightAction[];
  fingerprint?: string;
}

function insightFingerprint(insight: Omit<KnowledgeInsight, 'id' | 'fingerprint'>): string {
  return createHash('sha256').update(JSON.stringify({
    type: insight.type,
    nodeIds: [...insight.nodeIds].sort(),
    evidence: insight.evidence,
  })).digest('hex').slice(0, 24);
}

export function findSparseCommunities(
  communities: readonly KnowledgeCommunity[],
  threshold = 0.25,
): KnowledgeInsight[] {
  return communities.filter((community) => community.cohesion < threshold).map((community) => ({
    type: 'sparse',
    confidence: Math.min(1, 1 - community.cohesion),
    nodeIds: [...community.nodeIds].sort(),
    evidence: [{ kind: 'community', id: community.id, detail: `cohesion=${community.cohesion}` }],
    actions: ['research', 'create_task'],
  }));
}

function asView(graph: KnowledgeGraphInput): KnowledgeGraphView {
  const candidate = graph as KnowledgeGraphView & {
    getNodes?: () => readonly KnowledgeGraphView['nodes'][number][];
    getEdges?: () => readonly KnowledgeGraphView['edges'][number][];
    listGraphNodes?: () => readonly KnowledgeGraphView['nodes'][number][];
    listGraphEdges?: () => readonly KnowledgeGraphView['edges'][number][];
  };
  return {
    nodes: candidate.nodes ?? candidate.getNodes?.() ?? candidate.listGraphNodes?.() ?? [],
    edges: candidate.edges ?? candidate.getEdges?.() ?? candidate.listGraphEdges?.() ?? [],
  };
}

export function findOrphanPages(graph: KnowledgeGraphInput): KnowledgeInsight[] {
  const view = asView(graph);
  const nodes = view.nodes.filter((node) => node.type === 'page' || node.nodeType === 'page' || node.kind === 'page');
  const connected = new Set(view.edges.flatMap((edge) => [edge.source ?? edge.sourceNodeId, edge.target ?? edge.targetNodeId]));
  return nodes.filter((node) => !connected.has(node.id)).map((node) => ({
    type: 'orphan',
    confidence: 1,
    nodeIds: [node.id],
    evidence: [{ kind: 'graph_node', id: node.id }],
    actions: ['review', 'research'],
  }));
}

function isContradiction(edge: KnowledgeGraphEdge): boolean {
  const values = [edge.evidenceType, typeof edge.evidence === 'string' ? edge.evidence : undefined].filter(Boolean).join(' ').toLowerCase();
  return values.includes('contradict');
}

export function findContradictions(graph: KnowledgeGraphInput): KnowledgeInsight[] {
  return asView(graph).edges.filter(isContradiction).map((edge) => ({
    type: 'contradiction',
    confidence: edge.confidence ?? 1,
    nodeIds: [edge.source, edge.target].sort(),
    evidence: [{ kind: edge.evidenceType ?? 'contradiction', id: edge.id ?? `${edge.source}:${edge.target}` }],
    actions: ['review', 'research'],
  }));
}

export function findStalePages(graph: KnowledgeGraphInput, now = Date.now(), maxAgeMs = 30 * 24 * 60 * 60 * 1000): KnowledgeInsight[] {
  return asView(graph).nodes.filter((node) => {
    if (node.type !== 'page' && node.nodeType !== 'page' && node.kind !== 'page') return false;
    if (node.stale === true || node.status === 'stale') return true;
    const updated = node.updatedAt ?? node.updated_at;
    return typeof updated === 'string' && now - Date.parse(updated) > maxAgeMs;
  }).map((node) => ({
    type: 'stale',
    confidence: 1,
    nodeIds: [node.id],
    evidence: [{ kind: 'graph_node', id: node.id, detail: 'page requires refresh' }],
    actions: ['regenerate', 'review'],
  }));
}

export function detectKnowledgeInsights(graph: KnowledgeGraphInput, communities = detectKnowledgeCommunities(graph)): KnowledgeInsight[] {
  const bridge = findBridgeNodes(graph, communities).map((node) => ({
    type: 'bridge' as const,
    confidence: node.score,
    nodeIds: [node.nodeId],
    evidence: node.communityIds.map((id) => ({ kind: 'community', id })),
    actions: ['review', 'research'] as KnowledgeInsightAction[],
  }));
  return [...bridge, ...findSparseCommunities(communities), ...findOrphanPages(graph), ...findContradictions(graph), ...findStalePages(graph)]
    .map((insight) => ({ ...insight, fingerprint: insightFingerprint(insight) }))
    .sort((a, b) => `${a.type}:${a.nodeIds.join(',')}`.localeCompare(`${b.type}:${b.nodeIds.join(',')}`));
}

export function persistKnowledgeInsights(
  db: Database.Database,
  projectId: string,
  snapshotId: string,
  insights: readonly KnowledgeInsight[],
  contentPath = 'knowledge-insights.json',
  createdAt = new Date().toISOString(),
): KnowledgeInsight[] {
  const result: KnowledgeInsight[] = [];
  const select = db.prepare(
    `SELECT id FROM knowledge_insights WHERE project_id = ? AND graph_snapshot_id = ? AND insight_type = ? AND content_path = ?`,
  );
  const insert = db.prepare(
    `INSERT INTO knowledge_insights (id, project_id, graph_snapshot_id, insight_type, content_path, confidence, created_at)
     VALUES (@id, @projectId, @snapshotId, @type, @contentPath, @confidence, @createdAt)`,
  );
  const transaction = db.transaction(() => {
    for (const input of insights) {
      const fingerprint = input.fingerprint ?? insightFingerprint(input);
      const path = `${contentPath}#${fingerprint}`;
      const existing = select.get(projectId, snapshotId, input.type, path) as { id: string } | undefined;
      const id = existing?.id ?? createKnowledgeId('insight', `${projectId}:${snapshotId}:${fingerprint}`);
      if (!existing) insert.run({ id, projectId, snapshotId, type: input.type, contentPath: path, confidence: input.confidence, createdAt });
      result.push({ ...input, id, fingerprint });
    }
  });
  transaction();
  return result;
}
