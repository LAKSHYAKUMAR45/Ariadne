import type { KnowledgeEdgeEvidence, KnowledgeProvenanceRef } from '../KnowledgeTypes.js';

export interface GraphScoringInput {
  evidence: KnowledgeEdgeEvidence | KnowledgeEdgeEvidence[];
  weight?: number;
  confidence: number;
  provenance?: KnowledgeProvenanceRef[];
}

export const KNOWLEDGE_EDGE_EVIDENCE_WEIGHTS: Readonly<Record<KnowledgeEdgeEvidence, number>> = {
  explicit_link: 1,
  provenance_overlap: 0.9,
  shared_source: 0.8,
  semantic_relationship: 0.7,
  supersession: 0.6,
  contradiction: 0.5,
};

function validateUnit(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Knowledge graph ${label} must be between 0 and 1`);
  }
}

/**
 * Scores evidence strength, edge weight, confidence, and provenance confidence
 * as a bounded relevance score. Multiple evidence types are combined without
 * allowing duplicate evidence to exceed the unit evidence score.
 */
export function scoreGraphEdge(input: GraphScoringInput): number {
  validateUnit(input.confidence, 'confidence');
  const weight = input.weight ?? 1;
  validateUnit(weight, 'weight');

  const evidence = Array.isArray(input.evidence) ? input.evidence : [input.evidence];
  if (evidence.length === 0) {
    throw new Error('Knowledge graph edge must contain evidence');
  }

  const evidenceScore = evidence.reduce(
    (combined, kind) => 1 - (1 - combined) * (1 - KNOWLEDGE_EDGE_EVIDENCE_WEIGHTS[kind]),
    0,
  );
  const provenance = input.provenance ?? [];
  const provenanceScore =
    provenance.length === 0
      ? 1
      : provenance.reduce((sum, reference) => sum + (reference.confidence ?? 1), 0) / provenance.length;
  validateUnit(provenanceScore, 'provenance confidence');

  return evidenceScore * weight * input.confidence * provenanceScore;
}
