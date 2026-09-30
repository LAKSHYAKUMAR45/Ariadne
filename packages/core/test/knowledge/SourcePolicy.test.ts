import { describe, expect, it } from 'vitest';
import { shouldIngestSource } from '../../src/knowledge/SourcePolicy.js';

const policy = {
  workspaceRoot: '/workspace',
  maxBytes: 100,
  ignorePatterns: ['docs/generated/**', '*.secret'],
};

describe('shouldIngestSource', () => {
  it('accepts an ordinary workspace-relative text file', () => {
    expect(shouldIngestSource('docs/readme.md', { ...policy, size: 20 })).toEqual({
      action: 'ingest',
      path: 'docs/readme.md',
    });
  });

  it('rejects paths outside the workspace and sensitive paths', () => {
    expect(shouldIngestSource('../.env', policy)).toMatchObject({
      action: 'reject',
      reason: 'outside_workspace',
    });
    expect(shouldIngestSource('.env', policy)).toMatchObject({
      action: 'reject',
      reason: 'sensitive_path',
    });
  });

  it('skips ignored, binary, and oversized files with explicit reasons', () => {
    expect(shouldIngestSource('docs/generated/api.md', { ...policy, size: 20 })).toMatchObject({
      action: 'skip',
      reason: 'ariadneignore',
    });
    expect(shouldIngestSource('image.png', { ...policy, size: 20, isBinary: true })).toMatchObject({
      action: 'skip',
      reason: 'binary',
    });
    expect(shouldIngestSource('large.md', { ...policy, size: 101 })).toMatchObject({
      action: 'skip',
      reason: 'file_too_large',
    });
  });
});
