import { describe, expect, it } from 'vitest';
import { createKnowledgeId, normalizeKnowledgePath } from '../../src/knowledge/KnowledgeIds.js';

describe('knowledge identifiers', () => {
  it('returns the same prefixed identifier for the same seed', () => {
    const first = createKnowledgeId('source', 'docs/architecture.md');
    const second = createKnowledgeId('source', 'docs/architecture.md');

    expect(first).toBe(second);
    expect(first).toMatch(/^source_[a-f0-9]{32}$/);
  });

  it('returns distinct prefixed identifiers when no seed is provided', () => {
    const first = createKnowledgeId('page');
    const second = createKnowledgeId('page');

    expect(first).toMatch(/^page_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(second).toMatch(/^page_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(first).not.toBe(second);
  });

  it('rejects an empty identifier prefix', () => {
    expect(() => createKnowledgeId('')).toThrow('Knowledge ID prefix must not be empty');
  });
});

describe('normalizeKnowledgePath', () => {
  it('returns a repository-relative POSIX path', () => {
    expect(normalizeKnowledgePath('.\\docs//guides/../architecture.md')).toBe('docs/architecture.md');
    expect(normalizeKnowledgePath('docs\\guides\\')).toBe('docs/guides');
  });

  it('rejects paths outside the workspace', () => {
    expect(() => normalizeKnowledgePath('../secrets.env')).toThrow('Knowledge path must stay within the workspace');
    expect(() => normalizeKnowledgePath('C:\\Users\\alice\\secrets.env')).toThrow(
      'Knowledge path must stay within the workspace',
    );
    expect(() => normalizeKnowledgePath('C:/Users/alice/secrets.env')).toThrow(
      'Knowledge path must stay within the workspace',
    );
  });
});
