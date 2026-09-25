import { normalizeKnowledgePath } from './KnowledgeIds.js';
import type { KnowledgeEdgeEvidence, KnowledgeGraphEdgeType, KnowledgeProvenanceRef } from './KnowledgeTypes.js';

type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike };
type UnknownRecord = Record<string, unknown>;

const NATIVE_EDGE_TYPES = new Set<KnowledgeGraphEdgeType>([
  'imports',
  'exports',
  'defines',
  'contains',
  'inherits',
  'implements',
  'calls',
  'references',
  'links_to',
  'related_to',
  'relates_to',
  'link',
  'supports',
]);

const NODE_METADATA_KEYS = new Set(['file', 'id', 'key', 'label', 'name', 'nodeType', 'path', 'source', 'title', 'type', 'uid']);
const EDGE_METADATA_KEYS = new Set([
  'edgeType',
  'explicit',
  'from',
  'id',
  'inferred',
  'kind',
  'label',
  'relation',
  'source',
  'sourceFile',
  'sourceLocation',
  'source_file',
  'source_location',
  'target',
  'to',
  'type',
]);

export interface GraphImportNode {
  id: string;
  nodeType: string;
  label: string;
  path: string | null;
  metadata: Record<string, JsonLike>;
}

export interface GraphImportEdge {
  sourceNodeId: string;
  targetNodeId: string;
  edgeType: KnowledgeGraphEdgeType;
  evidence: KnowledgeEdgeEvidence;
  inferred: boolean;
  confidence: number;
  provenance: KnowledgeProvenanceRef[];
  metadata: Record<string, JsonLike>;
}

export interface GraphImportResult {
  nodes: GraphImportNode[];
  edges: GraphImportEdge[];
  rejectedEdges: Array<{ sourceNodeId: string; targetNodeId: string; reason: string }>;
}

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
  if (value && typeof value === 'object' && !Array.isArray(value)) return nodeId(value as UnknownRecord);
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

function sanitizeJsonLike(value: unknown): JsonLike | undefined {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) {
    const items = value.map((item) => sanitizeJsonLike(item)).filter((item) => item !== undefined);
    return items;
  }
  if (!value || typeof value !== 'object') return undefined;
  const entries = Object.entries(value)
    .map(([key, entry]) => {
      const sanitized = sanitizeJsonLike(entry);
      return sanitized === undefined ? null : ([key, sanitized] as const);
    })
    .filter((entry): entry is readonly [string, JsonLike] => entry !== null);
  return Object.fromEntries(entries);
}

function filteredMetadata(value: UnknownRecord, reservedKeys: ReadonlySet<string>): Record<string, JsonLike> {
  const metadataEntries = Object.entries(value)
    .filter(([key]) => !reservedKeys.has(key))
    .map(([key, entry]) => {
      const sanitized = sanitizeJsonLike(entry);
      return sanitized === undefined ? null : ([key, sanitized] as const);
    })
    .filter((entry): entry is readonly [string, JsonLike] => entry !== null);
  return Object.fromEntries(metadataEntries);
}

function relationType(value: UnknownRecord): { edgeType: KnowledgeGraphEdgeType; originalEdgeType?: string } {
  const candidates = [value.edgeType, value.relation, value.type, value.label]
    .map((candidate) => stringValue(candidate))
    .filter((candidate): candidate is string => candidate.length > 0);
  for (const candidate of candidates) {
    if (NATIVE_EDGE_TYPES.has(candidate as KnowledgeGraphEdgeType)) {
      return { edgeType: candidate as KnowledgeGraphEdgeType };
    }
  }
  return { edgeType: 'related_to', ...(candidates[0] ? { originalEdgeType: candidates[0] } : {}) };
}

function normalizeConfidence(value: unknown, inferred: boolean): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  return inferred ? 0.5 : 1;
}

