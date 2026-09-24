import { normalizeKnowledgePath } from './KnowledgeIds.js';
import type { KnowledgeEdgeEvidence } from './KnowledgeTypes.js';

export interface GraphImportNode {
  id: string;
  nodeType: string;
  label: string;
  path: string | null;
  metadata: Record<string, unknown>;
}

export interface GraphImportEdge {
  sourceNodeId: string;
  targetNodeId: string;
  edgeType: string;
  evidence: KnowledgeEdgeEvidence;
  inferred: boolean;
  confidence: number;
  metadata: Record<string, unknown>;
}

export interface GraphImportResult {
  nodes: GraphImportNode[];
  edges: GraphImportEdge[];
  rejectedEdges: Array<{ sourceNodeId: string; targetNodeId: string; reason: string }>;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Graphify JSON must be an object');
  return value as UnknownRecord;
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function nodeId(value: UnknownRecord): string {
  return stringValue(value.id ?? value.key ?? value.uid ?? value.name);
}

function endpoint(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') return nodeId(value as UnknownRecord);
  return '';
}

function normalizedPath(value: unknown): string | null {
  const path = stringValue(value);
  if (!path) return null;
  try {
    return normalizeKnowledgePath(path);
  } catch {
    return null;
  }
}

export function importGraphifyJson(input: string | unknown): GraphImportResult {
  const payload = record(typeof input === 'string' ? JSON.parse(input) : input);
  const rawNodes = Array.isArray(payload.nodes) ? payload.nodes : [];
  const nodes: GraphImportNode[] = [];
  const nodeIds = new Set<string>();
  for (const raw of rawNodes) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const value = raw as UnknownRecord;
    const id = nodeId(value);
    if (!id || nodeIds.has(id)) continue;
    const label = stringValue(value.label ?? value.title ?? value.name, id);
    nodes.push({
      id,
      nodeType: stringValue(value.nodeType ?? value.type, 'node'),
      label,
      path: normalizedPath(value.path ?? value.file ?? value.source),
      metadata: { ...value },
    });
    nodeIds.add(id);
  }

  const edges: GraphImportEdge[] = [];
  const rejectedEdges: GraphImportResult['rejectedEdges'] = [];
  const rawEdges = Array.isArray(payload.edges) ? payload.edges : Array.isArray(payload.links) ? payload.links : [];
  for (const raw of rawEdges) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const value = raw as UnknownRecord;
    const sourceNodeId = endpoint(value.source ?? value.from);
    const targetNodeId = endpoint(value.target ?? value.to);
    const reason = !sourceNodeId || !targetNodeId ? 'edge endpoint is missing' : !nodeIds.has(sourceNodeId) || !nodeIds.has(targetNodeId) ? 'edge endpoint is not present in nodes' : sourceNodeId === targetNodeId ? 'self-loop is not allowed' : null;
    if (reason) {
      rejectedEdges.push({ sourceNodeId, targetNodeId, reason });
      continue;
    }
    const inferred = value.inferred === true || value.kind === 'inferred' || value.explicit === false;
    const baseType = stringValue(value.edgeType ?? value.type ?? value.label, 'related_to');
    edges.push({
      sourceNodeId,
      targetNodeId,
      edgeType: inferred && !baseType.startsWith('inferred:') ? `inferred:${baseType}` : baseType,
      evidence: inferred ? 'semantic_relationship' : 'explicit_link',
      inferred,
      confidence: typeof value.confidence === 'number' && Number.isFinite(value.confidence) ? Math.max(0, Math.min(1, value.confidence)) : inferred ? 0.5 : 1,
      metadata: { ...value },
    });
  }
  return { nodes, edges, rejectedEdges };
}
