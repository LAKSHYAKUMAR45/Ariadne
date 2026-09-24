import {
  KNOWLEDGE_PROVIDER_CAPABILITIES,
  redactKnowledgeProviderPayload,
  type KnowledgeProviderCapability,
  type KnowledgeRedactionHook,
} from './KnowledgeProviders.js';

export interface KnowledgeAnalysisInput {
  sourceIds: readonly string[];
  content: string;
  prompt?: string;
}

export interface KnowledgeEntity {
  id: string;
  name: string;
  type: string;
  sourceIds: string[];
  confidence: number;
}

export interface KnowledgeClaim {
  id: string;
  statement: string;
  sourceIds: string[];
  confidence: number;
}

export interface KnowledgeRelationship {
  sourceEntityId: string;
  targetEntityId: string;
  type: string;
  sourceIds: string[];
  confidence: number;
}

export interface KnowledgeContradiction {
  summary: string;
  claimIds: string[];
  sourceIds: string[];
  confidence: number;
}

export interface KnowledgeResearchGap {
  question: string;
  sourceIds: string[];
  confidence: number;
}

export interface KnowledgeAnalysis {
  summary: string;
  entities: KnowledgeEntity[];
  claims: KnowledgeClaim[];
  relationships: KnowledgeRelationship[];
  contradictions: KnowledgeContradiction[];
  researchGaps: KnowledgeResearchGap[];
}

export interface KnowledgeGenerationInput {
  title: string;
  prompt: string;
  analysis: KnowledgeAnalysis;
}

export interface GeneratedKnowledge {
  status: 'generated';
  title: string;
  content: string;
  analysis: KnowledgeAnalysis;
}

export interface ProviderRequiredKnowledgeGeneration {
  status: 'provider_required';
  capability: KnowledgeProviderCapability;
  message: string;
}

export type KnowledgeGeneration = GeneratedKnowledge | ProviderRequiredKnowledgeGeneration;

export interface KnowledgeAnalyzer {
  analyze(input: KnowledgeAnalysisInput): Promise<KnowledgeAnalysis>;
}

export interface KnowledgeGenerator {
  generate(input: KnowledgeGenerationInput): Promise<KnowledgeGeneration>;
}

export interface KnowledgeAnalysisRedactionHooks {
  prompt?: KnowledgeRedactionHook;
  response?: KnowledgeRedactionHook;
  log?: KnowledgeRedactionHook;
}

export type KnowledgeAnalysisPayloadKind = keyof KnowledgeAnalysisRedactionHooks;

const knowledgeProviderCapabilities = new Set<string>(KNOWLEDGE_PROVIDER_CAPABILITIES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`Knowledge ${label} has an unexpected field: ${key}`);
    }
  }
  for (const key of keys) {
    if (!(key in value)) {
      throw new Error(`Knowledge ${label} is missing required field: ${key}`);
    }
  }
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Knowledge ${label} must be a non-empty string`);
  }
  return value;
}

function requireProviderCapability(value: unknown, label: string): KnowledgeProviderCapability {
  const capability = requireNonEmptyString(value, label);
  if (!knowledgeProviderCapabilities.has(capability)) {
    throw new Error(`Unsupported knowledge provider capability: ${capability}`);
  }
  return capability as KnowledgeProviderCapability;
}

function requireConfidence(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Knowledge ${label} confidence must be a finite number between 0 and 1`);
  }
  return value;
}

function requireSourceIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Knowledge ${label} sourceIds must be a non-empty array`);
  }

  const sourceIds = value.map((sourceId) => requireNonEmptyString(sourceId, `${label} source ID`));
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new Error(`Knowledge ${label} sourceIds must not contain duplicates`);
  }
  return sourceIds;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Knowledge ${label} must be a non-empty array`);
  }
  const items = value.map((item) => requireNonEmptyString(item, label));
  if (new Set(items).size !== items.length) {
    throw new Error(`Knowledge ${label} must not contain duplicates`);
  }
  return items;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Knowledge ${label} must be an object`);
  }
  return value;
}

function validateEntity(value: unknown): KnowledgeEntity {
  const entity = requireRecord(value, 'entity');
  requireExactKeys(entity, ['id', 'name', 'type', 'sourceIds', 'confidence'], 'entity');
  return {
    id: requireNonEmptyString(entity.id, 'entity ID'),
    name: requireNonEmptyString(entity.name, 'entity name'),
    type: requireNonEmptyString(entity.type, 'entity type'),
    sourceIds: requireSourceIds(entity.sourceIds, 'entity'),
    confidence: requireConfidence(entity.confidence, 'entity'),
  };
}

function validateClaim(value: unknown): KnowledgeClaim {
  const claim = requireRecord(value, 'claim');
  requireExactKeys(claim, ['id', 'statement', 'sourceIds', 'confidence'], 'claim');
  return {
    id: requireNonEmptyString(claim.id, 'claim ID'),
    statement: requireNonEmptyString(claim.statement, 'claim statement'),
    sourceIds: requireSourceIds(claim.sourceIds, 'claim'),
    confidence: requireConfidence(claim.confidence, 'claim'),
  };
}

function validateRelationship(value: unknown, entityIds: ReadonlySet<string>): KnowledgeRelationship {
  const relationship = requireRecord(value, 'relationship');
  requireExactKeys(
    relationship,
    ['sourceEntityId', 'targetEntityId', 'type', 'sourceIds', 'confidence'],
    'relationship',
  );
  const sourceEntityId = requireNonEmptyString(relationship.sourceEntityId, 'relationship source entity ID');
  const targetEntityId = requireNonEmptyString(relationship.targetEntityId, 'relationship target entity ID');
  if (!entityIds.has(sourceEntityId) || !entityIds.has(targetEntityId)) {
    throw new Error('Knowledge relationship references an unknown entity');
  }
  return {
    sourceEntityId,
    targetEntityId,
    type: requireNonEmptyString(relationship.type, 'relationship type'),
    sourceIds: requireSourceIds(relationship.sourceIds, 'relationship'),
    confidence: requireConfidence(relationship.confidence, 'relationship'),
  };
}

function validateContradiction(value: unknown, claimIds: ReadonlySet<string>): KnowledgeContradiction {
  const contradiction = requireRecord(value, 'contradiction');
  requireExactKeys(contradiction, ['summary', 'claimIds', 'sourceIds', 'confidence'], 'contradiction');
  const referencedClaimIds = requireStringArray(contradiction.claimIds, 'contradiction claim IDs');
  if (referencedClaimIds.some((claimId) => !claimIds.has(claimId))) {
    throw new Error('Knowledge contradiction references an unknown claim');
  }
  return {
    summary: requireNonEmptyString(contradiction.summary, 'contradiction summary'),
    claimIds: referencedClaimIds,
    sourceIds: requireSourceIds(contradiction.sourceIds, 'contradiction'),
    confidence: requireConfidence(contradiction.confidence, 'contradiction'),
  };
}

function validateResearchGap(value: unknown): KnowledgeResearchGap {
  const gap = requireRecord(value, 'research gap');
  requireExactKeys(gap, ['question', 'sourceIds', 'confidence'], 'research gap');
  return {
    question: requireNonEmptyString(gap.question, 'research gap question'),
    sourceIds: requireSourceIds(gap.sourceIds, 'research gap'),
    confidence: requireConfidence(gap.confidence, 'research gap'),
  };
}

function requireUniqueIds(ids: readonly string[], label: string): void {
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Knowledge ${label} IDs must be unique`);
  }
}