function parseLineLocation(value: unknown):
  | { parsed: true; startLine: number; endLine: number; startColumn?: number; endColumn?: number }
  | { parsed: false } {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const single = /^L(\d+)$/i.exec(trimmed);
    if (single) {
      const line = Number.parseInt(single[1], 10);
      if (line <= 0) return { parsed: false };
      return { parsed: true, startLine: line, endLine: line };
    }
    const range = /^L(\d+)-L?(\d+)$/i.exec(trimmed);
    if (range) {
      const startLine = Number.parseInt(range[1], 10);
      const endLine = Number.parseInt(range[2], 10);
      if (startLine <= 0 || endLine <= 0 || endLine < startLine) return { parsed: false };
      return {
        parsed: true,
        startLine,
        endLine,
      };
    }
    return { parsed: false };
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) return { parsed: false };
  const candidate = value as UnknownRecord;
  const line = typeof candidate.line === 'number' && Number.isInteger(candidate.line) ? candidate.line : null;
  if (line && line > 0) {
    const column = typeof candidate.column === 'number' && Number.isInteger(candidate.column) && candidate.column > 0 ? candidate.column : undefined;
    return { parsed: true, startLine: line, endLine: line, ...(column !== undefined ? { startColumn: column, endColumn: column } : {}) };
  }

  const startLine = typeof candidate.startLine === 'number' && Number.isInteger(candidate.startLine) ? candidate.startLine : null;
  const endLine = typeof candidate.endLine === 'number' && Number.isInteger(candidate.endLine) ? candidate.endLine : null;
  if (startLine && endLine && startLine > 0 && endLine > 0 && endLine >= startLine) {
    const startColumn =
      typeof candidate.startColumn === 'number' && Number.isInteger(candidate.startColumn) && candidate.startColumn > 0
        ? candidate.startColumn
        : undefined;
    const endColumn =
      typeof candidate.endColumn === 'number' && Number.isInteger(candidate.endColumn) && candidate.endColumn > 0
        ? candidate.endColumn
        : undefined;
    return {
      parsed: true,
      startLine,
      endLine,
      ...(startColumn !== undefined ? { startColumn } : {}),
      ...(endColumn !== undefined ? { endColumn } : {}),
    };
  }

  if (candidate.start && candidate.end && typeof candidate.start === 'object' && typeof candidate.end === 'object') {
    const start = candidate.start as UnknownRecord;
    const end = candidate.end as UnknownRecord;
    const nestedStartLine = typeof start.line === 'number' && Number.isInteger(start.line) ? start.line : null;
    const nestedEndLine = typeof end.line === 'number' && Number.isInteger(end.line) ? end.line : null;
    if (nestedStartLine && nestedEndLine && nestedStartLine > 0 && nestedEndLine > 0 && nestedEndLine >= nestedStartLine) {
      const nestedStartColumn =
        typeof start.column === 'number' && Number.isInteger(start.column) && start.column > 0 ? start.column : undefined;
      const nestedEndColumn =
        typeof end.column === 'number' && Number.isInteger(end.column) && end.column > 0 ? end.column : undefined;
      return {
        parsed: true,
        startLine: nestedStartLine,
        endLine: nestedEndLine,
        ...(nestedStartColumn !== undefined ? { startColumn: nestedStartColumn } : {}),
        ...(nestedEndColumn !== undefined ? { endColumn: nestedEndColumn } : {}),
      };
    }
  }

  return { parsed: false };
}

function buildEdgeProvenance(value: UnknownRecord): {
  provenance: KnowledgeProvenanceRef[];
  unparsedSourceLocation?: JsonLike;
} {
  const sourcePath = normalizedPath(value.source_file ?? value.sourceFile);
  const rawLocation = value.source_location ?? value.sourceLocation;
  if (!sourcePath) {
    return rawLocation === undefined ? { provenance: [] } : { provenance: [], unparsedSourceLocation: sanitizeJsonLike(rawLocation) };
  }
  if (rawLocation === undefined) {
    return {
      provenance: [{ kind: 'file', id: sourcePath, path: sourcePath }],
    };
  }
  const parsedLocation = parseLineLocation(rawLocation);
  if (!parsedLocation.parsed) {
    return {
      provenance: [{ kind: 'file', id: sourcePath, path: sourcePath }],
      unparsedSourceLocation: sanitizeJsonLike(rawLocation),
    };
  }
  return {
    provenance: [
      {
        kind: 'file',
        id: sourcePath,
        path: sourcePath,
        startLine: parsedLocation.startLine,
        endLine: parsedLocation.endLine,
        ...(parsedLocation.startColumn !== undefined ? { startColumn: parsedLocation.startColumn } : {}),
        ...(parsedLocation.endColumn !== undefined ? { endColumn: parsedLocation.endColumn } : {}),
      },
    ],
  };
}

export function importGraphifyJson(input: string | unknown): GraphImportResult {
  let parsedInput: unknown = input;
  if (typeof input === 'string') {
    try {
      parsedInput = JSON.parse(input);
    } catch {
      throw new Error('Graphify JSON must be valid JSON');
    }
  }
  const payload = record(parsedInput);
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
      metadata: filteredMetadata(value, NODE_METADATA_KEYS),
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
    const { edgeType, originalEdgeType } = relationType(value);
    const { provenance, unparsedSourceLocation } = buildEdgeProvenance(value);
    const original = {
      ...filteredMetadata(value, new Set(['from', 'id', 'source', 'target', 'to'])),
    };
    const metadata: Record<string, JsonLike> = {
      ...(Object.keys(original).length > 0 ? { original } : {}),
      ...(originalEdgeType ? { originalEdgeType } : {}),
      ...(unparsedSourceLocation !== undefined ? { unparsedSourceLocation } : {}),
    };
    edges.push({
      sourceNodeId,
      targetNodeId,
      edgeType,
      evidence: inferred ? 'semantic_relationship' : 'explicit_link',
      inferred,
      confidence: normalizeConfidence(value.confidence, inferred),
      provenance,
      metadata,
    });
  }
  return { nodes, edges, rejectedEdges };
}
