import { createHash } from 'node:crypto';
import { createKnowledgeId } from './KnowledgeIds.js';
import type {
  DeferredRelationshipCandidate,
  DeterministicExtraction,
  ExtractedMetadata,
  ExtractedRelationship,
  ExtractedSymbol,
  KnowledgeSourceSpan,
} from './KnowledgeExtraction.js';
import {
  sanitizeProvenanceMetadata,
  stableGraphJsonStringify,
} from './GraphMetadata.js';
import type { KnowledgeEdgeEvidence, KnowledgeGraphEdgeType, KnowledgeGraphNodeId, KnowledgeProvenanceRef } from './KnowledgeTypes.js';
import { KnowledgeGraph } from './graph/KnowledgeGraph.js';

export interface KnowledgeGraphMaterializationResult {
  nodeIds: string[];
  edgeIds: string[];
  unresolvedRelationships: number;
  /** Relationships whose target alias matched several local symbols; deferred evidence, never graph edges. */
  ambiguousRelationships: DeferredRelationshipCandidate[];
}

interface MaterializedSymbol {
  symbol: ExtractedSymbol;
  nodeId: KnowledgeGraphNodeId;
}

interface AggregatedEdge {
  id: string;
  sourceNodeId: KnowledgeGraphNodeId;
  targetNodeId: KnowledgeGraphNodeId;
  edgeType: KnowledgeGraphEdgeType;
  evidence: KnowledgeEdgeEvidence[];
  confidence: number;
  provenance: KnowledgeProvenanceRef[];
}