/**
 * Validates untrusted analyzer output before it can be persisted or used by a
 * generator. The returned object is a new, normalized value.
 */
export function validateKnowledgeAnalysis(value: unknown): KnowledgeAnalysis {
  const analysis = requireRecord(value, 'analysis');
  requireExactKeys(
    analysis,
    ['summary', 'entities', 'claims', 'relationships', 'contradictions', 'researchGaps'],
    'analysis',
  );

  if (!Array.isArray(analysis.entities)) throw new Error('Knowledge analysis entities must be an array');
  if (!Array.isArray(analysis.claims)) throw new Error('Knowledge analysis claims must be an array');
  if (!Array.isArray(analysis.relationships)) throw new Error('Knowledge analysis relationships must be an array');
  if (!Array.isArray(analysis.contradictions)) throw new Error('Knowledge analysis contradictions must be an array');
  if (!Array.isArray(analysis.researchGaps)) throw new Error('Knowledge analysis researchGaps must be an array');

  const entities = analysis.entities.map(validateEntity);
  const claims = analysis.claims.map(validateClaim);
  requireUniqueIds(entities.map((entity) => entity.id), 'entity');
  requireUniqueIds(claims.map((claim) => claim.id), 'claim');

  const entityIds = new Set(entities.map((entity) => entity.id));
  const claimIds = new Set(claims.map((claim) => claim.id));
  return {
    summary: requireNonEmptyString(analysis.summary, 'analysis summary'),
    entities,
    claims,
    relationships: analysis.relationships.map((relationship) => validateRelationship(relationship, entityIds)),
    contradictions: analysis.contradictions.map((contradiction) => validateContradiction(contradiction, claimIds)),
    researchGaps: analysis.researchGaps.map(validateResearchGap),
  };
}

/**
 * Produces the only permitted providerless generation outcome. Consumers can
 * reliably distinguish it from a successful but empty-looking response.
 */
export function createProviderRequiredGeneration(
  capability: KnowledgeProviderCapability = 'generation',
): ProviderRequiredKnowledgeGeneration {
  const validatedCapability = requireProviderCapability(capability, 'provider-required capability');
  return {
    status: 'provider_required',
    capability: validatedCapability,
    message: `A provider with the ${validatedCapability} capability is required.`,
  };
}

/**
 * Validates untrusted generator output and rejects empty generated content.
 */
export function validateKnowledgeGeneration(value: unknown): KnowledgeGeneration {
  const generation = requireRecord(value, 'generation');
  const status = requireNonEmptyString(generation.status, 'generation status');
  if (status === 'provider_required') {
    requireExactKeys(generation, ['status', 'capability', 'message'], 'provider-required generation');
    return {
      status,
      capability: requireProviderCapability(generation.capability, 'provider-required capability'),
      message: requireNonEmptyString(generation.message, 'provider-required message'),
    };
  }
  if (status !== 'generated') {
    throw new Error(`Unsupported knowledge generation status: ${status}`);
  }

  requireExactKeys(generation, ['status', 'title', 'content', 'analysis'], 'generated generation');
  return {
    status,
    title: requireNonEmptyString(generation.title, 'generation title'),
    content: requireNonEmptyString(generation.content, 'generation content'),
    analysis: validateKnowledgeAnalysis(generation.analysis),
  };
}

/**
 * Redacts analyzer/generator prompts, responses, and logs before they cross a
 * diagnostic or persistence boundary.
 */
export function redactKnowledgeAnalysisPayload(
  kind: KnowledgeAnalysisPayloadKind,
  value: string,
  hooks: KnowledgeAnalysisRedactionHooks = {},
): string {
  return redactKnowledgeProviderPayload(value, hooks[kind]);
}
