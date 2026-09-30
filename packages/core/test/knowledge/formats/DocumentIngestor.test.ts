import { describe, expect, it } from 'vitest';
import { DocumentIngestor, type DocumentAdapter } from '../../../src/knowledge/formats/DocumentIngestor.js';

describe('optional document ingestion', () => {
  it('returns an explicit unsupported result when no optional parser is installed', async () => {
    const result = await new DocumentIngestor().extract({
      path: 'report.pdf',
      content: 'binary placeholder',
      mimeType: 'application/pdf',
      metadata: { project: 'wiki' },
    });

    expect(result).toMatchObject({
      status: 'unsupported',
      format: 'pdf',
      metadata: { project: 'wiki' },
    });
  });

  it('preserves adapter metadata, provenance, and embedded media references', async () => {
    const adapter: DocumentAdapter = {
      format: 'docx',
      supports: () => true,
      extract: async (input) => ({
        text: input.content,
        normalizedText: input.content,
        metadata: { title: 'Design' },
        spans: [],
        headings: [],
        links: [],
        provenance: [{ kind: 'file', id: input.path ?? 'unknown', path: input.path }],
        mediaRefs: [{ kind: 'image', uri: 'media/diagram.png', mimeType: 'image/png' }],
      }),
    };

    const result = await new DocumentIngestor({ adapters: [adapter] }).extract({
      path: 'design.docx',
      content: 'Design text',
      metadata: { project: 'wiki' },
    });

    expect(result).toMatchObject({
      text: 'Design text',
      metadata: { project: 'wiki', title: 'Design' },
      mediaRefs: [{ uri: 'media/diagram.png' }],
    });
  });

  it('returns a typed failure for parser errors and size limits', async () => {
    const adapter: DocumentAdapter = {
      format: 'xlsx',
      supports: () => true,
      extract: async () => {
        throw new Error('parser unavailable');
      },
    };
    const ingestor = new DocumentIngestor({ adapters: [adapter], maxSizeBytes: 4 });

    await expect(
      ingestor.extract({ path: 'sheet.xlsx', content: 'large', metadata: { source: 'upload' } }),
    ).resolves.toMatchObject({
      status: 'failed',
      code: 'size_limit_exceeded',
      metadata: { source: 'upload' },
    });

    await expect(
      new DocumentIngestor({ adapters: [adapter] }).extract({
        path: 'sheet.xlsx',
        content: 'data',
        metadata: { source: 'upload' },
      }),
    ).resolves.toMatchObject({
      status: 'failed',
      code: 'parser_failed',
      error: 'parser unavailable',
    });
  });
});