function requireText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Knowledge graph materialization ${label} must not be empty`);
  return trimmed;
}

function stableNodeId(projectId: string, sourceVersionId: string, symbol: ExtractedSymbol): KnowledgeGraphNodeId {
  return createKnowledgeId(
    'graph-node',
    `${projectId}:${sourceVersionId}:${symbol.kind}:${symbol.qualifiedName ?? symbol.name}:${symbol.span.startOffset}:${symbol.span.endOffset}`,
  ) as KnowledgeGraphNodeId;
}

function stableEdgeId(
  projectId: string,
  sourceVersionId: string,
  edgeType: string,
  sourceNodeId: KnowledgeGraphNodeId,
  targetNodeId: KnowledgeGraphNodeId,
): string {
  return createKnowledgeId('graph-edge', `${projectId}:${sourceVersionId}:${edgeType}:${sourceNodeId}:${targetNodeId}`);
}

function relationshipOrder(left: ExtractedRelationship, right: ExtractedRelationship): number {
  const leftSource = left.sourceSymbolId ?? left.fromId ?? '';
  const rightSource = right.sourceSymbolId ?? right.fromId ?? '';
  const leftTarget = left.targetSymbolId ?? left.toId ?? left.targetReference ?? '';
  const rightTarget = right.targetSymbolId ?? right.toId ?? right.targetReference ?? '';
  return (
    leftSource.localeCompare(rightSource) ||
    leftTarget.localeCompare(rightTarget) ||
    left.type.localeCompare(right.type) ||
    (left.span?.startOffset ?? Number.MAX_SAFE_INTEGER) - (right.span?.startOffset ?? Number.MAX_SAFE_INTEGER) ||
    left.id.localeCompare(right.id)
  );
}

function spanToProvenance(
  sourceId: string,
  sourceVersionId: string,
  confidence: number,
  span?: KnowledgeSourceSpan | null,
  metadata?: ExtractedMetadata | null,
): KnowledgeProvenanceRef {
  const sanitizedMetadata = metadata
    ? sanitizeProvenanceMetadata(
        metadata,
        `Knowledge graph materialization source ${sourceId}/${sourceVersionId} relationship provenance metadata`,
      )
    : undefined;
  return {
    kind: 'source',
    id: sourceId,
    sourceVersionId,
    ...(span
      ? {
          startOffset: span.startOffset,
          endOffset: span.endOffset,
          startLine: span.startLine,
          startColumn: span.startColumn,
          endLine: span.endLine,
          endColumn: span.endColumn,
          ...(span.label ? { label: span.label } : {}),
        }
      : {}),
    confidence,
    ...(sanitizedMetadata ? { metadata: sanitizedMetadata } : {}),
  };
}

function provenanceOrder(left: KnowledgeProvenanceRef, right: KnowledgeProvenanceRef): number {
  return (
    (left.startOffset ?? Number.MAX_SAFE_INTEGER) - (right.startOffset ?? Number.MAX_SAFE_INTEGER) ||
    (left.startLine ?? Number.MAX_SAFE_INTEGER) - (right.startLine ?? Number.MAX_SAFE_INTEGER) ||
    (left.startColumn ?? Number.MAX_SAFE_INTEGER) - (right.startColumn ?? Number.MAX_SAFE_INTEGER) ||
    (left.endOffset ?? Number.MAX_SAFE_INTEGER) - (right.endOffset ?? Number.MAX_SAFE_INTEGER) ||
    left.id.localeCompare(right.id) ||
    stableGraphJsonStringify(left.metadata ?? {}, 'Knowledge graph materialization left provenance metadata').localeCompare(
      stableGraphJsonStringify(right.metadata ?? {}, 'Knowledge graph materialization right provenance metadata'),
    )
  );
}

function uniqueSortedEvidence(evidence: Iterable<KnowledgeEdgeEvidence>): KnowledgeEdgeEvidence[] {
  return [...new Set(evidence)].sort();
}

function uniqueSortedProvenance(provenance: Iterable<KnowledgeProvenanceRef>): KnowledgeProvenanceRef[] {
  const byFingerprint = new Map<string, KnowledgeProvenanceRef>();
  for (const reference of provenance) {
    const fingerprint = createHash('sha256')
      .update(stableGraphJsonStringify(reference, 'Knowledge graph materialization provenance fingerprint'))
      .digest('hex');
    if (!byFingerprint.has(fingerprint)) byFingerprint.set(fingerprint, reference);
  }
  return [...byFingerprint.values()].sort(provenanceOrder);
}

function relationshipEvidence(relationship: ExtractedRelationship): KnowledgeEdgeEvidence {
  const inferredFlag = relationship.metadata?.inferred;
  if (typeof inferredFlag === 'string') {
    const normalized = inferredFlag.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return 'semantic_relationship';
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return 'explicit_link';
  }
  const origin = relationship.metadata?.origin ?? relationship.metadata?.provider ?? relationship.metadata?.relationshipSource;
  if (typeof origin === 'string') {
    const normalized = origin.trim().toLowerCase();
    if (normalized.includes('provider') || normalized.includes('inferred')) return 'semantic_relationship';
  }
  return 'explicit_link';
}


function unqualifiedImportReference(reference: string): string | null {
  const hashIndex = reference.indexOf('#');
  if (hashIndex <= 0) return null;
  return reference.slice(0, hashIndex);
}

function isProjectResolvableReference(reference: string): boolean {
  return /[./#]/.test(reference);
}

function registerAlias(index: Map<string, KnowledgeGraphNodeId | null>, alias: string | null | undefined, nodeId: KnowledgeGraphNodeId): void {
  const trimmed = alias?.trim();
  if (!trimmed) return;
  const existing = index.get(trimmed);
  if (existing === undefined) {
    index.set(trimmed, nodeId);
    return;
  }
  if (existing !== nodeId) index.set(trimmed, null);
}

function ambiguousCandidate(relationship: ExtractedRelationship): DeferredRelationshipCandidate {
  return {
    id: relationship.id,
    type: relationship.type,
    sourceSymbolId: relationship.sourceSymbolId ?? relationship.fromId ?? null,
    targetReference: relationship.targetReference?.trim() ?? null,
    resolutionKind: 'ambiguous_alias',
    evidenceKind: 'naming',
    confidence: relationship.confidence,
    span: relationship.span ?? null,
    metadata: { origin: 'graph_materialization' },
  };
}

export class KnowledgeGraphMaterializer {
  constructor(private readonly graph: KnowledgeGraph) {}

  materialize(input: {
    projectId: string;
    sourceId: string;
    sourceVersionId: string;
    extraction: DeterministicExtraction;
  }): KnowledgeGraphMaterializationResult {
    return this.graph.runInTransaction(() => {
      const projectId = requireText(input.projectId, 'project ID');
      const sourceId = requireText(input.sourceId, 'source ID');
      const sourceVersionId = requireText(input.sourceVersionId, 'source version ID');
      if (input.extraction.sourceVersionId !== sourceVersionId) {
        throw new Error(
          `Knowledge graph materialization extraction source version ${input.extraction.sourceVersionId} must match ${sourceVersionId}`,
        );
      }
      if (!this.graph.sourceVersionExists(projectId, sourceId, sourceVersionId)) {
        throw new Error(
          `Knowledge graph materialization source ${sourceId}/${sourceVersionId} must exist in project ${projectId}`,
        );
      }
      this.graph.removeMaterializedSourceVersion(projectId, sourceVersionId);
      const symbols = [...input.extraction.symbols].sort((left, right) =>
        stableNodeId(projectId, sourceVersionId, left).localeCompare(stableNodeId(projectId, sourceVersionId, right)),
      );
      const materializedSymbols = new Map<string, MaterializedSymbol>();
      const nodeIdsToSymbols = new Map<KnowledgeGraphNodeId, ExtractedSymbol>();
      const aliases = new Map<string, KnowledgeGraphNodeId | null>();

      for (const symbol of symbols) {
        const nodeId = stableNodeId(projectId, sourceVersionId, symbol);
        const existingSymbol = nodeIdsToSymbols.get(nodeId);
        if (existingSymbol && existingSymbol.id !== symbol.id) {
          throw new Error(
            `Knowledge graph materialization node ID collision for ${nodeId} (${existingSymbol.id} vs ${symbol.id})`,
          );
        }
        this.graph.upsertGraphNode({
          id: nodeId,
          projectId,
          nodeType: symbol.kind,
          label: symbol.name,
          sourceKind: 'deterministic_symbol',
          sourceId: `${sourceVersionId}:${symbol.id}`,
          qualifiedName: symbol.qualifiedName ?? symbol.name,
          sourceVersionId,
          span: symbol.span,
          confidence: symbol.confidence,
        });
        materializedSymbols.set(symbol.id, { symbol, nodeId });
        nodeIdsToSymbols.set(nodeId, symbol);
        registerAlias(aliases, symbol.qualifiedName ?? null, nodeId);
        registerAlias(aliases, symbol.name, nodeId);
      }

      const nodeIds = [...materializedSymbols.values()]
        .map((entry) => entry.nodeId)
        .sort((left, right) => left.localeCompare(right));
      const aggregatedEdges = new Map<string, AggregatedEdge>();
      let unresolvedRelationships = 0;
      const ambiguousRelationships: DeferredRelationshipCandidate[] = [];

      const relationships = [...input.extraction.relationships].sort(relationshipOrder);
      const moduleNodeId = this.uniqueModuleNodeId(materializedSymbols);
      for (const relationship of relationships) {
        const sourceNodeId = this.resolveSourceNodeId(relationship, materializedSymbols, moduleNodeId);
        const target = this.resolveTargetNodeId(projectId, relationship, materializedSymbols, aliases);
        const targetNodeId = target.nodeId;
        if (!sourceNodeId || !targetNodeId) {
          unresolvedRelationships += 1;
          if (sourceNodeId && target.ambiguous) ambiguousRelationships.push(ambiguousCandidate(relationship));
          continue;
        }
        const key = `${sourceNodeId}::${targetNodeId}::${relationship.type}`;
        const provenance = spanToProvenance(
          sourceId,
          sourceVersionId,
          relationship.confidence,
          relationship.span,
          relationship.metadata,
        );
        const evidence = relationshipEvidence(relationship);
        const edgeId = stableEdgeId(projectId, sourceVersionId, relationship.type, sourceNodeId, targetNodeId);
        const existing = aggregatedEdges.get(key);
        if (!existing) {
          aggregatedEdges.set(key, {
            id: edgeId,
            sourceNodeId,
            targetNodeId,
            edgeType: relationship.type,
            evidence: [evidence],
            confidence: relationship.confidence,
            provenance: [provenance],
          });
          continue;
        }
        aggregatedEdges.set(key, {
          ...existing,
          evidence: uniqueSortedEvidence([...existing.evidence, evidence]),
          confidence: Math.max(existing.confidence, relationship.confidence),
          provenance: uniqueSortedProvenance([...existing.provenance, provenance]),
        });
      }

      const edgeIds = [...aggregatedEdges.values()]
        .sort((left, right) =>
          left.sourceNodeId.localeCompare(right.sourceNodeId) ||
          left.targetNodeId.localeCompare(right.targetNodeId) ||
          left.edgeType.localeCompare(right.edgeType) ||
          left.id.localeCompare(right.id),
        )
        .map((edge) => {
          this.graph.upsertGraphEdge({
            id: edge.id,
            projectId,
            sourceNodeId: edge.sourceNodeId,
            targetNodeId: edge.targetNodeId,
            edgeType: edge.edgeType,
            evidence: edge.evidence,
            confidence: edge.confidence,
            provenance: edge.provenance,
          });
          return edge.id;
        })
        .sort((left, right) => left.localeCompare(right));

      return {
        nodeIds,
        edgeIds,
        unresolvedRelationships,
        ambiguousRelationships,
      };
    });
  }

  private resolveSourceNodeId(
    relationship: ExtractedRelationship,
    materializedSymbols: ReadonlyMap<string, MaterializedSymbol>,
    moduleNodeId: KnowledgeGraphNodeId | null,
  ): KnowledgeGraphNodeId | null {
    const sourceSymbolId = relationship.sourceSymbolId ?? relationship.fromId ?? null;
    if (sourceSymbolId) return materializedSymbols.get(sourceSymbolId)?.nodeId ?? null;
    return relationship.type === 'imports' || relationship.type === 'exports' ? moduleNodeId : null;
  }

  private uniqueModuleNodeId(materializedSymbols: ReadonlyMap<string, MaterializedSymbol>): KnowledgeGraphNodeId | null {
    const moduleEntries = [...materializedSymbols.values()]
      .filter((entry) => entry.symbol.kind === 'module')
      .sort(
        (left, right) =>
          left.symbol.span.startOffset - right.symbol.span.startOffset || left.nodeId.localeCompare(right.nodeId),
      );
    return moduleEntries[0]?.nodeId ?? null;
  }

  private resolveTargetNodeId(
    projectId: string,
    relationship: ExtractedRelationship,
    materializedSymbols: ReadonlyMap<string, MaterializedSymbol>,
    aliases: ReadonlyMap<string, KnowledgeGraphNodeId | null>,
  ): { nodeId: KnowledgeGraphNodeId | null; ambiguous: boolean } {
    const explicitTargetId = relationship.targetSymbolId ?? relationship.toId ?? null;
    if (explicitTargetId) return { nodeId: materializedSymbols.get(explicitTargetId)?.nodeId ?? null, ambiguous: false };
    const reference = relationship.targetReference?.trim();
    if (!reference) return { nodeId: null, ambiguous: false };
    for (const candidate of [reference, unqualifiedImportReference(reference)]) {
      if (!candidate) continue;
      const local = aliases.get(candidate);
      if (local !== undefined) return { nodeId: local, ambiguous: local === null };
      if (!isProjectResolvableReference(candidate)) continue;
      const existing = this.graph.findUniqueGraphNodeId(projectId, candidate, { sourceKind: 'deterministic_symbol' });
      if (existing) return { nodeId: existing, ambiguous: false };
    }
    return { nodeId: null, ambiguous: false };
  }
}
