export const GRAPH_AMBIGUITY_KINDS = [
  'multiple_candidate_targets',
  'downgraded_relation_type',
  'external_reference_unresolved',
  'generated_relationship_deferred',
  'legacy_metadata_omitted',
  'provenance_missing',
] as const;
export type KnowledgeGraphAmbiguityKind = (typeof GRAPH_AMBIGUITY_KINDS)[number];

export const GRAPH_AMBIGUITY_SEVERITIES = ['review', 'warning', 'info'] as const;
export type KnowledgeGraphAmbiguitySeverity = (typeof GRAPH_AMBIGUITY_SEVERITIES)[number];

export const GRAPH_COMPLETENESS_WARNING_CODES = [
  'partial_source_coverage',
  'deferred_relationships_present',
  'downgraded_relation_types',
  'legacy_provenance_omitted',
  'graph_snapshot_stale',
] as const;

export interface GraphCompletenessWarning {
  code: (typeof GRAPH_COMPLETENESS_WARNING_CODES)[number];
  message: string;
}

export interface KnowledgeGraphCompletenessReport {
  projectId: string;
  snapshotId: string | null;
  createdAt: string;
  sources: {
    activeCount: number;
    coveredCount: number;
    partialCount: number;
    unsupportedCount: number;
    legacyUnknownCount: number;
  };
  relationships: {
    materializedCount: number;
    deferredCount: number;
    unresolvedCount: number;
    downgradedCount: number;
    ambiguousCount: number;
  };
  provenance: {
    edgeWithProvenanceCount: number;
    edgeMissingProvenanceCount: number;
  };
  /** Exact ambiguity total versus the bounded number of persisted rows. */
  ambiguities?: {
    totalCount: number;
    storedCount: number;
  };
  warnings: GraphCompletenessWarning[];
}

export interface KnowledgeGraphAmbiguity {
  id: string;
  ambiguityKind: KnowledgeGraphAmbiguityKind;
  severity: KnowledgeGraphAmbiguitySeverity;
  sourceVersionId: string | null;
  sourceNodeId: string | null;
  targetNodeId: string | null;
  candidateNodeIds?: string[];
  relatedEdgeIds?: string[];
  message: string;
}

export interface BuildKnowledgeGraphReportInput {
  projectId: string;
  snapshotId?: string | null;
}

export interface KnowledgeGraphReportingService {
  buildCompletenessReport(input: BuildKnowledgeGraphReportInput): KnowledgeGraphCompletenessReport;
  listAmbiguities(projectId: string, snapshotId?: string | null): KnowledgeGraphAmbiguity[];
}
