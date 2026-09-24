import type { KnowledgeEdgeEvidence, KnowledgeGraphNodeId, KnowledgeProvenanceRef } from '../KnowledgeTypes.js';
import type { KnowledgeGraph, KnowledgeGraphEdgeRecord, KnowledgeGraphNodeRecord } from './KnowledgeGraph.js';

export interface GraphTraversalOptions {
  directed?: boolean;
  maxHops?: number;
  maxNodes?: number;
  maxEdges?: number;
  budget?: number;
}

export interface KnowledgeGraphNeighborhood {
  nodes: KnowledgeGraphNodeRecord[];
  edges: KnowledgeGraphEdgeRecord[];
  truncated: boolean;
}

export interface KnowledgeGraphPath {
  nodeIds: KnowledgeGraphNodeId[];
  nodes: KnowledgeGraphNodeRecord[];
  edges: KnowledgeGraphEdgeRecord[];
  truncated: boolean;
}

export interface TraversalEdgeLike {
  id: string;
  sourceNodeId: KnowledgeGraphNodeId;
  targetNodeId: KnowledgeGraphNodeId;
  edgeType: string;
  evidence: KnowledgeEdgeEvidence[];
  weight: number;
  confidence: number;
  provenance: KnowledgeProvenanceRef[];
}

export function getGraphNeighborhood(
  graph: KnowledgeGraph,
  nodeId: KnowledgeGraphNodeId,
  options: GraphTraversalOptions = {},
): KnowledgeGraphNeighborhood {
  return graph.getGraphNeighborhood(nodeId, options);
}

export function findGraphPath(
  graph: KnowledgeGraph,
  sourceNodeId: KnowledgeGraphNodeId,
  targetNodeId: KnowledgeGraphNodeId,
  options: GraphTraversalOptions = {},
): KnowledgeGraphPath | null {
  return graph.findGraphPath(sourceNodeId, targetNodeId, options);
}
