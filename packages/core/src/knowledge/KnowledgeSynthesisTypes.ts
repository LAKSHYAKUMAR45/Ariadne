import type { ProviderFallbackReason } from './KnowledgeProviderFallback.js';
import type { KnowledgeAmbiguityReason, KnowledgeSearchCitation, KnowledgeSearchConfidence, KnowledgeSearchMode } from './KnowledgeSearch.js';
import type { TaskStore } from '../TaskStore.js';

export type KnowledgeAnswerStrategy = 'deterministic' | 'provider-assisted';

export interface SynthesizeKnowledgeAnswerInput {
  projectId: string;
  query: string;
  mode?: KnowledgeSearchMode;
  taskStore?: TaskStore;
  limit?: number;
  maxGraphExpansions?: number;
  tokenBudget?: number;
  /** Opt-in per call. Omitted or `never` never consults a provider. */
  providerStrategy?: 'never' | 'if-available';
  /** Explicit profile name; wins over the host-local `host.provider.synthesis_profile` setting. */
  providerProfileName?: string | null;
  signal?: AbortSignal;
}

/** Runtime evidence may carry an ephemeral redacted snippet for provider input; it is never persisted. */
export interface KnowledgeSynthesisEvidence {
  id: string;
  resultId: string;
  kind: 'page' | 'source' | 'task';
  title: string;
  path: string | null;
  url: string | null;
  rank: number;
  citation: KnowledgeSearchCitation | null;
  snippetPolicy: 'reference_only' | 'ephemeral_redacted';
  ephemeralSnippet: string | null;
  searchConfidence: KnowledgeSearchConfidence | null;
  ambiguityReason: KnowledgeAmbiguityReason | null;
}

export type KnowledgeSynthesisClaimConfidence = 'clear' | 'ambiguous' | 'unassessed';

export interface KnowledgeSynthesisClaim {
  id: string;
  text: string;
  evidenceIds: string[];
  citations: KnowledgeSearchCitation[];
  confidence: KnowledgeSynthesisClaimConfidence;
}

export interface KnowledgeSynthesisSection {
  id: string;
  heading: string;
  claims: KnowledgeSynthesisClaim[];
}

export type KnowledgeSynthesisWarningCode =
  | 'provider_unavailable'
  | 'provider_invalid'
  | 'insufficient_exact_spans'
  | 'ambiguous_evidence'
  | 'result_limit_reached';

export interface KnowledgeSynthesisWarning {
  code: KnowledgeSynthesisWarningCode;
  reason?: ProviderFallbackReason;
  ambiguityReason?: KnowledgeAmbiguityReason;
  alternativeCount?: number;
  message: string;
}

export interface KnowledgeSynthesisResult {
  strategy: KnowledgeAnswerStrategy;
  query: string;
  mode: KnowledgeSearchMode;
  answerMarkdown: string;
  sections: KnowledgeSynthesisSection[];
  evidence: KnowledgeSynthesisEvidence[];
  citations: KnowledgeSearchCitation[];
  warnings: KnowledgeSynthesisWarning[];
}

export interface KnowledgeAnswerSynthesisService {
  synthesize(input: SynthesizeKnowledgeAnswerInput): Promise<KnowledgeSynthesisResult>;
}

export interface KnowledgeSynthesisProviderRequest {
  query: string;
  mode: KnowledgeSearchMode;
  evidence: Array<{
    id: string;
    title: string;
    snippet: string | null;
    citation: KnowledgeSearchCitation | null;
  }>;
  deterministicDraft: KnowledgeSynthesisSection[];
}

export interface KnowledgeSynthesisProviderResponse {
  sections: Array<{
    heading: string;
    claims: Array<{
      text: string;
      evidenceIds: string[];
    }>;
  }>;
}

export interface PersistedKnowledgeSynthesisEvidence {
  id: string;
  resultId: string;
  kind: 'page' | 'source' | 'task';
  title: string | null;
  path: string | null;
  rank: number;
  citation: KnowledgeSearchCitation | null;
  snippetPolicy: 'reference_only';
  searchConfidence: KnowledgeSearchConfidence | null;
}

/** The only synthesis shape written to disk or archives; it fills the `MessagePayloadV2.synthesis` slot. */
export interface PersistedKnowledgeSynthesis {
  synthesisVersion: 1;
  strategy: KnowledgeAnswerStrategy;
  sections: KnowledgeSynthesisSection[];
  evidence: PersistedKnowledgeSynthesisEvidence[];
  warnings: KnowledgeSynthesisWarning[];
}
