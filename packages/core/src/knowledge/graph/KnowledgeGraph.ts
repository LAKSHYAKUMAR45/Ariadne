import type Database from 'better-sqlite3';
import type { KnowledgeSourceSpan } from '../KnowledgeExtraction.js';
import { createKnowledgeId, normalizeKnowledgePath } from '../KnowledgeIds.js';
import {
  sanitizeProvenanceMetadata,
  stableGraphJsonStringify,
} from '../GraphMetadata.js';
import type {
  KnowledgeEdgeEvidence,
  KnowledgeGraphEdgeType,
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
  qualifiedName?: string | null;
  sourceVersionId?: string | null;
  span?: KnowledgeSourceSpan | null;
  confidence?: number;
}

export interface KnowledgeGraphNodeRecord {
  id: KnowledgeGraphNodeId;
  projectId: string;
  nodeType: string;
  label: string;
  sourceKind: string | null;
  sourceId: string | null;
  qualifiedName: string | null;
  sourceVersionId: string | null;
  provenanceSourceId: string | null;
  provenanceSourcePath: string | null;
  span: KnowledgeSourceSpan | null;
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertGraphEdgeInput {
  id?: string;
  projectId: string;
  sourceNodeId: KnowledgeGraphNodeId;
  targetNodeId: KnowledgeGraphNodeId;
  edgeType: KnowledgeGraphEdgeType;
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
  edgeType: KnowledgeGraphEdgeType;
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
  qualified_name: string | null;
  source_version_id: string | null;
  start_offset: number | null;
  end_offset: number | null;
  start_line: number | null;
  start_column: number | null;
  end_line: number | null;
  end_column: number | null;
  span_label: string | null;
  provenance_source_id: string | null;
  provenance_source_path: string | null;
  confidence: number;
  created_at: string;
  updated_at: string;
}

interface EdgeRow {
  id: string;
  project_id: string;
  source_node_id: string;
  target_node_id: string;
  edge_type: KnowledgeGraphEdgeType;
  evidence_json: string;
  confidence: number;
  created_at: string;
  updated_at: string;
}

interface StoredEvidence {
  evidence?: KnowledgeEdgeEvidence[];
  weight?: number;
  provenance?: KnowledgeProvenanceRef[];
}

const EVIDENCE_TYPES = new Set<KnowledgeEdgeEvidence>([
  'explicit_link',
  'shared_source',
  'provenance_overlap',
  'semantic_relationship',
  'contradiction',
  'supersession',
]);

const EDGE_TYPES = new Set<KnowledgeGraphEdgeType>([
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

const NODE_SELECT_SQL = `SELECT nodes.*,
  versions.source_id AS provenance_source_id,
  sources.source_path AS provenance_source_path
 FROM knowledge_graph_nodes nodes
 LEFT JOIN knowledge_source_versions versions
   ON versions.project_id = nodes.project_id
  AND versions.id = nodes.source_version_id
 LEFT JOIN knowledge_sources sources
   ON sources.project_id = versions.project_id
  AND sources.id = versions.source_id`;

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

function normalizeSpan(span: KnowledgeSourceSpan | null | undefined): KnowledgeSourceSpan | null {
  if (!span) return null;
  return { ...span };
}

function normalizeProvenance(
  provenance: readonly KnowledgeProvenanceRef[],
  context: string,
  hydrateSourcePath?: (reference: KnowledgeProvenanceRef) => string | null,
): KnowledgeProvenanceRef[] {
  return [...provenance]
    .map((reference, index) => {
      const normalized =
        reference.kind === 'file'
          ? {
              ...reference,
              id: normalizeKnowledgePath(reference.id),
              ...(reference.path ? { path: normalizeKnowledgePath(reference.path) } : {}),
            }
          : {
              ...reference,
            };
      const metadata = reference.metadata
        ? sanitizeProvenanceMetadata(reference.metadata, `${context} reference ${index + 1} metadata`)
        : undefined;
      return {
        ...normalized,
        ...(reference.kind === 'source'
          ? (() => {
              const authoritativePath = hydrateSourcePath?.(normalized as KnowledgeProvenanceRef) ?? null;
              if (authoritativePath) {
                return { path: authoritativePath };
              }
              return reference.path ? { path: reference.path } : {};
            })()
          : {}),
        ...(metadata ? { metadata } : {}),
      };
    })
    .sort(
      (left, right) =>
        left.id.localeCompare(right.id) ||
        (left.startOffset ?? Number.MAX_SAFE_INTEGER) - (right.startOffset ?? Number.MAX_SAFE_INTEGER) ||
        (left.endOffset ?? Number.MAX_SAFE_INTEGER) - (right.endOffset ?? Number.MAX_SAFE_INTEGER) ||
        (left.startLine ?? Number.MAX_SAFE_INTEGER) - (right.startLine ?? Number.MAX_SAFE_INTEGER) ||
        (left.startColumn ?? Number.MAX_SAFE_INTEGER) - (right.startColumn ?? Number.MAX_SAFE_INTEGER) ||
        stableGraphJsonStringify(left.metadata ?? {}, `${context} left metadata`).localeCompare(
          stableGraphJsonStringify(right.metadata ?? {}, `${context} right metadata`),
        ),
    );
}

function toNode(row: NodeRow): KnowledgeGraphNodeRecord {
  const span =
    row.start_offset !== null &&
    row.end_offset !== null &&
    row.start_line !== null &&
    row.start_column !== null &&
    row.end_line !== null &&
    row.end_column !== null
      ? {
          startOffset: row.start_offset,
          endOffset: row.end_offset,
          startLine: row.start_line,
          startColumn: row.start_column,
          endLine: row.end_line,
          endColumn: row.end_column,
          ...(row.span_label ? { label: row.span_label } : {}),
        }
      : null;
  return {
    id: row.id as KnowledgeGraphNodeId,
    projectId: row.project_id,
    nodeType: row.node_type,
    label: row.label,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    qualifiedName: row.qualified_name,
    sourceVersionId: row.source_version_id,
    provenanceSourceId: row.provenance_source_id,
    provenanceSourcePath: row.provenance_source_path,
    span,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseStoredEvidence(
  value: string,
  edgeId: string,
  hydrateSourcePath?: (reference: KnowledgeProvenanceRef) => string | null,
): Required<StoredEvidence> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { evidence: [], weight: 1, provenance: [] };
    }
    const stored = parsed as StoredEvidence;
    return {
      evidence: Array.isArray(stored.evidence) ? stored.evidence.filter((entry): entry is KnowledgeEdgeEvidence => EVIDENCE_TYPES.has(entry as KnowledgeEdgeEvidence)) : [],
      weight: typeof stored.weight === 'number' && Number.isFinite(stored.weight) ? stored.weight : 1,
      provenance: Array.isArray(stored.provenance)
        ? normalizeProvenance(stored.provenance, `Knowledge graph edge ${edgeId} stored provenance`, hydrateSourcePath)
        : [],
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes('Knowledge graph edge')) {
      throw error;
    }
    if (error instanceof Error && !error.message.includes('Unexpected token')) {
      throw new Error(`Knowledge graph edge ${edgeId} has invalid stored evidence: ${error.message}`);
    }
    return { evidence: [], weight: 1, provenance: [] };
  }
}

function toEdge(
  row: EdgeRow,
  hydrateSourcePath?: (reference: KnowledgeProvenanceRef) => string | null,
): KnowledgeGraphEdgeRecord {
  const stored = parseStoredEvidence(row.evidence_json, row.id, hydrateSourcePath);
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

  sourceVersionExists(projectId: string, sourceId: string, sourceVersionId: string): boolean {
    requireText(projectId, 'project ID');
    requireText(sourceId, 'source ID');
    requireText(sourceVersionId, 'source version ID');
    const row = this.db
      .prepare(
        `SELECT 1
         FROM knowledge_source_versions versions
         JOIN knowledge_sources sources
           ON sources.project_id = versions.project_id
          AND sources.id = versions.source_id
         WHERE versions.project_id = ? AND sources.id = ? AND versions.id = ?
         LIMIT 1`,
      )
      .get(projectId, sourceId, sourceVersionId) as { 1: number } | undefined;
    return row !== undefined;
  }

  sourceVersionBelongsToProject(projectId: string, sourceVersionId: string): boolean {
    requireText(projectId, 'project ID');
    requireText(sourceVersionId, 'source version ID');
    const row = this.db
      .prepare(
        `SELECT 1
         FROM knowledge_source_versions
         WHERE project_id = ? AND id = ?
         LIMIT 1`,
      )
      .get(projectId, sourceVersionId) as { 1: number } | undefined;
    return row !== undefined;
  }


  filePathBelongsToProject(projectId: string, filePath: string): boolean {
    requireText(projectId, 'project ID');
    const normalizedPath = normalizeKnowledgePath(filePath);
    const sourceMatch = this.db
      .prepare(
        `SELECT 1
         FROM knowledge_sources
         WHERE project_id = ? AND source_path = ?
         LIMIT 1`,
      )
      .get(projectId, normalizedPath) as { 1: number } | undefined;
    return sourceMatch !== undefined;
  }

  sourceExistsInProject(projectId: string, sourceId: string): boolean {
    requireText(projectId, 'project ID');
    requireText(sourceId, 'source ID');
    const row = this.db
      .prepare(
        `SELECT 1
         FROM knowledge_sources
         WHERE project_id = ? AND id = ?
         LIMIT 1`,
      )
      .get(projectId, sourceId) as { 1: number } | undefined;
    return row !== undefined;
  }

  private lookupAuthoritativeSourcePath(
    projectId: string,
    sourceId: string,
    sourceVersionId?: string | null,
    strict = true,
  ): string | null {
    const byVersion = sourceVersionId
      ? ((this.db
          .prepare(
            `SELECT sources.source_path
             FROM knowledge_source_versions versions
             JOIN knowledge_sources sources
               ON sources.project_id = versions.project_id
              AND sources.id = versions.source_id
             WHERE versions.project_id = ? AND versions.source_id = ? AND versions.id = ?
             LIMIT 1`,
          )
          .get(projectId, sourceId, sourceVersionId) as { source_path: string | null } | undefined) ?? null)
      : null;
    if (sourceVersionId && byVersion === null) {
      if (!strict) return null;
      throw new Error(`Knowledge graph provenance source ${sourceId}/${sourceVersionId} must belong to project ${projectId}`);
    }
    if (byVersion) {
      return byVersion.source_path ? normalizeKnowledgePath(byVersion.source_path) : null;
    }
    const bySource = this.db
      .prepare(
        `SELECT source_path
         FROM knowledge_sources
         WHERE project_id = ? AND id = ?
         LIMIT 1`,
      )
      .get(projectId, sourceId) as { source_path: string | null } | undefined;
    if (!bySource) {
      if (!strict) return null;
      throw new Error(`Knowledge graph provenance source ${sourceId} must belong to project ${projectId}`);
    }
    return bySource.source_path ? normalizeKnowledgePath(bySource.source_path) : null;
  }

  findUniqueGraphNodeId(
    projectId: string,
    reference: string,
    options: { sourceKind?: string } = {},
  ): KnowledgeGraphNodeId | null {
    requireText(projectId, 'project ID');
    requireText(reference, 'reference');
    const sourceKindClause = options.sourceKind ? 'AND nodes.source_kind = @sourceKind' : '';
    const versionPresenceClause = options.sourceKind === 'deterministic_symbol' ? 'AND nodes.source_version_id IS NOT NULL' : '';
    const latestVersionClause = `
      AND (
        nodes.source_version_id IS NULL OR versions.version_number = (
          SELECT MAX(latest.version_number)
          FROM knowledge_source_versions latest
          WHERE latest.project_id = versions.project_id AND latest.source_id = versions.source_id
        )
      )`;
    const byQualifiedName = this.db
      .prepare(
        `SELECT nodes.id
         FROM knowledge_graph_nodes nodes
         LEFT JOIN knowledge_source_versions versions
           ON versions.project_id = nodes.project_id
          AND versions.id = nodes.source_version_id
         WHERE nodes.project_id = @projectId AND nodes.qualified_name = @reference ${sourceKindClause} ${versionPresenceClause} ${latestVersionClause}
         ORDER BY nodes.id ASC
         LIMIT 2`,
      )
      .all({ projectId, reference, sourceKind: options.sourceKind ?? null }) as Array<{ id: string }>;
    if (byQualifiedName.length === 1) return byQualifiedName[0].id as KnowledgeGraphNodeId;
    if (byQualifiedName.length > 1) return null;
    const byLabel = this.db
      .prepare(
        `SELECT nodes.id
         FROM knowledge_graph_nodes nodes
         LEFT JOIN knowledge_source_versions versions
           ON versions.project_id = nodes.project_id
          AND versions.id = nodes.source_version_id
         WHERE nodes.project_id = @projectId AND nodes.label = @reference ${sourceKindClause} ${versionPresenceClause} ${latestVersionClause}
         ORDER BY nodes.id ASC
         LIMIT 2`,
      )
      .all({ projectId, reference, sourceKind: options.sourceKind ?? null }) as Array<{ id: string }>;
    return byLabel.length === 1 ? (byLabel[0].id as KnowledgeGraphNodeId) : null;
  }

  runInTransaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  removeMaterializedSourceVersion(projectId: string, sourceVersionId: string): void {
    requireText(projectId, 'project ID');
    requireText(sourceVersionId, 'source version ID');
    this.db
      .prepare(
        `DELETE FROM knowledge_graph_nodes
         WHERE project_id = ? AND source_kind = 'deterministic_symbol' AND source_version_id = ?`,
      )
      .run(projectId, sourceVersionId);
  }

  upsertGraphNode(input: UpsertGraphNodeInput): KnowledgeGraphNodeRecord {
    requireText(input.projectId, 'project ID');
    requireText(input.nodeType, 'node type');
    requireText(input.label, 'node label');
    const confidence = input.confidence ?? 1;
    validateUnit(confidence, 'confidence');
    if (input.sourceVersionId && !this.sourceVersionBelongsToProject(input.projectId, input.sourceVersionId)) {
      throw new Error(`Knowledge graph source version ${input.sourceVersionId} must belong to project ${input.projectId}`);
    }
    const existingById = input.id
      ? ((this.db.prepare(`SELECT * FROM knowledge_graph_nodes WHERE id = ? LIMIT 1`).get(input.id) as NodeRow | undefined) ?? null)
      : null;
    if (existingById && existingById.project_id !== input.projectId) {
      throw new Error(`Knowledge graph node ${input.id} already belongs to another project`);
    }
    const existingBySource =
      input.sourceKind !== undefined && input.sourceKind !== null && input.sourceId !== undefined && input.sourceId !== null
        ? ((this.db
            .prepare(
              `SELECT * FROM knowledge_graph_nodes
               WHERE project_id = ? AND node_type = ? AND source_kind = ? AND source_id = ?
               LIMIT 1`,
            )
            .get(input.projectId, input.nodeType, input.sourceKind, input.sourceId) as NodeRow | undefined) ?? null)
        : null;
    const id = (input.id ?? existingBySource?.id ?? createKnowledgeId('graph-node')) as KnowledgeGraphNodeId;
    const now = new Date().toISOString();
    const span = normalizeSpan(input.span);
    this.db
      .prepare(
        `INSERT INTO knowledge_graph_nodes
          (
            id,
            project_id,
            node_type,
            label,
            source_kind,
            source_id,
            qualified_name,
            source_version_id,
            start_offset,
            end_offset,
            start_line,
            start_column,
            end_line,
            end_column,
            span_label,
            confidence,
            created_at,
            updated_at
          )
         VALUES (
            @id,
            @projectId,
            @nodeType,
            @label,
            @sourceKind,
            @sourceId,
            @qualifiedName,
            @sourceVersionId,
            @startOffset,
            @endOffset,
            @startLine,
            @startColumn,
            @endLine,
            @endColumn,
            @spanLabel,
            @confidence,
            @createdAt,
            @updatedAt
         )
         ON CONFLICT(id) DO UPDATE SET
           node_type = excluded.node_type,
           label = excluded.label,
           source_kind = excluded.source_kind,
           source_id = excluded.source_id,
           qualified_name = excluded.qualified_name,
           source_version_id = excluded.source_version_id,
           start_offset = excluded.start_offset,
           end_offset = excluded.end_offset,
           start_line = excluded.start_line,
           start_column = excluded.start_column,
           end_line = excluded.end_line,
           end_column = excluded.end_column,
           span_label = excluded.span_label,
           confidence = excluded.confidence,
           updated_at = excluded.updated_at`,
      )
      .run({
        id,
        projectId: input.projectId,
        nodeType: input.nodeType,
        label: input.label,
        sourceKind: input.sourceKind ?? null,
        sourceId: input.sourceId ?? null,
        qualifiedName: input.qualifiedName ?? null,
        sourceVersionId: input.sourceVersionId ?? null,
        startOffset: span?.startOffset ?? null,
        endOffset: span?.endOffset ?? null,
        startLine: span?.startLine ?? null,
        startColumn: span?.startColumn ?? null,
        endLine: span?.endLine ?? null,
        endColumn: span?.endColumn ?? null,
        spanLabel: span?.label ?? null,
        confidence,
        createdAt: existingBySource?.created_at ?? now,
        updatedAt: now,
      });
    const row = this.db
      .prepare(`${NODE_SELECT_SQL} WHERE nodes.project_id = ? AND nodes.id = ? LIMIT 1`)
      .get(input.projectId, id) as NodeRow | undefined;
    if (!row) throw new Error(`Knowledge graph node ${id} could not be persisted`);
    return toNode(row);
  }

  upsertGraphEdge(input: UpsertGraphEdgeInput): KnowledgeGraphEdgeRecord {
    requireText(input.projectId, 'project ID');
    requireText(input.sourceNodeId, 'source node ID');
    requireText(input.targetNodeId, 'target node ID');
    requireText(input.edgeType, 'edge type');
    if (!EDGE_TYPES.has(input.edgeType)) throw new Error(`Knowledge graph edge type is unsupported: ${input.edgeType}`);
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
    const provenance = normalizeProvenance(
      input.provenance ?? [],
      `Knowledge graph edge ${input.edgeType} provenance`,
      (reference) => this.lookupAuthoritativeSourcePath(input.projectId, reference.id, reference.sourceVersionId),
    );
    provenance.forEach((reference) => {
      if (reference.confidence !== undefined) validateUnit(reference.confidence, 'provenance confidence');
      if (reference.kind !== 'source' && reference.kind !== 'file') {
        throw new Error(`Knowledge graph provenance kind is unsupported on graph edges: ${reference.kind}`);
      }
      if (reference.kind === 'source') {
        this.lookupAuthoritativeSourcePath(input.projectId, reference.id, reference.sourceVersionId);
      }
      if (reference.kind === 'file') {
        const normalizedId = normalizeKnowledgePath(reference.id);
        if (reference.path && normalizeKnowledgePath(reference.path) !== normalizedId) {
          throw new Error('Knowledge graph file provenance path must match its normalized identifier');
        }
        if (!this.filePathBelongsToProject(input.projectId, normalizedId)) {
          throw new Error(`Knowledge graph file provenance ${normalizedId} must belong to project ${input.projectId}`);
        }
      }
    });
    const existingEdge =
      input.id === undefined
        ? ((this.db
            .prepare(
              `SELECT id FROM knowledge_graph_edges
               WHERE project_id = ? AND source_node_id = ? AND target_node_id = ? AND edge_type = ?
               LIMIT 1`,
            )
            .get(input.projectId, input.sourceNodeId, input.targetNodeId, input.edgeType) as { id: string } | undefined) ?? null)
        : null;
    const now = new Date().toISOString();
    const id = input.id ?? existingEdge?.id ?? createKnowledgeId('graph-edge');
    this.db
      .prepare(
        `INSERT INTO knowledge_graph_edges
          (id, project_id, source_node_id, target_node_id, edge_type, evidence_json, confidence, created_at, updated_at)
         VALUES (@id, @projectId, @sourceNodeId, @targetNodeId, @edgeType, @evidenceJson, @confidence, @now, @now)
         ON CONFLICT(project_id, source_node_id, target_node_id, edge_type) DO UPDATE SET
           id = excluded.id,
           evidence_json = excluded.evidence_json,
           confidence = excluded.confidence,
           updated_at = excluded.updated_at`,
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
    return toEdge(row, (reference) =>
      reference.kind === 'source'
        ? this.lookupAuthoritativeSourcePath(input.projectId, reference.id, reference.sourceVersionId, false)
        : null,
    );
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
      .prepare(`${NODE_SELECT_SQL} WHERE nodes.project_id = ? AND nodes.id = ?`)
      .get(projectId, nodeId) as NodeRow | undefined;
    return row ? toNode(row) : null;
  }

  /** Lists every node in a project, ordered by label then ID for stable CLI/API output. */
  listGraphNodes(projectId: string): KnowledgeGraphNodeRecord[] {
    requireText(projectId, 'project ID');
    return (this.db.prepare(`${NODE_SELECT_SQL} WHERE nodes.project_id = ?`).all(projectId) as NodeRow[])
      .map(toNode)
      .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  }

  listGraphEdges(projectId: string): KnowledgeGraphEdgeRecord[] {
    return (this.db.prepare(`SELECT * FROM knowledge_graph_edges WHERE project_id = ?`).all(projectId) as EdgeRow[])
      .map((row) =>
        toEdge(row, (reference) =>
          reference.kind === 'source'
            ? this.lookupAuthoritativeSourcePath(projectId, reference.id, reference.sourceVersionId, false)
            : null,
        ),
      )
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
