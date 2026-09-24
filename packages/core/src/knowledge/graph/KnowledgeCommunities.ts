import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { createKnowledgeId } from '../KnowledgeIds.js';

export interface KnowledgeGraphNode {
  id: string;
  type?: string;
  nodeType?: string;
  label?: string;
  status?: string;
  stale?: boolean;
  [key: string]: unknown;
}

export interface KnowledgeGraphEdge {
  id?: string;
  source: string;
  target: string;
  sourceNodeId?: string;
  targetNodeId?: string;
  weight?: number;
  confidence?: number;
  evidenceType?: string;
  evidence?: string | string[] | Record<string, unknown>;
  [key: string]: unknown;
}

export interface KnowledgeGraphView {
  nodes: readonly KnowledgeGraphNode[];
  edges: readonly KnowledgeGraphEdge[];
}
export type KnowledgeGraphInput = KnowledgeGraphView | {
  nodes?: readonly KnowledgeGraphNode[];
  edges?: readonly KnowledgeGraphEdge[];
  getNodes?: () => readonly KnowledgeGraphNode[];
  getEdges?: () => readonly KnowledgeGraphEdge[];
  listGraphNodes?: (projectId?: string) => readonly KnowledgeGraphNode[];
  listGraphEdges?: (projectId?: string) => readonly KnowledgeGraphEdge[];
};

export interface KnowledgeCommunity {
  id: string;
  nodeIds: string[];
  edgeIds: string[];
  cohesion: number;
  label: string;
}

export interface KnowledgeBridgeNode {
  nodeId: string;
  communityIds: string[];
  score: number;
}

function graphParts(graph: KnowledgeGraphInput): KnowledgeGraphView {
  const candidate = graph as KnowledgeGraphView & {
    getNodes?: () => readonly KnowledgeGraphNode[];
    getEdges?: () => readonly KnowledgeGraphEdge[];
    listGraphNodes?: (projectId?: string) => readonly KnowledgeGraphNode[];
    listGraphEdges?: (projectId?: string) => readonly KnowledgeGraphEdge[];
  };
  const nodes = candidate.nodes ?? candidate.getNodes?.() ?? candidate.listGraphNodes?.() ?? [];
  const edges = candidate.edges ?? candidate.getEdges?.() ?? candidate.listGraphEdges?.() ?? [];
  return {
    nodes: [...nodes],
    edges: edges.map((edge) => ({
      ...edge,
      source: edge.source ?? edge.sourceNodeId ?? '',
      target: edge.target ?? edge.targetNodeId ?? '',
    })),
  };
}

function edgeWeight(edge: KnowledgeGraphEdge): number {
  return Math.max(0, edge.weight ?? edge.confidence ?? 1);
}

function communityId(nodeIds: readonly string[]): string {
  return `community_${createHash('sha256').update(nodeIds.join('\0')).digest('hex').slice(0, 16)}`;
}

/**
 * Detects connected weighted components. This is the deterministic first
 * phase of Louvain: it deliberately avoids random tie-breaking and keeps
 * community membership stable for an unchanged graph snapshot.
 */
