import { describe, expect, it } from 'vitest';
import { renderKnowledgeIndex, renderKnowledgeLog, renderKnowledgeOverview, renderKnowledgePage } from '../../src/knowledge/KnowledgeRenderer.js';

describe('KnowledgeRenderer', () => {
  it('renders stable frontmatter with provenance and generator metadata', () => {
    const rendered = renderKnowledgePage({
      id: 'page_1',
      type: 'concept',
      title: 'SQLite',
      slug: 'sqlite',
      content: 'A durable database.',
      sourceIds: ['source-version_1'],
      provenance: [{ kind: 'file', id: 'README.md', path: 'README.md', confidence: 0.9 }],
      confidence: 0.8,
      generatorVersion: 'generator-1',
      generatedAt: '2026-01-01T00:00:00.000Z',
      version: 3,
    });

    expect(rendered).toContain('id: "page_1"');
    expect(rendered).toContain('type: "concept"');
    expect(rendered).toContain('source-version_1');
    expect(rendered).toContain('generated_at:');
    expect(rendered).toContain('generator_version: "generator-1"');
    expect(rendered).toContain('confidence: 0.8');
    expect(rendered).toContain('A durable database.');
  });

  it('orders indexes and appends parseable log entries', () => {
    const entries = [
      { id: 'page_b', type: 'concept' as const, title: 'Zed', slug: 'zed', summary: null, status: 'active', version: 1, updatedAt: '2026-01-01' },
      { id: 'page_a', type: 'concept' as const, title: 'Alpha', slug: 'alpha', summary: 'Summary', status: 'active', version: 2, updatedAt: '2026-01-02' },
    ];
    const index = renderKnowledgeIndex(entries);
    expect(index.indexOf('Alpha')).toBeLessThan(index.indexOf('Zed'));
    expect(renderKnowledgeOverview('Wiki', entries)).toContain('Pages: 2');
    expect(renderKnowledgeLog({ jobId: 'job_1', generatedAt: '2026-01-01', pageCount: 2 })).toContain('job: job_1');
  });
});
