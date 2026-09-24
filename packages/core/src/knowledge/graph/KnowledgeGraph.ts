import type Database from 'better-sqlite3';
import { createKnowledgeId } from '../KnowledgeIds.js';
import type {
  KnowledgeEdgeEvidence,
  KnowledgeGraphNodeId,
  KnowledgeProvenanceRef,
} from '../KnowledgeTypes.js';
import {
  scoreGraphEdge as calculateGraphEdgeScore,
  type GraphScoringInput,
} from './KnowledgeGraphScoring.js';
import type {
  GraphTraversalOptions,
  KnowledgeGraphNeighborhood,
  KnowledgeGraphPath,
} from './KnowledgeGraphTraversal.js';

export interface UpsertGraphNodeInput {
  id?: KnowledgeGraphNodeId;
  projectId: string;
  nodeType: string;
  label: string;
  sourceKind?: string | null;
  sourceId?: string | null;
  confidence?: number;
}

export interface KnowledgeGraphNodeRecord {
  id: KnowledgeGraphNodeId;
  projectId: string;
  nodeType: string;
  label: string;
  sourceKind: string | null;
  sourceId: string | null;
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertGraphEdgeInput {
  id?: string;
  projectId: string;
  sourceNodeId: KnowledgeGraphNodeId;
  targetNodeId: KnowledgeGraphNodeId;
  edgeType: string;
  evidence: KnowledgeEdgeEvidence | KnowledgeEdgeEvidence[];
  weight?: number;
  confidence?: number;
  provenance?: KnowledgeProvenanceRef[];
}

export interface KnowledgeGraphEdgeRecord {
  id: string;
  projectId: string;
  sourceNodeId: KnowledgeGraphNodeId;
  targetNodeId: KnowledgeGraphNodeId;
  edgeType: string;
  evidence: KnowledgeEdgeEvidence[];
  weight: number;
  confidence: number;
  provenance: KnowledgeProvenanceRef[];
  createdAt: string;
  updatedAt: string;
}

interface NodeRow {
  id: string;
  project_id: string;
  node_type: string;
  label: string;
  source_kind: string | null;
  source_id: string | null;
  confidence: number;
  created_at: string;
  updated_at: string;
}

interface EdgeRow {
  id: string;
  project_id: string;
  source_node_id: string;
  target_node_id: string;
  edge_type: string;
  evidence_json: string;
  confidence: number;
  created_at: string;
  updated_at: string;
}

interface StoredEvidence {
  evidence: KnowledgeEdgeEvidence[];
  weight: number;
  provenance: KnowledgeProvenanceRef[];
}

const EVIDENCE_TYPES = new Set<KnowledgeEdgeEvidence>([
  'explicit_link',
  'shared_source',
  'provenance_overlap',
  'semantic_relationship',
  'contradiction',
  'supersession',
]);

function requireText(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`Knowledge graph ${label} must not be empty`);
}