export function detectKnowledgeCommunities(graph: KnowledgeGraphInput): KnowledgeCommunity[] {
  const { nodes, edges } = graphParts(graph);
  const parent = new Map(nodes.map((node) => [node.id, node.id]));
  const find = (id: string): string => {
    const root = parent.get(id) ?? id;
    if (root === id) return root;
    const next = find(root);
    parent.set(id, next);
    return next;
  };
  const union = (left: string, right: string): void => {
    if (!parent.has(left) || !parent.has(right) || left === right) return;
    const a = find(left);
    const b = find(right);
    if (a !== b) parent.set([a, b].sort()[1], [a, b].sort()[0]);
  };
  for (const edge of [...edges].sort((a, b) => `${a.source}:${a.target}`.localeCompare(`${b.source}:${b.target}`))) {
    if (edgeWeight(edge) > 0) union(edge.source, edge.target);
  }
  const groups = new Map<string, string[]>();
  for (const node of nodes) {
    const root = find(node.id);
    groups.set(root, [...(groups.get(root) ?? []), node.id]);
  }
  return [...groups.values()]
    .map((ids) => {
      const nodeIds = [...ids].sort();
      const member = new Set(nodeIds);
      const internal = edges.filter((edge) => member.has(edge.source) && member.has(edge.target));
      const possible = nodeIds.length < 2 ? 0 : (nodeIds.length * (nodeIds.length - 1)) / 2;
      const totalWeight = internal.reduce((sum, edge) => sum + edgeWeight(edge), 0);
      const cohesion = possible === 0 ? (internal.length === 0 ? 0 : 1) : Math.min(1, totalWeight / possible);
      return {
        id: communityId(nodeIds),
        nodeIds,
        edgeIds: internal.map((edge) => edge.id ?? `${edge.source}:${edge.target}`).sort(),
        cohesion,
        label: nodeIds.join(', '),
      };
    })
    .sort((a, b) => a.nodeIds[0].localeCompare(b.nodeIds[0]));
}

export function scoreCommunityCohesion(
  community: KnowledgeCommunity,
  graph: KnowledgeGraphInput,
): number {
  return detectKnowledgeCommunities(graph).find((candidate) => candidate.id === community.id)?.cohesion ?? 0;
}

export function findBridgeNodes(
  graph: KnowledgeGraphInput,
  communities = detectKnowledgeCommunities(graph),
): KnowledgeBridgeNode[] {
  const view = graphParts(graph);
  const membership = new Map<string, string>();
  for (const community of communities) for (const nodeId of community.nodeIds) membership.set(nodeId, community.id);
  const neighbors = new Map<string, Set<string>>();
  for (const edge of view.edges) {
    const left = membership.get(edge.source);
    const right = membership.get(edge.target);
    if (!left || !right || left === right) continue;
    neighbors.set(edge.source, new Set([...(neighbors.get(edge.source) ?? []), right]));
    neighbors.set(edge.target, new Set([...(neighbors.get(edge.target) ?? []), left]));
  }
  const candidates = [...neighbors.entries()];
  if (candidates.length === 0 && view.nodes.length > 2) {
    const adjacent = new Map<string, Set<string>>();
    for (const edge of view.edges) {
      adjacent.set(edge.source, new Set([...(adjacent.get(edge.source) ?? []), edge.target]));
      adjacent.set(edge.target, new Set([...(adjacent.get(edge.target) ?? []), edge.source]));
    }
    for (const node of view.nodes) {
      const remaining = new Set(view.nodes.map((item) => item.id).filter((id) => id !== node.id));
      const start = remaining.values().next().value as string | undefined;
      if (!start) continue;
      const seen = new Set([start]);
      const queue = [start];
      while (queue.length) {
        for (const next of adjacent.get(queue.shift() as string) ?? []) {
          if (remaining.has(next) && !seen.has(next)) { seen.add(next); queue.push(next); }
        }
      }
      if (seen.size < remaining.size) candidates.push([node.id, new Set([communities[0].id])]);
    }
  }
  return candidates
    .map(([nodeId, ids]) => ({ nodeId, communityIds: [...ids].sort(), score: Math.min(1, ids.size / Math.max(1, communities.length - 1)) }))
    .sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId));
}

export function persistKnowledgeCommunities(
  db: Database.Database,
  projectId: string,
  snapshotId: string,
  communities: readonly KnowledgeCommunity[],
  createdAt = new Date().toISOString(),
): void {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO knowledge_communities
      (id, project_id, graph_snapshot_id, label, summary, created_at)
     VALUES (@id, @projectId, @snapshotId, @label, @summary, @createdAt)`,
  );
  const transaction = db.transaction(() => {
    for (const community of communities) {
      insert.run({
        id: createKnowledgeId('community', `${snapshotId}:${community.id}`),
        projectId,
        snapshotId,
        label: community.label,
        summary: JSON.stringify({ nodeIds: community.nodeIds, edgeIds: community.edgeIds, cohesion: community.cohesion }),
        createdAt,
      });
    }
  });
  transaction();
}
