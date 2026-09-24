import { describe, expect, it } from 'vitest';
import {
  createProviderRequiredGeneration,
  validateKnowledgeAnalysis,
  validateKnowledgeGeneration,
} from '../../src/knowledge/KnowledgeAnalysis.js';

const validAnalysis = {
  summary: 'The API uses bearer tokens.',
  entities: [
    {
      id: 'entity-auth',
      name: 'Authentication API',
      type: 'service',
      sourceIds: ['source-1'],
      confidence: 0.9,
    },
  ],
  claims: [
    {
      id: 'claim-auth',
      statement: 'The API uses bearer tokens.',
      sourceIds: ['source-1'],
      confidence: 0.9,
    },
  ],
  relationships: [
    {
      sourceEntityId: 'entity-auth',
      targetEntityId: 'entity-auth',
      type: 'documents',
      sourceIds: ['source-1'],
      confidence: 0.8,
    },
  ],
  contradictions: [
    {
      summary: 'The token lifetime is inconsistent.',
      claimIds: ['claim-auth'],
      sourceIds: ['source-1'],
      confidence: 0.5,
    },
  ],
  researchGaps: [
    {
      question: 'What is the token expiry?',
      sourceIds: ['source-1'],
      confidence: 0.4,
    },
  ],
};

describe('validateKnowledgeAnalysis', () => {
  it('accepts structured entities, claims, relationships, contradictions, research gaps, and confidence values', () => {
    expect(validateKnowledgeAnalysis(validAnalysis)).toEqual(validAnalysis);
  });

  it('rejects malformed result structures, dangling evidence, and confidence outside the inclusive range', () => {
    expect(() =>
      validateKnowledgeAnalysis({
        ...validAnalysis,
        entities: [{ ...validAnalysis.entities[0], confidence: 1.01 }],
      }),
    ).toThrow(/confidence/i);
    expect(() =>
      validateKnowledgeAnalysis({
        ...validAnalysis,
        claims: [{ ...validAnalysis.claims[0], sourceIds: [] }],
      }),
    ).toThrow(/sourceIds/i);
    expect(() =>
      validateKnowledgeAnalysis({
        ...validAnalysis,
        relationships: [{ ...validAnalysis.relationships[0], targetEntityId: 'missing' }],
      }),
    ).toThrow(/unknown entity/i);
    expect(() => validateKnowledgeAnalysis({ ...validAnalysis, unexpected: true })).toThrow(/unexpected/i);
  });
});

describe('validateKnowledgeGeneration', () => {
  it('accepts generated content with validated analysis', () => {
    const generation = {
      status: 'generated' as const,
      title: 'Authentication',
      content: '# Authentication',
      analysis: validAnalysis,
    };

    expect(validateKnowledgeGeneration(generation)).toEqual(generation);
  });

  it('returns an explicit deterministic provider-required outcome instead of empty generated content', () => {
    expect(createProviderRequiredGeneration('generation')).toEqual({
      status: 'provider_required',
      capability: 'generation',
      message: 'A provider with the generation capability is required.',
    });
    expect(() =>
      validateKnowledgeGeneration({ status: 'generated', title: 'Empty', content: '', analysis: validAnalysis }),
    ).toThrow(/content/i);
    expect(() =>
      validateKnowledgeGeneration({
        status: 'provider_required',
        capability: 'unsupported',
        message: 'A provider is required.',
      }),
    ).toThrow(/unsupported/i);
  });
});