function validateUnit(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Knowledge graph ${label} must be between 0 and 1`);
  }
}

function normalizeEvidence(evidence: KnowledgeEdgeEvidence | KnowledgeEdgeEvidence[]): KnowledgeEdgeEvidence[] {
  const values = Array.isArray(evidence) ? [...evidence] : [evidence];
  if (values.length === 0 || values.some((value) => !EVIDENCE_TYPES.has(value))) {
    throw new Error('Knowledge graph edge contains unsupported evidence');
  }
  return [...new Set(values)].sort();
}

function toNode(row: NodeRow): KnowledgeGraphNodeRecord {
  return {
    id: row.id as KnowledgeGraphNodeId,
    projectId: row.project_id,
    nodeType: row.node_type,
    label: row.label,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEdge(row: EdgeRow): KnowledgeGraphEdgeRecord {
  const stored = JSON.parse(row.evidence_json) as StoredEvidence;
  return {
    id: row.id,
    projectId: row.project_id,
    sourceNodeId: row.source_node_id as KnowledgeGraphNodeId,
    targetNodeId: row.target_node_id as KnowledgeGraphNodeId,
    edgeType: row.edge_type,
    evidence: stored.evidence,
    weight: stored.weight,
    confidence: row.confidence,
    provenance: stored.provenance,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function edgeOrder(left: KnowledgeGraphEdgeRecord, right: KnowledgeGraphEdgeRecord): number {
  return (
    left.targetNodeId.localeCompare(right.targetNodeId) ||
    left.sourceNodeId.localeCompare(right.sourceNodeId) ||
    left.edgeType.localeCompare(right.edgeType) ||
    left.id.localeCompare(right.id)
  );
}

export class KnowledgeGraph {
  constructor(private readonly db: Database.Database) {}

  upsertGraphNode(input: UpsertGraphNodeInput): KnowledgeGraphNodeRecord {
    requireText(input.projectId, 'project ID');
    requireText(input.nodeType, 'node type');
    requireText(input.label, 'node label');
    const confidence = input.confidence ?? 1;
    validateUnit(confidence, 'confidence');
    const id = input.id ?? (createKnowledgeId('graph-node') as KnowledgeGraphNodeId);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO knowledge_graph_nodes
          (id, project_id, node_type, label, source_kind, source_id, confidence, created_at, updated_at)
         VALUES (@id, @projectId, @nodeType, @label, @sourceKind, @sourceId, @confidence, @now, @now)
         ON CONFLICT(project_id, node_type, source_kind, source_id) DO UPDATE SET
           label = excluded.label, confidence = excluded.confidence, updated_at = excluded.updated_at`,
      )
      .run({
        id,
        projectId: input.projectId,
        nodeType: input.nodeType,
        label: input.label,
        sourceKind: input.sourceKind ?? null,
        sourceId: input.sourceId ?? null,
        confidence,
        now,
      });
    const row = this.db
      .prepare(
        `SELECT * FROM knowledge_graph_nodes
         WHERE project_id = ? AND (id = ? OR (node_type = ? AND source_kind IS ? AND source_id IS ?))
         ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
         LIMIT 1`,
      )
      .get(
        input.projectId,
        id,
        input.nodeType,
        input.sourceKind ?? null,
        input.sourceId ?? null,
        id,
      ) as NodeRow | undefined;
    if (!row) throw new Error(`Knowledge graph node ${id} could not be persisted`);
    return toNode(row);
  }

  upsertGraphEdge(input: UpsertGraphEdgeInput): KnowledgeGraphEdgeRecord {
    requireText(input.projectId, 'project ID');
    requireText(input.sourceNodeId, 'source node ID');
    requireText(input.targetNodeId, 'target node ID');
    requireText(input.edgeType, 'edge type');
    if (input.sourceNodeId === input.targetNodeId) {
      throw new Error('Knowledge graph edges cannot connect a node to itself');
    }
    const source = this.getGraphNode(input.projectId, input.sourceNodeId);
    const target = this.getGraphNode(input.projectId, input.targetNodeId);
    if (!source || !target) throw new Error('Knowledge graph edge endpoints must exist in the same project');
    const evidence = normalizeEvidence(input.evidence);
    const weight = input.weight ?? 1;
    validateUnit(weight, 'weight');
    const confidence = input.confidence ?? 1;
    validateUnit(confidence, 'confidence');
    const provenance = input.provenance ?? [];
    provenance.forEach((reference) => {
      if (reference.confidence !== undefined) validateUnit(reference.confidence, 'provenance confidence');
    });
    const now = new Date().toISOString();
    const id = input.id ?? createKnowledgeId('graph-edge');
    this.db
      .prepare(
        `INSERT INTO knowledge_graph_edges
          (id, project_id, source_node_id, target_node_id, edge_type, evidence_json, confidence, created_at, updated_at)
         VALUES (@id, @projectId, @sourceNodeId, @targetNodeId, @edgeType, @evidenceJson, @confidence, @now, @now)
         ON CONFLICT(project_id, source_node_id, target_node_id, edge_type) DO UPDATE SET
           evidence_json = excluded.evidence_json, confidence = excluded.confidence, updated_at = excluded.updated_at`,
      )
      .run({
        id,
        projectId: input.projectId,
        sourceNodeId: input.sourceNodeId,
        targetNodeId: input.targetNodeId,
        edgeType: input.edgeType,
        evidenceJson: JSON.stringify({ evidence, weight, provenance } satisfies StoredEvidence),
        confidence,
        now,
      });
    const row = this.db
      .prepare(
        `SELECT * FROM knowledge_graph_edges
         WHERE project_id = ? AND source_node_id = ? AND target_node_id = ? AND edge_type = ?`,
      )
      .get(input.projectId, input.sourceNodeId, input.targetNodeId, input.edgeType) as EdgeRow | undefined;
    if (!row) throw new Error(`Knowledge graph edge ${id} could not be persisted`);
    return toEdge(row);
  }

  removeGraphEdge(projectId: string, sourceNodeId: KnowledgeGraphNodeId, targetNodeId: KnowledgeGraphNodeId, edgeType?: string): boolean {
    requireText(projectId, 'project ID');
    const result = this.db
      .prepare(
        `DELETE FROM knowledge_graph_edges
         WHERE project_id = ? AND source_node_id = ? AND target_node_id = ?
           AND (? IS NULL OR edge_type = ?)`,
      )
      .run(projectId, sourceNodeId, targetNodeId, edgeType ?? null, edgeType ?? null);
    return result.changes > 0;
  }

  getGraphNode(projectId: string, nodeId: KnowledgeGraphNodeId): KnowledgeGraphNodeRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM knowledge_graph_nodes WHERE project_id = ? AND id = ?`)
      .get(projectId, nodeId) as NodeRow | undefined;
    return row ? toNode(row) : null;
  }

  listGraphEdges(projectId: string): KnowledgeGraphEdgeRecord[] {
    return (this.db.prepare(`SELECT * FROM knowledge_graph_edges WHERE project_id = ?`).all(projectId) as EdgeRow[])
      .map(toEdge)
      .sort(edgeOrder);
  }

  scoreGraphEdge(edge: KnowledgeGraphEdgeRecord | GraphScoringInput): number {
    return calculateGraphEdgeScore(edge);
  }

  getGraphNeighborhood(
    nodeId: KnowledgeGraphNodeId,
    options: GraphTraversalOptions & { projectId?: string } = {},
  ): KnowledgeGraphNeighborhood {
    const projectId = options.projectId ?? this.findProjectForNode(nodeId);
    if (!projectId) throw new Error(`Knowledge graph node ${nodeId} does not exist`);
    const maxHops = options.maxHops ?? 2;
    const maxNodes = options.maxNodes ?? options.budget ?? Number.MAX_SAFE_INTEGER;
    const maxEdges = options.maxEdges ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isInteger(maxHops) || maxHops < 0 || !Number.isInteger(maxNodes) || maxNodes < 1) {
      throw new Error('Knowledge graph traversal bounds must be positive integers');
    }
    const allNodes = new Map<string, KnowledgeGraphNodeRecord>();
    const allEdges = this.listGraphEdges(projectId);
    const distances = new Map<string, number>([[nodeId, 0]]);
    const queue = [nodeId];
    let exploredEdges = 0;
    let truncated = false;
    while (queue.length > 0) {
      const current = queue.shift() as string;
      const distance = distances.get(current) as number;
      allNodes.set(current, this.getGraphNode(projectId, current as KnowledgeGraphNodeId) as KnowledgeGraphNodeRecord);
      if (distance >= maxHops) continue;
      const adjacent = this.adjacentEdges(current, allEdges, options.directed ?? true);
      for (const edge of adjacent) {
        if (exploredEdges >= maxEdges) {
          truncated = true;
          break;
        }
        exploredEdges += 1;
        const next = edge.sourceNodeId === current ? edge.targetNodeId : edge.sourceNodeId;
        if (!distances.has(next)) {
          if (distances.size >= maxNodes) {
            truncated = true;
            break;
          }
          distances.set(next, distance + 1);
          queue.push(next);
        }
      }
    }
    const nodes = [...allNodes.values()].sort((a, b) => a.id.localeCompare(b.id));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = allEdges.filter((edge) => nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId)).slice(0, maxEdges);
    return { nodes, edges, truncated };
  }

  findGraphPath(
    sourceNodeId: KnowledgeGraphNodeId,
    targetNodeId: KnowledgeGraphNodeId,
    options: GraphTraversalOptions & { projectId?: string } = {},
  ): KnowledgeGraphPath | null {
    const projectId = options.projectId ?? this.findProjectForNode(sourceNodeId);
    if (!projectId || !this.getGraphNode(projectId, targetNodeId)) return null;
    const maxHops = options.maxHops ?? 2;
    const maxNodes = options.maxNodes ?? options.budget ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isInteger(maxHops) || maxHops < 0 || !Number.isInteger(maxNodes) || maxNodes < 1) {
      throw new Error('Knowledge graph traversal bounds must be positive integers');
    }
    const edges = this.listGraphEdges(projectId);
    const queue = [sourceNodeId];
    const previous = new Map<string, { node: string; edge: KnowledgeGraphEdgeRecord }>();
    const distance = new Map<string, number>([[sourceNodeId, 0]]);
    let exploredEdges = 0;
    while (queue.length > 0 && distance.size <= maxNodes) {
      const current = queue.shift() as string;
      if (current === targetNodeId) break;
      if ((distance.get(current) as number) >= maxHops) continue;
      for (const edge of this.adjacentEdges(current, edges, options.directed ?? true)) {
        if (exploredEdges >= (options.maxEdges ?? Number.MAX_SAFE_INTEGER)) return null;
        exploredEdges += 1;
        const next = edge.sourceNodeId === current ? edge.targetNodeId : edge.sourceNodeId;
        if (!distance.has(next)) {
          distance.set(next, (distance.get(current) as number) + 1);
          previous.set(next, { node: current, edge });
          queue.push(next);
        }
      }
    }
    if (!distance.has(targetNodeId)) return null;
    const nodeIds: KnowledgeGraphNodeId[] = [];
    const pathEdges: KnowledgeGraphEdgeRecord[] = [];
    let current: string = targetNodeId;
    while (current !== sourceNodeId) {
      nodeIds.unshift(current as KnowledgeGraphNodeId);
      const step = previous.get(current);
      if (!step) return null;
      pathEdges.unshift(step.edge);
      current = step.node;
    }
    nodeIds.unshift(sourceNodeId as KnowledgeGraphNodeId);
    return {
      nodeIds,
      nodes: nodeIds.map((id) => this.getGraphNode(projectId, id) as KnowledgeGraphNodeRecord),
      edges: pathEdges,
      truncated: false,
    };
  }

  private findProjectForNode(nodeId: KnowledgeGraphNodeId): string | null {
    const row = this.db.prepare(`SELECT project_id FROM knowledge_graph_nodes WHERE id = ?`).get(nodeId) as
      | { project_id: string }
      | undefined;
    return row?.project_id ?? null;
  }

  private adjacentEdges(
    nodeId: string,
    edges: KnowledgeGraphEdgeRecord[],
    directed: boolean,
  ): KnowledgeGraphEdgeRecord[] {
    return edges
      .filter((edge) => edge.sourceNodeId === nodeId || (!directed && edge.targetNodeId === nodeId))
      .sort(edgeOrder);
  }
}

export { calculateGraphEdgeScore as scoreGraphEdge };
