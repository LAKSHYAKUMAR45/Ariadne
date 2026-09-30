import type { ProviderFallbackReason } from './KnowledgeProviderFallback.js';
import type { KnowledgeSearchCitation } from './KnowledgeSearch.js';

export type KnowledgeSummaryScopeKind = 'source_version' | 'page_version' | 'project';
export type KnowledgeSummaryStrategy = 'deterministic' | 'provider_refined' | 'fallback_warning';

export const KNOWLEDGE_SUMMARY_SCOPE_KINDS: readonly KnowledgeSummaryScopeKind[] = ['source_version', 'page_version', 'project'];
export const KNOWLEDGE_SUMMARY_STRATEGIES: readonly KnowledgeSummaryStrategy[] = ['deterministic', 'provider_refined', 'fallback_warning'];

export interface BuildKnowledgeSemanticSummaryInput {
  projectId: string;
  scopeKind: KnowledgeSummaryScopeKind;
  scopeId: string;
  /** Opt-in per call. Omitted or `never` never consults a provider. */
  providerMode?: 'never' | 'if-available';
  /** Explicit profile name; wins over the host-local `host.provider.summary_profile` setting. */
  providerProfileName?: string | null;
  signal?: AbortSignal;
}

/** Runtime only: `text` is bounded redacted extraction-derived text, sent to a provider in memory and never persisted. */
export interface KnowledgeSemanticSummaryEvidence {
  id: string;
  title: string;
  citation: KnowledgeSearchCitation | null;
  text: string;
}

export interface KnowledgeSemanticSummaryWarning {
  code: string;
  message: string;
  reason?: ProviderFallbackReason;
}

export interface KnowledgeSemanticSummaryRecord {
  id: string;
  projectId: string;
  scopeKind: KnowledgeSummaryScopeKind;
  scopeId: string;
  strategy: KnowledgeSummaryStrategy;
  title: string;
  summary: string;
  bullets: string[];
  evidence: Array<{ evidenceId: string; citation: KnowledgeSearchCitation | null }>;
  /** Additive: the evidence ids grounding each bullet, index-aligned with `bullets`. */
  bulletEvidenceIds: string[][];
  /** Label only; set solely for `provider_refined` and exported as NULL in archives. */
  providerProfileName: string | null;
  warnings: KnowledgeSemanticSummaryWarning[];
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeSemanticSummaryService {
  build(input: BuildKnowledgeSemanticSummaryInput): Promise<KnowledgeSemanticSummaryRecord>;
  getLatest(projectId: string, scopeKind: KnowledgeSummaryScopeKind, scopeId: string): KnowledgeSemanticSummaryRecord | null;
}

export interface SemanticSummaryProviderRequest {
  scopeKind: KnowledgeSummaryScopeKind;
  title: string;
  deterministicSummary: string;
  evidence: Array<{ id: string; title: string; text: string; citation: KnowledgeSearchCitation | null }>;
}

export interface SemanticSummaryProviderResponse {
  title: string;
  summary: string;
  bullets: string[];
  evidenceIdsByBullet: string[][];
}

/** The reference-only JSON stored in `knowledge_semantic_summaries.summary_json`. */
export interface PersistedSemanticSummaryPayload {
  title: string;
  summary: string;
  bullets: string[];
  evidence: Array<{ evidenceId: string; citation: KnowledgeSearchCitation | null }>;
  bulletEvidenceIds: string[][];
}
